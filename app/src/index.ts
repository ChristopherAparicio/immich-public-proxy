#!/usr/bin/env node

import 'dotenv/config'
import express from 'express'
import cookieSession from 'cookie-session'
import {
  accessible,
  enforceMinimumImmichVersion,
  fetchAssetDetail,
  getKeyTypeFromShare,
  getShareByKey,
  handleShareRequest,
  isId,
  isKey
} from './immich'
import { buildAssetMetadata } from './gallery/metadata'
import crypto from 'crypto'
import { assetBuffer } from './stream/asset'
import { downloadAssets, sweepStaleStagingDirs } from './stream/download'
import {
  zipDownloadQueue,
  ZipPlanUnavailableError,
  ZipQueueFullError,
  ZipVisitorBusyError
} from './downloadQueue'
import dayjs from 'dayjs'
import { NextFunction, Request, Response } from 'express-serve-static-core'
import { Asset, AssetType, ImageSize, KeyType, SharedLink } from './types'
import { getConfigOption } from './config/access'
import { loadConfig } from './config/loader'
import { addResponseHeaders, asyncHandler, errorHandler } from './http'
import { canDownload } from './share'
import { toString } from './utils/text'
import { decrypt, encrypt } from './encrypt'
import { respondToInvalidRequest } from './invalidRequestHandler'
import { ASSET_VERSION } from './version'
import { h } from 'preact'
import { renderPage } from './view/render'
import { Home } from './view/home'
import { ensureCsrfCookie, requireCsrf } from './csrf'
import { configureTrustedProxy, sessionOptions } from './session'

// Extend the Request type with a `password` property
declare module 'express-serve-static-core' {
  interface Request {
    password?: string;
  }
}

// Read config.json (or the inline CONFIG env var) and apply backward-compat
// migrations. Must run before any code that calls getConfigOption.
loadConfig()

const app = express()
const inProduction = process.env.NODE_ENV === 'production'
configureTrustedProxy(app, inProduction)
app.use(cookieSession(sessionOptions(
  crypto.randomBytes(32).toString('base64url'),
  inProduction
)))
// Keep this ordering explicit for security review: the browser integrity token
// is installed immediately after the signed session and before every route.
app.use(ensureCsrfCookie)
// For parsing the password unlock form and POSTed JSON payloads
app.use(express.json())
// For parsing the selective-download form POST (form-encoded body)
app.use(express.urlencoded({ extended: false, limit: '1mb' }))
// Cache-busted, immutable static assets under a per-release version segment.
app.use('/share/static/' + ASSET_VERSION, express.static('public', {
  immutable: inProduction,
  maxAge: inProduction ? '365d' : 0,
  setHeaders: addResponseHeaders
}))
// Serve static assets from the 'public' folder as /share/static
app.use('/share/static', express.static('public', { setHeaders: addResponseHeaders }))
// Serve the same assets on /, to allow for /robots.txt and /favicon.ico
app.use(express.static('public', { setHeaders: addResponseHeaders }))
// Remove the X-Powered-By ExpressJS header
app.disable('x-powered-by')

/**
 * Middleware to decode the encrypted data stored in the session cookie
 */
const decodeCookie = (req: Request, _res: Response, next: NextFunction) => {
  const shareKey = req.params.key
  const session = req.session?.[shareKey]
  if (shareKey && session?.iv && session?.cr) {
    try {
      const payload = JSON.parse(decrypt({
        iv: toString(session.iv),
        cr: toString(session.cr)
      }))
      if (payload?.expires && dayjs(payload.expires) > dayjs()) {
        req.password = payload.password
      }
    } catch (e) { }
  }
  next()
}

/*
 * Shared route guards. Several routes need the same "resolve a share, reject
 * invalid / password-protected ones, optionally find the requested asset"
 * preamble. These return a discriminated result so each route keeps control of
 * its own response (e.g. the photo route redirects on password where the meta
 * and download routes return 401), while the validation order and the
 * `valid`/`link`/`passwordRequired` checks live in one place.
 */
type ShareResolution =
  | { ok: true, link: SharedLink }
  | { ok: false, status: number, reason: string, passwordRequired?: boolean }

