import crypto from 'crypto'
import { Writable } from 'stream'
import type { Response } from 'express-serve-static-core'
import type { Asset, SharedLink } from './types'
import { getNumericConfigOption } from './config/access'
import { downloadAssets, type DownloadProgress } from './stream/download'
import { log } from './utils/log'

export type ZipJobState =
  | 'queued'
  | 'preparing'
  | 'ready'
  | 'downloading'
  | 'complete'
  | 'failed'
  | 'cancelled'

export interface ZipJobStatus {
  id: string
  state: ZipJobState
  phase?: 'fetching' | 'finalizing'
  completedItems?: number
  totalItems?: number
  sizeBytes?: number
  message?: string
}

type ZipJob = {
  id: string
  scope: string
  visitorId: string
  signature: string
  share?: SharedLink
  assets?: Asset[]
  state: ZipJobState
  phase?: 'fetching' | 'finalizing'
  completedItems: number
  totalItems: number
  sizeBytes?: number
  message?: string
  createdAt: number
  lastSeenAt: number
  readyUntil?: number
  readyDeadline?: number
  terminalAt?: number
  leaveRequested?: boolean
}

/** Raised when the bounded in-memory waiting list has no free entry. */
export class ZipQueueFullError extends Error {
  constructor () {
    super('ZIP download queue is full')
    this.name = 'ZipQueueFullError'
  }
}

/** Raised when one browser session already owns a non-terminal ZIP job. */
export class ZipVisitorBusyError extends Error {
  constructor () {
    super('A ZIP download is already active for this visitor')
    this.name = 'ZipVisitorBusyError'
  }
}

const TERMINAL_RETENTION_MS = 5 * 60_000
const MAX_TERMINAL_JOBS = 64

/**
 * Minimal writable response used to prepare the immutable ZIP cache without
 * sending it to a visitor. The hardened download implementation emits no body
 * until the cache is complete. We therefore close on the first ZIP chunk: the
 * cache remains available and Content-Length has already been captured.
 */
class PreparationResponse extends Writable {
  statusCode = 200
  req = { headers: {} as Record<string, string> }
  private readonly headers = new Map<string, string>()
  private receivedFirstChunk = false

  constructor () {
    super()
    this.on('error', () => { /* mirrors http.ServerResponse error handling */ })
  }

  setHeader (name: string, value: string | number | readonly string[]) {
    this.headers.set(name.toLowerCase(), String(value))
    return this
  }

  getHeader (name: string) {
    return this.headers.get(name.toLowerCase())
  }

  removeHeader (name: string) {
    this.headers.delete(name.toLowerCase())
    return this
  }

  status (code: number) {
    this.statusCode = code
    return this
  }

  type (value: string) {
    this.setHeader('Content-Type', value)
    return this
  }

  send (value?: unknown) {
    this.end(value === undefined ? undefined : String(value))
    return this
  }

  _write (_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    callback()
    if (!this.receivedFirstChunk) {
      this.receivedFirstChunk = true
      setImmediate(() => this.destroy())
    }
  }
}

function assetSignature (assets: Asset[]): string {
  return assets.map(asset => asset.id).sort().join(',')
}

function safeMessageForStatus (status: number): string {
  if (status === 413) return 'This album is too large for a ZIP download.'
  if (status === 507) return 'ZIP download is temporarily unavailable because the storage reserve must be preserved.'
  return 'The ZIP could not be prepared. Please try again later.'
}

/**
 * One active ZIP lifecycle (prepare -> ready -> transfer) plus a small FIFO.
 * State is intentionally process-local: losing the queue during a restart is
 * safer and simpler than persisting visitor/job information. Immutable ZIP
 * files remain governed by the existing disk-cache TTL.
 */
export class ZipDownloadQueue {
  private readonly jobs = new Map<string, ZipJob>()
  private readonly waiting: string[] = []
  private activeId?: string
  private readonly sweepTimer: NodeJS.Timeout
  private readonly download: typeof downloadAssets

  constructor (download: typeof downloadAssets = downloadAssets) {
    this.download = download
    this.sweepTimer = setInterval(() => this.sweep(), 10_000)
    this.sweepTimer.unref()
  }

