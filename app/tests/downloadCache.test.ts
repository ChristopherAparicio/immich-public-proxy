import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { Writable } from 'stream'
import type { Response } from 'express-serve-static-core'
import { AssetType, KeyType, type Asset, type SharedLink } from '../src/types'

const { TEST_TMP, config } = vi.hoisted(() => ({
  TEST_TMP: (process.env.TMPDIR || '/tmp') + '/ipp-download-cache-test-' + process.pid,
  config: {} as Record<string, number>
}))

vi.mock('os', async importOriginal => {
  const original = await importOriginal<typeof import('os')>()
  return { ...original, tmpdir: () => TEST_TMP }
})

vi.mock('../src/config/access', () => ({
  getConfigOption: (_key: string, fallback: unknown) => fallback,
  getNumericConfigOption: (key: string, fallback: number) => config[key] ?? fallback,
  getNumericEnvConfigOption: (environmentName: string, key: string, fallback: number) =>
    config[environmentName] ?? config[key] ?? fallback
}))

const { downloadAssets } = await import('../src/stream/download')

beforeAll(async () => fs.mkdir(TEST_TMP, { recursive: true }))

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const key of Object.keys(config)) delete config[key]
  const entries = await fs.readdir(TEST_TMP).catch(() => [] as string[])
  await Promise.all(entries.map(name => fs.rm(`${TEST_TMP}/${name}`, { recursive: true, force: true })))
})

afterAll(async () => fs.rm(TEST_TMP, { recursive: true, force: true }))

function asset (id: string): Asset {
  return {
    id,
    key: 'cache-test-key',
    keyType: KeyType.key,
    type: AssetType.image,
    isTrashed: false,
    originalFileName: `${id}.jpg`,
    originalMimeType: 'image/jpeg'
  }
}

function share (assets: Asset[]): SharedLink {
  return {
    key: 'cache-test-key',
    keyType: KeyType.key,
    type: 'ALBUM',
    description: 'Cache test',
    assets
  }
}

class FakeResponse extends Writable {
  statusCode = 200
  req: { headers: Record<string, string>, method: string }
  readonly headers = new Map<string, string>()
  readonly chunks: Buffer[] = []

  constructor (headers: Record<string, string> = {}, method = 'GET') {
    super()
    this.req = { headers, method }
    this.on('error', () => { /* mirrors ServerResponse */ })
  }

  setHeader (name: string, value: string | number | readonly string[]) {
    this.headers.set(name.toLowerCase(), String(value))
    return this
  }

  getHeader (name: string) { return this.headers.get(name.toLowerCase()) }
  removeHeader (name: string) { this.headers.delete(name.toLowerCase()); return this }
  status (code: number) { this.statusCode = code; return this }
  type (value: string) { this.setHeader('Content-Type', value); return this }
  send (value?: unknown) { this.end(value === undefined ? undefined : String(value)); return this }

  _write (chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(Buffer.from(chunk))
    callback()
  }

  body () { return Buffer.concat(this.chunks) }
}

function response (value: FakeResponse): Response { return value as unknown as Response }

describe('resumable ZIP cache', () => {
  it('serves an exact Content-Length and a byte-range retry from one immutable cache', async () => {
    config['ipp.maxDownloadZipBytes'] = 1024 * 1024
    config['ipp.minDownloadZipFreeBytes'] = 0
    const fetchMock = vi.fn(async () => new globalThis.Response(Buffer.alloc(128 * 1024, 0x61), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const assets = [asset('a1'), asset('a2')]

    const full = new FakeResponse()
    await downloadAssets(response(full), share(assets), assets)
    expect(full.statusCode).toBe(200)
    expect(full.body().subarray(0, 2).toString()).toBe('PK')
    expect(full.getHeader('content-length')).toBe(String(full.body().length))
    expect(full.getHeader('accept-ranges')).toBe('bytes')

    const ranged = new FakeResponse({ range: 'bytes=100-199' })
    await downloadAssets(response(ranged), share(assets), assets)
    expect(ranged.statusCode).toBe(206)
    expect(ranged.body()).toEqual(full.body().subarray(100, 200))
    expect(ranged.getHeader('content-range')).toBe(`bytes 100-199/${full.body().length}`)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns 413 and leaves no archive when aggregate source bytes exceed the ceiling', async () => {
    config['ipp.maxDownloadZipBytes'] = 1024
    config['ipp.minDownloadZipFreeBytes'] = 0
    vi.stubGlobal('fetch', vi.fn(async () => new globalThis.Response(Buffer.alloc(2048), { status: 200 })))
    const assets = [asset('too-large')]
    const result = new FakeResponse()

    await downloadAssets(response(result), share(assets), assets)

    expect(result.statusCode).toBe(413)
    expect(result.body().toString()).toContain('ZIP exceeds configured size limit')
    expect(await fs.readdir(TEST_TMP)).toEqual([])
  })

  it('preserves the configured disk budget before creating staging files', async () => {
    config['ipp.maxDownloadZipBytes'] = 100
    config['ipp.minDownloadZipFreeBytes'] = 0
    config.IPP_ZIP_DISK_BUDGET_PERCENT = 50
    vi.spyOn(fs, 'statfs').mockResolvedValue({ bavail: 300, bsize: 1 } as never)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const assets = [asset('budgeted')]
    const result = new FakeResponse()

    await downloadAssets(response(result), share(assets), assets)

    expect(result.statusCode).toBe(507)
    expect(result.body().toString()).toContain('Insufficient staging space')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await fs.readdir(TEST_TMP)).toEqual([])
  })
})
