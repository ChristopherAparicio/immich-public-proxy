import cookieSession from 'cookie-session'
import type { Application } from 'express'

/**
 * Install the signed browser session. Production IPP is reachable only through
 * the immediately adjacent Caddy container, so exactly one proxy hop is
 * trusted for the TLS scheme. The companion deployment publishes no IPP port.
 */
export function installSession (
  app: Application,
  secret: string,
  production = process.env.NODE_ENV === 'production'
): void {
  if (production) app.set('trust proxy', 1)
  app.use(cookieSession({
    name: 'session',
    httpOnly: true,
    sameSite: 'lax',
    secure: production,
    secret
  }))
}
