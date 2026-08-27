import crypto from 'crypto'
import type { NextFunction, Request, Response } from 'express-serve-static-core'

const CSRF_COOKIE = 'ipp-csrf'
const CSRF_HEADER = 'x-ipp-csrf-token'
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{43}$/
const tokenSecret = crypto.randomBytes(32)

function cookieValue (req: Request, name: string): string {
  const raw = req.headers.cookie || ''
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return ''
    }
  }
  return ''
}

function signature (nonce: string): string {
  return crypto.createHmac('sha256', tokenSecret).update(nonce).digest('base64url')
}

function safeEqual (left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function validToken (token: string): boolean {
  if (!TOKEN_PATTERN.test(token)) return false
  const [nonce, mac] = token.split('.')
  return safeEqual(mac, signature(nonce))
}

function newToken (): string {
  const nonce = crypto.randomBytes(24).toString('base64url')
  return `${nonce}.${signature(nonce)}`
}

function setTokenCookie (res: Response): void {
  res.cookie(CSRF_COOKIE, newToken(), {
    httpOnly: false,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 8 * 60 * 60 * 1000
  })
}

/**
 * Issue a host-only, HMAC-authenticated double-submit token. The token is kept
 * outside the HTML so public gallery caching cannot mix visitor sessions.
 */
export function ensureCsrfCookie (req: Request, res: Response, next: NextFunction): void {
  if (!validToken(cookieValue(req, CSRF_COOKIE))) setTokenCookie(res)
  next()
}

/**
 * Protect state-changing browser routes. HMAC authentication prevents a
 * sibling subdomain from manufacturing a valid double-submit cookie, while
 * Fetch Metadata rejects cross-site requests before token comparison.
 */
export function requireCsrf (req: Request, res: Response, next: NextFunction): void {
  const fetchSite = req.get('sec-fetch-site') || ''
  const cookieToken = cookieValue(req, CSRF_COOKIE)
  const headerToken = req.get(CSRF_HEADER) || ''
  const sameOriginContext = !fetchSite || fetchSite === 'same-origin' || fetchSite === 'none'

  if (sameOriginContext && validToken(cookieToken) && safeEqual(cookieToken, headerToken)) {
    next()
    return
  }

  if (!validToken(cookieToken)) setTokenCookie(res)
  res.set('Cache-Control', 'private, no-store')
  res.status(403).json({ message: 'Request validation failed. Reload the page and try again.' })
}
