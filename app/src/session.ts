import type { Application } from 'express'
import { isKey } from './immich'

// Immich imposes no length on shared-link passwords; this is the proxy's own
// bound on what a browser may ask us to encrypt into the session cookie.
const MAX_SHARE_PASSWORD_LENGTH = 256
const MAX_SHARE_KEY_LENGTH = 128

/**
 * Validate the `/share/unlock` body before anything is written to the session.
 * The key must be a well-formed share key (it becomes a session property
 * name) and the password a bounded string. Returns undefined to reject.
 */
export function unlockRequest (body: unknown): { key: string, password: string } | undefined {
  if (!body || typeof body !== 'object') return undefined
  const { key, password } = body as Record<string, unknown>
  if (typeof key !== 'string' || key.length > MAX_SHARE_KEY_LENGTH || !isKey(key)) return undefined
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined
  if (typeof password !== 'string' || password.length > MAX_SHARE_PASSWORD_LENGTH) return undefined
  return { key, password }
}

/**
 * Install the signed browser session. Production IPP is reachable only through
 * the immediately adjacent Caddy container, so exactly one proxy hop is
 * trusted for the TLS scheme. The companion deployment publishes no IPP port.
 */
export function configureTrustedProxy (
  app: Application,
  production = process.env.NODE_ENV === 'production'
): void {
  if (production) app.set('trust proxy', 1)
}

export function sessionOptions (
  secret: string,
  production = process.env.NODE_ENV === 'production'
): CookieSessionInterfaces.CookieSessionOptions {
  return {
    name: 'session',
    httpOnly: true,
    sameSite: 'lax',
    secure: production,
    secret
  }
}
