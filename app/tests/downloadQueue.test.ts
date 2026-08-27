import { Writable } from 'stream'
import type { Response } from 'express-serve-static-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AssetType, KeyType, type Asset, type SharedLink } from '../src/types'

let downloadCalls = 0
const downloadAssets = async (
  res: Response,
  _share: SharedLink,
  assets: Asset[],
  onProgress?: (progress: { phase: 'fetching' | 'finalizing', completedItems: number, totalItems: number }) => void
) => {
  downloadCalls++
  onProgress?.({ phase: 'fetching', completedItems: assets.length, totalItems: assets.length })
  onProgress?.({ phase: 'finalizing', completedItems: assets.length, totalItems: assets.length })
  res.statusCode = 200
  res.setHeader('Content-Length', '448737529')
  await new Promise<void>(resolve => res.end('PK', resolve))
}

vi.mock('../src/config/access', () => ({
  getNumericConfigOption: (_key: string, fallback: number) => fallback
}))
vi.mock('../src/utils/log', () => ({ log: Object.assign(vi.fn(), { error: vi.fn() }) }))

const { ZipDownloadQueue } = await import('../src/downloadQueue')

function asset (id: string): Asset {
  return {
    id,
    key: 'share-key',
    keyType: KeyType.key,
    type: AssetType.image,
    isTrashed: false,
    originalFileName: `${id}.jpg`,
    originalMimeType: 'image/jpeg'
  }
}

function share (id: string): SharedLink {
  return {
    key: id,
    keyType: KeyType.key,
    type: 'ALBUM',
    assets: [asset(`${id}-1`), asset(`${id}-2`)]
  }
}

class FakeResponse extends Writable {
  statusCode = 200
  req = { headers: {} }
  headers = new Map<string, string>()
  setHeader (name: string, value: string | number | readonly string[]) {
    this.headers.set(name.toLowerCase(), String(value))
    return this
  }
  _write (_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) { callback() }
}

async function settle () {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('ZipDownloadQueue', () => {
  beforeEach(() => { downloadCalls = 0 })

  it('keeps one lifecycle active and promotes waiting jobs in FIFO order', async () => {
    const queue = new ZipDownloadQueue(downloadAssets)
    const firstShare = share('first')
    const secondShare = share('second')
    const first = queue.enqueue('key:first', 'visitor-a', firstShare, firstShare.assets)
    await settle()
    expect(queue.get('key:first', 'visitor-a', first.id)?.state).toBe('ready')

    const second = queue.enqueue('key:second', 'visitor-b', secondShare, secondShare.assets)
    expect(queue.get('key:second', 'visitor-b', second.id)?.state).toBe('queued')

    const response = new FakeResponse()
    await queue.stream('key:first', 'visitor-a', first.id, response as unknown as Response, { head: false, range: false })
    await settle()
    expect(queue.get('key:first', 'visitor-a', first.id)?.state).toBe('complete')
    expect(queue.get('key:second', 'visitor-b', second.id)?.state).toBe('ready')
  })

  it('binds an opaque job to the visitor session', async () => {
    const queue = new ZipDownloadQueue(downloadAssets)
    const album = share('private')
    const job = queue.enqueue('key:private', 'visitor-a', album, album.assets)
    await settle()
    expect(queue.get('key:private', 'visitor-b', job.id)).toBeUndefined()
    expect(await queue.stream(
      'key:private',
      'visitor-b',
      job.id,
      new FakeResponse() as unknown as Response,
      { head: false, range: false }
    )).toBe('missing')
  })

  it('removes a queued visitor without interrupting the active preparation', async () => {
    const queue = new ZipDownloadQueue(downloadAssets)
    const firstShare = share('active')
    const waitingShare = share('waiting')
    const first = queue.enqueue('key:active', 'visitor-a', firstShare, firstShare.assets)
    await settle()
    const waiting = queue.enqueue('key:waiting', 'visitor-b', waitingShare, waitingShare.assets)
    expect(queue.cancel('key:waiting', 'visitor-b', waiting.id)).toBe(true)
    expect(queue.get('key:waiting', 'visitor-b', waiting.id)?.state).toBe('cancelled')
    expect(queue.get('key:active', 'visitor-a', first.id)?.state).toBe('ready')
  })
})