type SharedAssetResolution =
  | { ok: true, link: SharedLink, asset: Asset }
  | { ok: false, status: number, reason: string, passwordRequired?: boolean }

async function resolveShare (req: Request, keyType: KeyType): Promise<ShareResolution> {
  if (!isKey(req.params.key)) {
    return { ok: false, status: 404, reason: 'Invalid key for ' + req.path }
  }
  // The password is provided from the encrypted session cookie (if set) by
  // decodeCookie. Validating the share here prevents direct URL access from
  // bypassing password protection.
  const share = await getShareByKey(req.params.key, req.password, keyType)
  if (!share?.valid || !share.link) {
    return { ok: false, status: 404, reason: 'Invalid share link' }
  }
  if (share.passwordRequired) {
    return { ok: false, status: 401, reason: 'Password required', passwordRequired: true }
  }
  return { ok: true, link: share.link }
}

async function resolveSharedAsset (req: Request, keyType: KeyType): Promise<SharedAssetResolution> {
  if (!isId(req.params.id)) {
    return { ok: false, status: 404, reason: 'Invalid ID for ' + req.path }
  }
  const resolved = await resolveShare(req, keyType)
  if (!resolved.ok) return resolved
  // Confirm the asset belongs to this share (defence in depth - Immich also
  // enforces this via the share key).
  const asset = resolved.link.assets.find(a => a.id === req.params.id)
  if (!asset) {
    return { ok: false, status: 404, reason: 'Asset not found in share' }
  }
  return { ok: true, link: resolved.link, asset }
}

/*
 * [ROUTE] Healthcheck
 * The path matches for /share/healthcheck, and also the legacy /healthcheck
 */
app.get(/^(|\/share)\/healthcheck$/, asyncHandler(async (_req, res) => {
  if (await accessible()) {
    res.send('ok')
  } else {
    res.status(503).send()
  }
}))

/*
 * ZIP preparation queue. A random visitor id is kept inside the encrypted,
 * signed cookie-session payload so a job cannot be observed or downloaded by
 * another browser even if its opaque id is disclosed.
 */
function zipVisitorId (req: Request): string {
  const existing = String(req.session?.zipVisitorId || '')
  if (/^[A-Za-z0-9_-]{20,64}$/.test(existing)) return existing
  const id = crypto.randomBytes(18).toString('base64url')
  if (req.session) req.session.zipVisitorId = id
  return id
}

function zipScope (req: Request, keyType: KeyType): string {
  return keyType + ':' + req.params.key
}

function validZipJobId (value: string): boolean {
  return /^[A-Za-z0-9_-]{24}$/.test(value)
}

function selectedZipAssets (req: Request, share: SharedLink): Asset[] | null {
  if (req.body?.assets === undefined) return share.assets
  if (!Array.isArray(req.body.assets) || req.body.assets.length < 2) return null
  const ids = new Set(req.body.assets.map(String))
  if (ids.size !== req.body.assets.length) return null
  const selected = share.assets.filter(asset => ids.has(asset.id))
  return selected.length === ids.size ? selected : null
}

app.post('/:shareType(share|s)/:key/download/plan', requireCsrf, decodeCookie, asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  const keyType = getKeyTypeFromShare(req.params.shareType)
  const resolved = await resolveShare(req, keyType)
  if (!resolved.ok || !canDownload(resolved.link)) {
    res.status(404).json({ message: 'ZIP planning unavailable.' })
    return
  }
  try {
    const plan = await zipDownloadQueue.plan(
      zipScope(req, keyType),
      zipVisitorId(req),
      resolved.link,
      resolved.link.assets
    )
    res.json(plan)
  } catch (error) {
    if (error instanceof ZipPlanUnavailableError) {
      res.status(413).json({ message: error.message })
      return
    }
    if (error instanceof ZipVisitorBusyError) {
      res.set('Retry-After', '30')
      res.status(429).json({ message: 'A ZIP request is already active in this browser.' })
      return
    }
    throw error
  }
}))

