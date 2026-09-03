import { afterEach, describe, expect, it, vi } from 'vitest'
import { Writable } from 'stream'
import { finished } from 'stream/promises'
import type { Response } from 'express-serve-static-core'
import { AssetType, KeyType, type Asset, type IncomingShareRequest } from '../src/types'

/*
  The single-asset route used to copy upstream chunks into `res.write()` while
  ignoring its return value: a slow reader made Node buffer the whole original
  in memory, and a vanished reader never cancelled the Immich fetch.
*/

vi.mock('../src/immich', async () => {
  const { ImageSize } = await import('../src/types')
  return {
    assetFetchUrl: () => 'http://immich.invalid/api/assets/asset/original?key=secret',
    authHeadersForAsset: async () => ({}),
    fetchAssetDetail: async () => undefined,
    validateImageSize: (size: unknown) =>
      Object.values(ImageSize).includes(size as typeof ImageSize[keyof typeof ImageSize]) ? size : ImageSize.preview
  }
})
vi.mock('../src/utils/log', () => ({
  log: Object.assign(vi.fn(), { info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

const { assetBuffer } = await import('../src/stream/asset')

const CHUNK = 64 * 1024
const TOTAL_CHUNKS = 64 // 4 MiB

const asset: Asset = {
  id: 'asset',
  key: 'share-key',
  keyType: KeyType.key,
  type: AssetType.image,
  isTrashed: false,
  originalFileName: 'photo.jpg',
  originalMimeType: 'image/jpeg'
}

function request (method = 'GET'): IncomingShareRequest {
  return { req: { method }, key: 'share-key', range: '' } as unknown as IncomingShareRequest
}

/** Writable whose `write()` returns false until `release()` lets chunks drain. */
class SlowResponse extends Writable {
  statusCode = 200
  received = 0
  private paused = true
  private readonly pending: Array<() => void> = []

  constructor () {
    super({ highWaterMark: CHUNK })
    this.on('error', () => { /* mirrors http.ServerResponse */ })
  }

  setHeader () { return this }
  status (code: number) { this.statusCode = code; return this }
  send () { this.end(); return this }

  _write (chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.received += chunk.length
    if (this.paused) this.pending.push(callback)
    else callback()
  }

  release () {
    this.paused = false
    for (const callback of this.pending.splice(0)) callback()
  }
}

type Upstream = { pulled: number, cancelled: boolean, signal?: AbortSignal }

function stubUpstream (chunks: number, closeAtEnd = true): Upstream {
  const upstream: Upstream = { pulled: 0, cancelled: false }
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    upstream.signal = init?.signal as AbortSignal
    const body = new ReadableStream<Uint8Array>({
      pull (controller) {
        upstream.pulled++
        if (upstream.pulled > chunks) {
          if (closeAtEnd) controller.close()
          return
        }
        controller.enqueue(new Uint8Array(CHUNK))
      },
      cancel () { upstream.cancelled = true }
    })
    return new globalThis.Response(body, {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': String(chunks * CHUNK) }
    })
  }))
  return upstream
}

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('assetBuffer streaming', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('pauses the upstream body while the client is not draining', async () => {
    const upstream = stubUpstream(TOTAL_CHUNKS)
    const res = new SlowResponse()
    const done = assetBuffer(request(), res as unknown as Response, asset, 'preview')
    await tick(50)

    expect(res.writableNeedDrain).toBe(true)
    expect(upstream.pulled).toBeLessThan(TOTAL_CHUNKS / 4)

    res.release()
    await done
    expect(res.received).toBe(TOTAL_CHUNKS * CHUNK)
    expect(res.writableFinished).toBe(true)
  })

  it('aborts the upstream fetch when the client connection closes early', async () => {
    const upstream = stubUpstream(TOTAL_CHUNKS, false)
    const res = new SlowResponse()
    const done = assetBuffer(request(), res as unknown as Response, asset, 'preview')
    await tick(30)
    expect(upstream.signal?.aborted).toBe(false)

    res.destroy()
    await expect(done).resolves.toBeUndefined()
    expect(upstream.signal?.aborted).toBe(true)
  })

  it('answers HEAD with headers only and cancels the upstream body', async () => {
    const upstream = stubUpstream(TOTAL_CHUNKS)
    const res = new SlowResponse()
    res.release()
    await assetBuffer(request('HEAD'), res as unknown as Response, asset, 'preview')
    expect(res.writableEnded).toBe(true)
    await finished(res)
    expect(res.received).toBe(0)
    expect(upstream.cancelled).toBe(true)
    expect(upstream.pulled).toBeLessThanOrEqual(1)
  })
})
