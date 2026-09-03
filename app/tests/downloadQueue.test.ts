import { Writable } from 'stream'
import type { Response } from 'express-serve-static-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssetType, KeyType, type Asset, type SharedLink } from '../src/types'

const { numericConfig } = vi.hoisted(() => ({
  numericConfig: { IPP_ZIP_MAX_PARALLEL_DOWNLOADS: 1 } as Record<string, number>
}))

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
  getNumericConfigOption: (key: string, fallback: number) => numericConfig[key] ?? fallback,
  getNumericEnvConfigOption: (environmentName: string, key: string, fallback: number) =>
    numericConfig[environmentName] ?? numericConfig[key] ?? fallback
}))
vi.mock('../src/utils/log', () => ({ log: Object.assign(vi.fn(), { error: vi.fn() }) }))

const { ZipDownloadQueue, ZipPlanBusyError, ZipPlanUnavailableError, ZipVisitorBusyError } = await import('../src/downloadQueue')

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

function estimator (sizes: Record<string, number>) {
  return async (_share: SharedLink, assets: Asset[]) => assets.map(asset => ({
    asset,
    sizeBytes: sizes[asset.id]
  }))
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
  afterEach(() => {
    vi.restoreAllMocks()
    for (const key of Object.keys(numericConfig)) delete numericConfig[key]
    numericConfig.IPP_ZIP_MAX_PARALLEL_DOWNLOADS = 1
  })

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

    let previousSeconds = 0
    for (const seconds of [50, 100, 150, 200, 250, 299]) {
      // A waiting browser polls every 2 s; one poll between probes is enough
      // to stay inside the queued poll window.
      now = 1_000_000 + Math.floor((previousSeconds + seconds) / 2) * 1000
      queue.get('key:second', 'visitor-b', second.id)
      now = 1_000_000 + seconds * 1000
      previousSeconds = seconds
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

  it('keeps a small album in one automatically downloadable part', async () => {
    numericConfig.IPP_ZIP_SPLIT_THRESHOLD_BYTES = 20
    numericConfig.IPP_ZIP_PART_TARGET_BYTES = 8
    const album = share('small')
    const queue = new ZipDownloadQueue(downloadAssets, estimator({
      'small-1': 5,
      'small-2': 6
    }))

    const plan = await queue.plan('key:small', 'visitor-a', album, album.assets)

    expect(plan.requiresSplit).toBe(false)
    expect(plan.totalBytes).toBe(11)
    expect(plan.parts).toEqual([{ index: 1, assetCount: 2, sizeBytes: 11 }])
  })

  it('reuses a visitor plan instead of repeating upstream size work', async () => {
    const album = share('reuse')
    const estimate = vi.fn(estimator({ 'reuse-1': 5, 'reuse-2': 6 }))
    const queue = new ZipDownloadQueue(downloadAssets, estimate)

    const first = await queue.plan('key:reuse', 'visitor-a', album, album.assets)
    const second = await queue.plan('key:reuse', 'visitor-a', album, [...album.assets].reverse())

    expect(second.id).toBe(first.id)
    expect(estimate).toHaveBeenCalledTimes(1)
  })

  it('builds deterministic contiguous parts independent of Immich response order', async () => {
    numericConfig.IPP_ZIP_SPLIT_THRESHOLD_BYTES = 8
    numericConfig.IPP_ZIP_PART_TARGET_BYTES = 8
    const assets = [asset('c'), asset('a'), asset('b')]
    const album = share('split')
    album.assets = assets
    const queue = new ZipDownloadQueue(downloadAssets, estimator({ a: 4, b: 4, c: 4 }))

    const first = await queue.plan('key:split', 'visitor-a', album, assets)
    const second = await queue.plan('key:split', 'visitor-a', album, [...assets].reverse())

    expect(first.requiresSplit).toBe(true)
    expect(first.parts).toEqual([
      { index: 1, assetCount: 2, sizeBytes: 8 },
      { index: 2, assetCount: 1, sizeBytes: 4 }
    ])
    expect(second.parts).toEqual(first.parts)
    const internal = (queue as unknown as {
      plans: Map<string, { assetParts: Array<Array<{ asset: Asset }>> }>
    }).plans.get(second.id)
    expect(internal?.assetParts.map(part => part.map(item => item.asset.id))).toEqual([['a', 'b'], ['c']])
  })

  it('binds an opaque plan to its share while jobs stay bound to the requesting visitor', async () => {
    numericConfig.IPP_ZIP_SPLIT_THRESHOLD_BYTES = 1
    numericConfig.IPP_ZIP_PART_TARGET_BYTES = 8
    const album = share('bound')
    const queue = new ZipDownloadQueue(downloadAssets, estimator({
      'bound-1': 4,
      'bound-2': 4
    }))
    const plan = await queue.plan('key:bound', 'visitor-a', album, album.assets)

    expect(plan.id).toMatch(/^[A-Za-z0-9_-]{24}$/)
    expect(queue.enqueuePart('key:other', 'visitor-a', plan.id, 1)).toBeUndefined()
    expect(queue.enqueuePart('key:bound', 'visitor-a', plan.id, 3)).toBeUndefined()
    const job = queue.enqueuePart('key:bound', 'visitor-b', plan.id, 1)!
    expect(job.partIndex).toBe(1)
    expect(queue.get('key:bound', 'visitor-b', job.id)?.id).toBe(job.id)
    expect(queue.get('key:bound', 'visitor-a', job.id)).toBeUndefined()
  })

  it('reuses a non-expired plan across visitors without repeating upstream size work', async () => {
    const album = share('shared')
    const estimate = vi.fn(estimator({ 'shared-1': 5, 'shared-2': 6 }))
    const queue = new ZipDownloadQueue(downloadAssets, estimate)

    const first = await queue.plan('key:shared', 'visitor-a', album, album.assets)
    const second = await queue.plan('key:shared', 'visitor-b', album, [...album.assets].reverse())

    expect(second).toEqual(first)
    expect(estimate).toHaveBeenCalledTimes(1)
  })

  it('bounds in-flight planning process-wide and coalesces duplicate albums', async () => {
    numericConfig.IPP_ZIP_PLAN_MAX_IN_FLIGHT = 1
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const estimate = vi.fn(async (_share: SharedLink, assets: Asset[]) => {
      await gate
      return assets.map(asset => ({ asset, sizeBytes: 4 }))
    })
    const queue = new ZipDownloadQueue(downloadAssets, estimate)
    const albumA = share('a')
    const albumB = share('b')

    const first = queue.plan('key:a', 'visitor-1', albumA, albumA.assets)
    await expect(queue.plan('key:b', 'visitor-2', albumB, albumB.assets)).rejects.toBeInstanceOf(ZipPlanBusyError)
    const coalesced = queue.plan('key:a', 'visitor-3', albumA, albumA.assets)
    release()
    const [planA, planC] = await Promise.all([first, coalesced])

    expect(planC.id).toBe(planA.id)
    expect(estimate).toHaveBeenCalledTimes(1)
    await expect(queue.plan('key:b', 'visitor-2', albumB, albumB.assets)).resolves.toMatchObject({ totalBytes: 8 })
  })

  it('drops a queued job whose browser stops polling within the poll window', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const queue = new ZipDownloadQueue(downloadAssets)
    const activeShare = share('active')
    const polledShare = share('polled')
    const silentShare = share('silent')
    const active = queue.enqueue('key:active', 'visitor-a', activeShare, activeShare.assets)
    await settle()
    const polled = queue.enqueue('key:polled', 'visitor-b', polledShare, polledShare.assets)
    const silent = queue.enqueue('key:silent', 'visitor-c', silentShare, silentShare.assets)
    expect(polled.state).toBe('queued')
    expect(silent.state).toBe('queued')

    now += 20_000
    expect(queue.get('key:polled', 'visitor-b', polled.id)?.state).toBe('queued')
    now += 20_000
    expect(queue.get('key:active', 'visitor-a', active.id)?.state).toBe('ready')
    expect(queue.get('key:silent', 'visitor-c', silent.id)?.state).toBe('cancelled')
    expect(queue.get('key:polled', 'visitor-b', polled.id)?.state).toBe('queued')
  })

  it('rejects a plan when one asset exceeds the hard ZIP ceiling', async () => {
    numericConfig['ipp.maxDownloadZipBytes'] = 10
    const album = share('oversize')
    const queue = new ZipDownloadQueue(downloadAssets, estimator({
      'oversize-1': 11,
      'oversize-2': 1
    }))

    await expect(queue.plan('key:oversize', 'visitor-a', album, album.assets))
      .rejects.toBeInstanceOf(ZipPlanUnavailableError)
  })

  it('rejects oversized asset graphs before issuing upstream size requests', async () => {
    numericConfig['ipp.downloadZipPlanMaxAssets'] = 1
    const album = share('too-many')
    const estimate = vi.fn(estimator({ 'too-many-1': 1, 'too-many-2': 1 }))
    const queue = new ZipDownloadQueue(downloadAssets, estimate)

    await expect(queue.plan('key:too-many', 'visitor-a', album, album.assets))
      .rejects.toBeInstanceOf(ZipPlanUnavailableError)
    expect(estimate).not.toHaveBeenCalled()
  })

  it('prepares at most one archive while retaining three ready download slots', async () => {
    numericConfig.IPP_ZIP_MAX_PARALLEL_DOWNLOADS = 3
    let concurrentPreparations = 0
    let maxConcurrentPreparations = 0
    const observedDownload = async (
      res: Response,
      _share: SharedLink,
      assets: Asset[],
      onProgress?: (progress: { phase: 'fetching' | 'finalizing', completedItems: number, totalItems: number }) => void
    ) => {
      concurrentPreparations++
      maxConcurrentPreparations = Math.max(maxConcurrentPreparations, concurrentPreparations)
      await new Promise(resolve => setTimeout(resolve, 5))
      onProgress?.({ phase: 'finalizing', completedItems: assets.length, totalItems: assets.length })
      res.statusCode = 200
      res.setHeader('Content-Length', '1024')
      concurrentPreparations--
      await new Promise<void>(resolve => res.end('PK', resolve))
    }
    const queue = new ZipDownloadQueue(observedDownload)
    const jobs = ['one', 'two', 'three', 'four'].map((name, index) => {
      const album = share(name)
      return queue.enqueue(`key:${name}`, `visitor-${index}`, album, album.assets)
    })
    await new Promise(resolve => setTimeout(resolve, 40))

    expect(maxConcurrentPreparations).toBe(1)
    expect(jobs.slice(0, 3).map((job, index) => queue.get(`key:${['one', 'two', 'three'][index]}`, `visitor-${index}`, job.id)?.state))
      .toEqual(['ready', 'ready', 'ready'])
    expect(queue.get('key:four', 'visitor-3', jobs[3].id)?.state).toBe('queued')
  })

  it('gives an already queued visitor the slot before a multipart visitor requests its next part', async () => {
    numericConfig.IPP_ZIP_SPLIT_THRESHOLD_BYTES = 1
    numericConfig.IPP_ZIP_PART_TARGET_BYTES = 4
    const firstAlbum = share('first-plan')
    const secondAlbum = share('second-plan')
    const sizes = {
      'first-plan-1': 4,
      'first-plan-2': 4,
      'second-plan-1': 4,
      'second-plan-2': 4
    }
    const queue = new ZipDownloadQueue(downloadAssets, estimator(sizes))
    const firstPlan = await queue.plan('key:first-plan', 'visitor-a', firstAlbum, firstAlbum.assets)
    const secondPlan = await queue.plan('key:second-plan', 'visitor-b', secondAlbum, secondAlbum.assets)
    const firstPart = queue.enqueuePart('key:first-plan', 'visitor-a', firstPlan.id, 1)!
    await settle()
    const waitingVisitor = queue.enqueuePart('key:second-plan', 'visitor-b', secondPlan.id, 1)!
    expect(waitingVisitor.state).toBe('queued')

    await queue.stream(
      'key:first-plan',
      'visitor-a',
      firstPart.id,
      new FakeResponse() as unknown as Response,
      { head: false, range: false }
    )
    const nextPart = queue.enqueuePart('key:first-plan', 'visitor-a', firstPlan.id, 2)!
    await settle()

    expect(queue.get('key:second-plan', 'visitor-b', waitingVisitor.id)?.state).toBe('ready')
    expect(queue.get('key:first-plan', 'visitor-a', nextPart.id)?.state).toBe('queued')
  })
})
