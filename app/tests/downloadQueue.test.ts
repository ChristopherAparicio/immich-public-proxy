import { Writable } from 'stream'
import type { Response } from 'express-serve-static-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssetType, KeyType, type Asset, type SharedLink } from '../src/types'

const downloadAssets = async (
  res: Response,
  _share: SharedLink,
  assets: Asset[],
  onProgress?: (progress: { phase: 'fetching' | 'finalizing', completedItems: number, totalItems: number }) => void
) => {
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

const { ZipDownloadQueue, ZipVisitorBusyError } = await import('../src/downloadQueue')

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
  afterEach(() => vi.restoreAllMocks())

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

  it('does not disclose a queued visitor position', async () => {
    const queue = new ZipDownloadQueue(downloadAssets)
    const firstShare = share('active')
    queue.enqueue('key:active', 'visitor-a', firstShare, firstShare.assets)
    await settle()

    const waitingShare = share('waiting')
    const waiting = queue.enqueue('key:waiting', 'visitor-b', waitingShare, waitingShare.assets)
    expect(waiting.state).toBe('queued')
    expect(waiting).not.toHaveProperty('position')
  })

  it('allows only one non-terminal job per visitor', async () => {
    const queue = new ZipDownloadQueue(downloadAssets)
    const firstShare = share('first')
    queue.enqueue('key:first', 'visitor-a', firstShare, firstShare.assets)
    await settle()

    const secondShare = share('second')
    expect(() => queue.enqueue(
      'key:second',
      'visitor-a',
      secondShare,
      [secondShare.assets[0], asset('different-selection')]
    )).toThrow(ZipVisitorBusyError)
  })

  it('caps terminal jobs and drops retained share asset graphs', async () => {
    const queue = new ZipDownloadQueue(downloadAssets)
    const activeShare = share('active')
    queue.enqueue('key:active', 'visitor-active', activeShare, activeShare.assets)
    await settle()

    for (let index = 0; index < 100; index++) {
      const waitingShare = share(`waiting-${index}`)
      const waiting = queue.enqueue(`key:waiting-${index}`, `visitor-${index}`, waitingShare, waitingShare.assets)
      expect(queue.cancel(`key:waiting-${index}`, `visitor-${index}`, waiting.id)).toBe(true)
    }

    const jobs = (queue as unknown as { jobs: Map<string, { state: string, share?: SharedLink, assets?: Asset[] }> }).jobs
    expect(jobs.size).toBeLessThanOrEqual(65)
    for (const job of jobs.values()) {
      if (['complete', 'failed', 'cancelled'].includes(job.state)) {
        expect(job.share).toBeUndefined()
        expect(job.assets).toBeUndefined()
      }
    }
  })

  it('releases the active slot when streaming throws', async () => {
    let calls = 0
    const throwingDownload = async (
      res: Response,
      _share: SharedLink,
      assets: Asset[],
      onProgress?: (progress: { phase: 'fetching' | 'finalizing', completedItems: number, totalItems: number }) => void
    ) => {
      calls++
      if (calls === 2) throw new Error('simulated transfer failure')
      onProgress?.({ phase: 'finalizing', completedItems: assets.length, totalItems: assets.length })
      res.statusCode = 200
      res.setHeader('Content-Length', '1024')
      await new Promise<void>(resolve => res.end('PK', resolve))
    }
    const queue = new ZipDownloadQueue(throwingDownload)
    const firstShare = share('first')
    const first = queue.enqueue('key:first', 'visitor-a', firstShare, firstShare.assets)
    await settle()
    const secondShare = share('second')
    const second = queue.enqueue('key:second', 'visitor-b', secondShare, secondShare.assets)

    await expect(queue.stream(
      'key:first',
      'visitor-a',
      first.id,
      new FakeResponse() as unknown as Response,
      { head: false, range: false }
    )).rejects.toThrow('simulated transfer failure')
    await settle()

    expect(queue.get('key:first', 'visitor-a', first.id)?.state).toBe('failed')
    expect(queue.get('key:second', 'visitor-b', second.id)?.state).toBe('ready')
  })

  it('does not let HEAD or Range retries extend the absolute ready deadline', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const queue = new ZipDownloadQueue(downloadAssets)
    const firstShare = share('first')
    const first = queue.enqueue('key:first', 'visitor-a', firstShare, firstShare.assets)
    await settle()
    const secondShare = share('second')
    const second = queue.enqueue('key:second', 'visitor-b', secondShare, secondShare.assets)

    for (const seconds of [50, 100, 150, 200, 250, 299]) {
      now = 1_000_000 + seconds * 1000
      await queue.stream(
        'key:first',
        'visitor-a',
        first.id,
        new FakeResponse() as unknown as Response,
        { head: seconds !== 100, range: seconds === 100 }
      )
      expect(queue.get('key:second', 'visitor-b', second.id)?.state).toBe('queued')
    }

    now = 1_000_000 + 301_000
    expect(queue.get('key:first', 'visitor-a', first.id)?.state).toBe('cancelled')
    await settle()
    expect(queue.get('key:second', 'visitor-b', second.id)?.state).toBe('ready')
  })
})