  enqueue (scope: string, visitorId: string, share: SharedLink, assets: Asset[]): ZipJobStatus {
    this.sweep()
    const signature = assetSignature(assets)
    const visitorJob = [...this.jobs.values()].find(job =>
      job.visitorId === visitorId && !this.isTerminal(job)
    )
    if (visitorJob) {
      if (visitorJob.scope === scope && visitorJob.signature === signature) {
        visitorJob.lastSeenAt = Date.now()
        return this.publicStatus(visitorJob)
      }
      throw new ZipVisitorBusyError()
    }

    const maxWaiting = Math.max(1, getNumericConfigOption('ipp.downloadZipQueueMaxWaiting', 3))
    if (this.activeId && this.waiting.length >= maxWaiting) throw new ZipQueueFullError()

    const now = Date.now()
    const job: ZipJob = {
      id: crypto.randomBytes(18).toString('base64url'),
      scope,
      visitorId,
      signature,
      share,
      assets,
      state: 'queued',
      completedItems: 0,
      totalItems: assets.length,
      createdAt: now,
      lastSeenAt: now
    }
    this.jobs.set(job.id, job)
    this.waiting.push(job.id)
    this.pump()
    return this.publicStatus(job)
  }

  get (scope: string, visitorId: string, id: string): ZipJobStatus | undefined {
    this.sweep()
    const job = this.authorizedJob(scope, visitorId, id)
    if (!job) return undefined
    job.lastSeenAt = Date.now()
    return this.publicStatus(job)
  }

  cancel (scope: string, visitorId: string, id: string): boolean {
    const job = this.authorizedJob(scope, visitorId, id)
    if (!job) return false
    job.lastSeenAt = Date.now()
    if (job.state === 'downloading') return false
    if (job.state === 'preparing') {
      // The cache build is bounded and useful even if the visitor leaves. Let
      // it finish, but release the slot as soon as preparation settles.
      job.leaveRequested = true
      return true
    }
    this.finish(job, 'cancelled')
    return true
  }

  async stream (
    scope: string,
    visitorId: string,
    id: string,
    res: Response,
    options: { head: boolean, range: boolean }
  ): Promise<'ok' | 'missing' | 'busy'> {
    const job = this.authorizedJob(scope, visitorId, id)
    if (!job) return 'missing'
    job.lastSeenAt = Date.now()
    if (this.activeId !== job.id || job.state !== 'ready') return 'busy'
    if (!job.share || !job.assets) return 'missing'

    job.state = 'downloading'
    try {
      await this.download(res, job.share, job.assets)

      // HEAD and Range requests may be followed by another request from Safari.
      // A disconnected full response also needs a short resume window. That
      // retry window is capped by the immutable deadline established when the
      // archive first became ready, so probes cannot monopolise the queue.
      const now = Date.now()
      const keepForRetry = options.head || options.range || !res.writableFinished
      if (keepForRetry) {
        if (job.readyDeadline !== undefined && now < job.readyDeadline) {
          job.state = 'ready'
          job.readyUntil = Math.min(now + 60_000, job.readyDeadline)
        } else {
          this.finish(job, 'cancelled')
        }
      } else {
        this.finish(job, 'complete')
      }
      return 'ok'
    } catch (error) {
      job.message = safeMessageForStatus(503)
      this.finish(job, 'failed')
      throw error
    }
  }

  private authorizedJob (scope: string, visitorId: string, id: string): ZipJob | undefined {
    const job = this.jobs.get(id)
    if (!job || job.scope !== scope || job.visitorId !== visitorId) return undefined
    return job
  }

  private publicStatus (job: ZipJob): ZipJobStatus {
    const result: ZipJobStatus = {
      id: job.id,
      state: job.state,
      completedItems: job.completedItems,
      totalItems: job.totalItems
    }
    if (job.phase) result.phase = job.phase
    if (job.sizeBytes !== undefined) result.sizeBytes = job.sizeBytes
    if (job.message) result.message = job.message
    return result
  }

