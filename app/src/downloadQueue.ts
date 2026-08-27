import crypto from 'crypto'
import { Writable } from 'stream'
import type { Response } from 'express-serve-static-core'
import type { Asset, SharedLink } from './types'
import { getNumericConfigOption, getNumericEnvConfigOption } from './config/access'
import {
  downloadAssets,
  estimateDownloadAssets,
  type DownloadOptions,
  type DownloadProgress,
  type EstimatedDownloadAsset
} from './stream/download'
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
  partIndex?: number
  partCount?: number
}

export interface ZipPlanPartStatus {
  index: number
  assetCount: number
  sizeBytes: number
}

export interface ZipPlanStatus {
  id: string
  totalItems: number
  totalBytes: number
  requiresSplit: boolean
  parts: ZipPlanPartStatus[]
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
  maxBytes?: number
  part?: { index: number, total: number }
}

type ZipPlan = ZipPlanStatus & {
  scope: string
  visitorId: string
  signature: string
  share: SharedLink
  assetParts: EstimatedDownloadAsset[][]
  expiresAt: number
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

export class ZipPlanUnavailableError extends Error {
  constructor (message = 'This album cannot be divided into safe ZIP parts') {
    super(message)
    this.name = 'ZipPlanUnavailableError'
  }
}

const TERMINAL_RETENTION_MS = 5 * 60_000
const MAX_TERMINAL_JOBS = 64
const MAX_PLANS = 32
const MAX_PLANNED_ASSET_REFS = 20_000

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
  private readonly plans = new Map<string, ZipPlan>()
  private readonly waiting: string[] = []
  private preparingId?: string
  private readonly sweepTimer: NodeJS.Timeout
  private readonly download: typeof downloadAssets
  private readonly estimate: typeof estimateDownloadAssets

  constructor (
    download: typeof downloadAssets = downloadAssets,
    estimate: typeof estimateDownloadAssets = estimateDownloadAssets
  ) {
    this.download = download
    this.estimate = estimate
    this.sweepTimer = setInterval(() => this.sweep(), 10_000)
    this.sweepTimer.unref()
  }

  async plan (
    scope: string,
    visitorId: string,
    share: SharedLink,
    assets: Asset[]
  ): Promise<ZipPlanStatus> {
    this.sweep()
    const signature = assetSignature(assets)
    const existingPlan = [...this.plans.values()].find(plan =>
      plan.scope === scope &&
      plan.visitorId === visitorId &&
      plan.signature === signature &&
      plan.expiresAt > Date.now()
    )
    if (existingPlan) return this.publicPlan(existingPlan)
    if ([...this.jobs.values()].some(job => job.visitorId === visitorId && !this.isTerminal(job))) {
      throw new ZipVisitorBusyError()
    }
    const maxPlanAssets = Math.max(1, Math.min(20_000, Math.floor(getNumericConfigOption(
      'ipp.downloadZipPlanMaxAssets',
      5000
    ))))
    if (assets.length < 1 || assets.length > maxPlanAssets || new Set(assets.map(asset => asset.id)).size !== assets.length) {
      throw new ZipPlanUnavailableError('This album has too many or invalid assets for safe ZIP planning.')
    }
    const estimated = await this.estimate(share, assets)
    if (estimated.length !== assets.length || estimated.some(item =>
      !assets.includes(item.asset) || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes <= 0
    )) {
      throw new ZipPlanUnavailableError()
    }
    const hardMaxBytes = Math.max(1, Math.floor(getNumericConfigOption(
      'ipp.maxDownloadZipBytes',
      2147483648
    )))
    const splitThresholdBytes = Math.max(1, Math.min(hardMaxBytes, Math.floor(getNumericEnvConfigOption(
      'IPP_ZIP_SPLIT_THRESHOLD_BYTES',
      'ipp.downloadZipSplitThresholdBytes',
      1073741824
    ))))
    const targetPartBytes = Math.max(1, Math.min(hardMaxBytes, Math.floor(getNumericEnvConfigOption(
      'IPP_ZIP_PART_TARGET_BYTES',
      'ipp.downloadZipPartTargetBytes',
      536870912
    ))))
    const maxParts = Math.max(1, Math.min(256, Math.floor(getNumericConfigOption(
      'ipp.downloadZipMaxParts',
      64
    ))))
    const ordered = [...estimated].sort((left, right) => {
      const byDate = String(left.asset.fileCreatedAt || '').localeCompare(String(right.asset.fileCreatedAt || ''))
      return byDate || left.asset.id.localeCompare(right.asset.id)
    })
    if (ordered.some(item => item.sizeBytes > hardMaxBytes)) {
      throw new ZipPlanUnavailableError('An individual asset exceeds the hard ZIP ceiling and must be downloaded separately.')
    }
    const totalBytes = ordered.reduce((sum, item) => sum + item.sizeBytes, 0)
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
      throw new ZipPlanUnavailableError()
    }

    const assetParts: EstimatedDownloadAsset[][] = []
    if (totalBytes <= splitThresholdBytes) {
      assetParts.push(ordered)
    } else {
      let current: EstimatedDownloadAsset[] = []
      let currentBytes = 0
      for (const item of ordered) {
        if (current.length > 0 && currentBytes + item.sizeBytes > targetPartBytes) {
          assetParts.push(current)
          current = []
          currentBytes = 0
        }
        current.push(item)
        currentBytes += item.sizeBytes
      }
      if (current.length > 0) assetParts.push(current)
    }
    if (assetParts.length > maxParts) {
      throw new ZipPlanUnavailableError('This album would require too many ZIP parts.')
    }

    // One current plan per visitor and share prevents cheap repeated planning
    // from retaining multiple copies of a large asset graph.
    for (const [id, plan] of this.plans) {
      if (plan.scope === scope && plan.visitorId === visitorId) this.plans.delete(id)
    }
    const id = crypto.randomBytes(18).toString('base64url')
    const parts = assetParts.map((part, index) => ({
      index: index + 1,
      assetCount: part.length,
      sizeBytes: part.reduce((sum, item) => sum + item.sizeBytes, 0)
    }))
    const plan: ZipPlan = {
      id,
      scope,
      visitorId,
      signature,
      share,
      assetParts,
      totalItems: ordered.length,
      totalBytes,
      requiresSplit: assetParts.length > 1,
      parts,
      expiresAt: Date.now() + Math.max(300, getNumericConfigOption(
        'ipp.downloadZipPlanTtlSeconds',
        3600
      )) * 1000
    }
    this.plans.set(id, plan)
    this.prunePlans()
    return this.publicPlan(plan)
  }

  enqueuePart (
    scope: string,
    visitorId: string,
    planId: string,
    partIndex: number
  ): ZipJobStatus | undefined {
    this.sweep()
    const plan = this.plans.get(planId)
    if (!plan || plan.scope !== scope || plan.visitorId !== visitorId || plan.expiresAt <= Date.now()) {
      return undefined
    }
    const estimated = plan.assetParts[partIndex - 1]
    const publicPart = plan.parts[partIndex - 1]
    if (!estimated || !publicPart) return undefined
    const part = { index: partIndex, total: plan.assetParts.length }
    return this.enqueue(scope, visitorId, plan.share, estimated.map(item => item.asset), {
      maxBytes: publicPart.sizeBytes,
      part
    })
  }

  enqueue (
    scope: string,
    visitorId: string,
    share: SharedLink,
    assets: Asset[],
    downloadOptions: DownloadOptions = {}
  ): ZipJobStatus {
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
    const hasActiveWork = [...this.jobs.values()].some(job => !this.isTerminal(job))
    if (hasActiveWork && this.waiting.length >= maxWaiting) throw new ZipQueueFullError()

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
      lastSeenAt: now,
      maxBytes: downloadOptions.maxBytes,
      part: downloadOptions.part
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
    if (job.state !== 'ready') return 'busy'
    if (!job.share || !job.assets) return 'missing'
    const maxParallelDownloads = this.maxParallelDownloads()
    const activeDownloads = [...this.jobs.values()].filter(candidate => candidate.state === 'downloading').length
    if (activeDownloads >= maxParallelDownloads) return 'busy'

    job.state = 'downloading'
    try {
      await this.download(res, job.share, job.assets, undefined, {
        maxBytes: job.maxBytes,
        part: job.part
      })

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
    if (job.part) {
      result.partIndex = job.part.index
      result.partCount = job.part.total
    }
    return result
  }

  private publicPlan (plan: ZipPlan): ZipPlanStatus {
    return {
      id: plan.id,
      totalItems: plan.totalItems,
      totalBytes: plan.totalBytes,
      requiresSplit: plan.requiresSplit,
      parts: plan.parts.map(part => ({ ...part }))
    }
  }

  private maxParallelDownloads () {
    return Math.max(1, Math.min(8, Math.floor(getNumericEnvConfigOption(
      'IPP_ZIP_MAX_PARALLEL_DOWNLOADS',
      'ipp.downloadZipMaxParallelDownloads',
      2
    ))))
  }

  private pump () {
    if (this.preparingId) return
    const retainedSlots = [...this.jobs.values()].filter(job => job.state === 'ready' || job.state === 'downloading').length
    if (retainedSlots >= this.maxParallelDownloads()) return
    while (this.waiting.length > 0) {
      const id = this.waiting.shift()!
      const job = this.jobs.get(id)
      if (!job || job.state !== 'queued') continue
      this.preparingId = id
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
    await this.download(response as unknown as Response, job.share, job.assets, onProgress, {
      maxBytes: job.maxBytes,
      part: job.part
    })

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
    if (this.preparingId === job.id) this.preparingId = undefined
    queueMicrotask(() => this.pump())
  }

  private finish (job: ZipJob, state: Extract<ZipJobState, 'complete' | 'failed' | 'cancelled'>) {
    job.state = state
    if (this.preparingId === job.id) this.preparingId = undefined
    this.removeWaiting(job.id)
    // Terminal status remains briefly available to the browser, but discard
    // the potentially large share graph immediately and cap tombstones.
    job.share = undefined
    job.assets = undefined
    job.readyUntil = undefined
    job.readyDeadline = undefined
    job.maxBytes = undefined
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

  private prunePlans () {
    const now = Date.now()
    for (const [id, plan] of this.plans) {
      if (plan.expiresAt <= now) this.plans.delete(id)
    }
    while (this.plans.size > MAX_PLANS) {
      const oldest = this.plans.keys().next().value as string | undefined
      if (!oldest) break
      this.plans.delete(oldest)
    }
    let retainedAssetRefs = [...this.plans.values()].reduce((sum, plan) => sum + plan.totalItems, 0)
    while (retainedAssetRefs > MAX_PLANNED_ASSET_REFS) {
      const oldest = this.plans.keys().next().value as string | undefined
      if (!oldest) break
      const plan = this.plans.get(oldest)
      this.plans.delete(oldest)
      retainedAssetRefs -= plan?.totalItems || 0
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
    this.prunePlans()
    this.pump()
  }
}

export const zipDownloadQueue = new ZipDownloadQueue()