app.post('/:shareType(share|s)/:key/download/prepare', requireCsrf, decodeCookie, asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  const keyType = getKeyTypeFromShare(req.params.shareType)
  const resolved = await resolveShare(req, keyType)
  if (!resolved.ok || !canDownload(resolved.link)) {
    res.status(404).json({ state: 'failed', message: 'ZIP request unavailable.' })
    return
  }
  try {
    const scope = zipScope(req, keyType)
    const visitorId = zipVisitorId(req)
    let status
    if (req.body?.planId !== undefined || req.body?.part !== undefined) {
      const planId = String(req.body?.planId || '')
      const part = Number(req.body?.part)
      if (!validZipJobId(planId) || !Number.isSafeInteger(part) || part < 1) {
        res.status(400).json({ state: 'failed', message: 'Invalid ZIP part request.' })
        return
      }
      status = zipDownloadQueue.enqueuePart(scope, visitorId, planId, part)
      if (!status) {
        res.status(404).json({ state: 'failed', message: 'ZIP plan expired. Please plan the download again.' })
        return
      }
    } else {
      const assets = selectedZipAssets(req, resolved.link)
      if (!assets) {
        res.status(400).json({ state: 'failed', message: 'Invalid asset selection.' })
        return
      }
      status = zipDownloadQueue.enqueue(scope, visitorId, resolved.link, assets)
    }
    res.status(202).json(status)
  } catch (error) {
    if (error instanceof ZipQueueFullError) {
      res.set('Retry-After', '30')
      res.status(429).json({ state: 'failed', message: 'The download queue is full. Please try again later.' })
      return
    }
    if (error instanceof ZipVisitorBusyError) {
      res.set('Retry-After', '30')
      res.status(429).json({ state: 'failed', message: 'A ZIP request is already active in this browser.' })
      return
    }
    throw error
  }
}))

app.get('/:shareType(share|s)/:key/download/jobs/:jobId', decodeCookie, asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  if (!validZipJobId(req.params.jobId)) {
    res.status(404).json({ state: 'cancelled' })
    return
  }
  const keyType = getKeyTypeFromShare(req.params.shareType)
  const resolved = await resolveShare(req, keyType)
  if (!resolved.ok || !canDownload(resolved.link)) {
    res.status(404).json({ state: 'cancelled' })
    return
  }
  const status = zipDownloadQueue.get(zipScope(req, keyType), zipVisitorId(req), req.params.jobId)
  if (!status) {
    res.status(404).json({ state: 'cancelled' })
    return
  }
  res.json(status)
}))

app.delete('/:shareType(share|s)/:key/download/jobs/:jobId', requireCsrf, decodeCookie, asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  if (!validZipJobId(req.params.jobId)) {
    res.status(404).send()
    return
  }
  const keyType = getKeyTypeFromShare(req.params.shareType)
  const resolved = await resolveShare(req, keyType)
  if (!resolved.ok || !canDownload(resolved.link)) {
    res.status(404).send()
    return
  }
  const cancelled = zipDownloadQueue.cancel(zipScope(req, keyType), zipVisitorId(req), req.params.jobId)
  res.status(cancelled ? 204 : 409).send()
}))

app.get('/:shareType(share|s)/:key/download/jobs/:jobId/file', decodeCookie, asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  if (!validZipJobId(req.params.jobId)) {
    res.status(404).send()
    return
  }
  const keyType = getKeyTypeFromShare(req.params.shareType)
  const resolved = await resolveShare(req, keyType)
  if (!resolved.ok || !canDownload(resolved.link)) {
    res.status(404).send()
    return
  }
  const outcome = await zipDownloadQueue.stream(
    zipScope(req, keyType),
    zipVisitorId(req),
    req.params.jobId,
    res,
    { head: req.method === 'HEAD', range: !!req.headers.range }
  )
  if (outcome === 'missing') res.status(404).send()
  if (outcome === 'busy') {
    res.set('Retry-After', '30')
    res.status(429).send('ZIP download is not ready')
  }
}))

/*
 * [ROUTE] This is the main URL that someone would visit if they are opening a shared link
 */
