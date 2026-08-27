import type { Application } from 'express'
import type { CookieSessionOptions } from 'cookie-session'

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
): CookieSessionOptions {
  return {
    name: 'session',
    httpOnly: true,
    sameSite: 'lax',
    secure: production,
    secret
  }
}