  private pump () {
    if (this.activeId) return
    while (this.waiting.length > 0) {
      const id = this.waiting.shift()!
      const job = this.jobs.get(id)
      if (!job || job.state !== 'queued') continue
      this.activeId = id
      job.state = 'preparing'
      job.phase = 'fetching'
      this.prepare(job).catch(error => {
        log.error(`ZIP queue preparation failed: ${error instanceof Error ? error.message : String(error)}`)
        job.message = safeMessageForStatus(503)
        this.finish(job, 'failed')
      })
      return
    }
  }

  private async prepare (job: ZipJob) {
    if (!job.share || !job.assets) {
      this.finish(job, 'failed')
      return
    }
    const response = new PreparationResponse()
    const onProgress = (progress: DownloadProgress) => {
      job.phase = progress.phase
      job.completedItems = progress.completedItems
      job.totalItems = progress.totalItems
    }
    await this.download(response as unknown as Response, job.share, job.assets, onProgress)

    if (job.leaveRequested || job.state === 'cancelled') {
      job.state = 'cancelled'
      this.finish(job, 'cancelled')
      return
    }

    const size = Number(response.getHeader('content-length'))
    if (response.statusCode !== 200 || !Number.isSafeInteger(size) || size <= 0) {
      job.message = safeMessageForStatus(response.statusCode)
      this.finish(job, 'failed')
      return
    }

    job.completedItems = job.totalItems
    job.phase = 'finalizing'
    job.sizeBytes = size
    job.state = 'ready'
    const now = Date.now()
    const readyLeaseSeconds = Math.max(
      30,
      getNumericConfigOption('ipp.downloadZipReadyLeaseSeconds', 120)
    )
    const maxReadyLeaseSeconds = Math.max(
      readyLeaseSeconds,
      getNumericConfigOption('ipp.downloadZipMaxReadyLeaseSeconds', 300)
    )
    job.readyUntil = now + readyLeaseSeconds * 1000
    job.readyDeadline = now + maxReadyLeaseSeconds * 1000
  }

  private finish (job: ZipJob, state: Extract<ZipJobState, 'complete' | 'failed' | 'cancelled'>) {
    job.state = state
    if (this.activeId === job.id) this.activeId = undefined
    this.removeWaiting(job.id)
    // Terminal status remains briefly available to the browser, but discard
    // the potentially large share graph immediately and cap tombstones.
    job.share = undefined
    job.assets = undefined
    job.readyUntil = undefined
    job.readyDeadline = undefined
    job.terminalAt = Date.now()
    this.pruneTerminalJobs()
    queueMicrotask(() => this.pump())
  }

  private isTerminal (job: ZipJob) {
    return job.state === 'complete' || job.state === 'failed' || job.state === 'cancelled'
  }

  private pruneTerminalJobs () {
    const terminal = [...this.jobs.values()]
      .filter(job => this.isTerminal(job))
      .sort((left, right) => (left.terminalAt || 0) - (right.terminalAt || 0))
    while (terminal.length > MAX_TERMINAL_JOBS) {
      const oldest = terminal.shift()
      if (oldest) this.jobs.delete(oldest.id)
    }
  }

  private removeWaiting (id: string) {
    const index = this.waiting.indexOf(id)
    if (index >= 0) this.waiting.splice(index, 1)
  }

  private sweep () {
    const now = Date.now()
    const staleQueuedMs = Math.max(
      60,
      getNumericConfigOption('ipp.downloadZipQueueHeartbeatSeconds', 300)
    ) * 1000

    for (const job of this.jobs.values()) {
      if (job.state === 'queued' && now - job.lastSeenAt > staleQueuedMs) {
        this.finish(job, 'cancelled')
      }
      if (job.state === 'ready' && (
        (job.readyUntil !== undefined && now > job.readyUntil) ||
        (job.readyDeadline !== undefined && now > job.readyDeadline)
      )) {
        this.finish(job, 'cancelled')
      }
      if (this.isTerminal(job) && job.terminalAt !== undefined && now - job.terminalAt > TERMINAL_RETENTION_MS) {
        this.jobs.delete(job.id)
      }
    }
    this.pump()
  }
}

export const zipDownloadQueue = new ZipDownloadQueue()