app.get('/:shareType(share|s)/:key/:mode(download)?', decodeCookie, asyncHandler(async (req, res) => {
  const keyType = getKeyTypeFromShare(req.params.shareType)

  if (req.params.mode === 'download' && !getConfigOption('ipp.allowLegacyDirectZipDownload', false)) {
    res.status(409).type('text/plain').send('Direct ZIP downloads are disabled; use the gallery download queue')
  } else if (keyType === KeyType.slug && !getConfigOption('ipp.allowSlugLinks', true)) {
    // Slug type links are not allowed
    respondToInvalidRequest(res, 404, 'Slug links are disabled in config.json')
  } else {
    await handleShareRequest({
      req,
      key: req.params.key,
      keyType,
      mode: req.params.mode,
      password: req.password
    }, res)
  }
}))

/*
 * [ROUTE] Receive an unlock request from the password page
 * Stores a cookie with an encrypted payload which expires in 1 hour.
 * After that time, the visitor will need to provide the password again.
 *
 * The data is encrypted/decrypted on the server as a db-less way of
 * managing user session data. The data is provided to the server by the
 * user's browser in its encrypted state.
 */
app.post('/share/unlock', requireCsrf, asyncHandler(async (req, res) => {
  if (req.session && req.body.key) {
    req.session[req.body.key] = encrypt(JSON.stringify({
      password: req.body.password,
      expires: dayjs().add(1, 'hour').format()
    }))
  }
  res.send()
}))

/*
 * [ROUTE] Selective download - POST a list of asset IDs, get a zip of just those.
 * The list arrives as a single "assets" form field containing a JSON array.
 * Validates each ID against share.assets so the request can't pull anything
 * outside the share.
 */
app.post('/:shareType(share|s)/:key/download', requireCsrf, decodeCookie, asyncHandler(async (req, res) => {
  if (!getConfigOption('ipp.allowLegacyDirectZipDownload', false)) {
    res.status(409).type('text/plain').send('Direct ZIP downloads are disabled; use the gallery download queue')
    return
  }
  const keyType = getKeyTypeFromShare(req.params.shareType)
  let requestedIds: unknown
  try {
    requestedIds = JSON.parse(String(req.body?.assets ?? '[]'))
  } catch (e) {
    respondToInvalidRequest(res, 400, 'Malformed assets list')
    return
  }
  if (!Array.isArray(requestedIds) || requestedIds.length === 0) {
    respondToInvalidRequest(res, 400, 'No assets selected')
    return
  }

  const resolved = await resolveShare(req, keyType)
  if (!resolved.ok) {
    respondToInvalidRequest(res, resolved.status, resolved.reason)
    return
  }
  if (!canDownload(resolved.link)) {
    respondToInvalidRequest(res, 403, 'Downloads disabled for this share')
    return
  }

  const requested = new Set(requestedIds.map(String))
  const validAssets = resolved.link.assets.filter(a => requested.has(a.id))
  if (validAssets.length === 0) {
    respondToInvalidRequest(res, 400, 'No valid assets in selection')
    return
  }

  await downloadAssets(res, resolved.link, validAssets)
}))

/*
 * [ROUTE] Catch accidental POST requests to share URLs (e.g. from browser history
 * state issues) and force a clean GET redirect.
 * See https://github.com/alangrainger/immich-public-proxy/pull/205
 */
app.post('/:shareType(share|s)/:key/:mode(download)?', requireCsrf, (req, res) => {
  const prefix = req.params.shareType === 's' ? '/s/' : '/share/'
  const suffix = req.params.mode === 'download' ? '/download' : ''
  res.redirect(303, prefix + encodeURIComponent(req.params.key) + suffix)
})

/*
 * [ROUTE] This is the direct link to a photo or video asset
 */
app.get('/share/:type(photo|video)/:key/:id/:size?', decodeCookie, asyncHandler(async (req, res) => {
  // Add the headers configured in config.json (most likely `cache-control`)
  addResponseHeaders(res)

  // Validate the size parameter
  if (req.params.size && !Object.values(ImageSize).includes(req.params.size as ImageSize)) {
    respondToInvalidRequest(res, 404, 'Invalid size parameter ' + req.path)
    return
  }

  // Resolve the share + asset (this is a `/share/...` route, always key auth).
  // The resolved asset gives assetBuffer access to originalMimeType and
  // originalFileName (needed for Content-Disposition and for requiresOriginal
  // to recognise videos/animated images and bypass the preview downgrade).
  const resolved = await resolveSharedAsset(req, KeyType.key)
  if (!resolved.ok) {
    // Password-protected: redirect to the share page so the visitor gets the
    // unlock prompt, rather than returning an error.
    if (resolved.passwordRequired) {
      res.redirect('/share/' + req.params.key)
      return
    }
    respondToInvalidRequest(res, resolved.status, resolved.reason)
    return
  }
  const asset: Asset = {
    ...resolved.asset,
    type: req.params.type === 'video' ? AssetType.video : resolved.asset.type
  }

  const request = {
    req,
    key: req.params.key,
    range: req.headers.range || ''
  }
  await assetBuffer(request, res, asset, req.params.size, resolved.link, req.params.type === 'video')
}))

/*
 * [ROUTE] On-demand per-asset metadata for lazy album items.
 *
 * Album shares enumerate their assets from the timeline API, which yields
 * grid-only data (no exif / filename / description). When such an item opens
 * in the lightbox, the client fetches its detail from here. The id is
 * validated against the share's asset set (defence in depth - Immich also
 * enforces this via the share key) before we fetch `GET /assets/:id`.
 */
app.get('/:shareType(share|s)/meta/:key/:id', decodeCookie, asyncHandler(async (req, res) => {
  addResponseHeaders(res)

  const resolved = await resolveSharedAsset(req, getKeyTypeFromShare(req.params.shareType))
  if (!resolved.ok) {
    respondToInvalidRequest(res, resolved.status, resolved.reason)
    return
  }

  const detail = await fetchAssetDetail(resolved.asset)
  if (!detail) {
    respondToInvalidRequest(res, 404, 'Asset detail unavailable for ' + req.params.id)
    return
  }

  res.json(buildAssetMetadata(detail, resolved.link))
}))

/*
 * [ROUTE] Home page
 *
 * It was requested here to have *something* on the home page:
 * https://github.com/alangrainger/immich-public-proxy/discussions/19
 *
 * If you don't want to see this, set showHomePage as false in your config.json:
 * https://github.com/alangrainger/immich-public-proxy?tab=readme-ov-file#immich-public-proxy-options
 */
if (getConfigOption('ipp.showHomePage', true)) {
  app.get(/^\/(|share)\/*$/, (_req, res) => {
    addResponseHeaders(res)
    res.send(renderPage(h(Home, {})))
  })
}

/*
 * Send a 404 for all other routes
 */
app.get('*', (req, res) => {
  respondToInvalidRequest(res, 404, 'Invalid route ' + req.path)
})

/*
 * Terminal error middleware: any throw/rejection inside a route (routed here
 * by asyncHandler) is logged and answered per the 404 privacy policy, instead
 * of escaping to process level.
 */
app.use(errorHandler)

// Send the correct process error code for any uncaught exceptions
// so that Docker can gracefully restart the container
process.on('uncaughtException', (err) => {
  console.error('There was an uncaught error', err)
  server.close()
  process.exit(1)
})
// Log-only: with asyncHandler routing request errors into errorHandler, a
// stray rejection from a background task (version check, staging-dir sweep,
// etc.) is not worth killing every in-flight request for.
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
})
process.on('SIGTERM', () => {
  console.log('Received SIGTERM. Gracefully shutting down...')
  server.close()
  process.exit(0)
})

// Start the ExpressJS server
const port = Number(process.env.IPP_PORT) || 3000
const server = app.listen(port, () => {
  console.log(dayjs().format() + ' Server started on port ' + port)
  // Bail out early if the Immich server is older than IPP supports, rather
  // than silently serving broken album shares. Unknown/unreachable is
  // tolerated (logs a warning and continues) - see enforceMinimumImmichVersion.
  enforceMinimumImmichVersion().catch(e => console.error('Immich version check failed:', e))
  // Clean up any zip-download staging dirs left behind by a previous
  // run that crashed before its finally block could run
  sweepStaleStagingDirs().catch(e => console.error('sweepStaleStagingDirs failed:', e))
})
