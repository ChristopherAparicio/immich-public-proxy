import express from 'express'
import cookieSession from 'cookie-session'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { afterEach, describe, expect, it } from 'vitest'
import { configureTrustedProxy, sessionOptions } from '../src/session'

let server: Server | undefined

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()))
  server = undefined
})

async function requestSession (production: boolean, forwardedProto?: string): Promise<Response> {
  const app = express()
  configureTrustedProxy(app, production)
  app.use(cookieSession(sessionOptions('test-secret-at-least-32-characters', production)))
  app.get('/', (req, res) => {
    if (req.session) req.session.authenticated = true
    res.sendStatus(204)
  })
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server?.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  const headers = forwardedProto ? { 'x-forwarded-proto': forwardedProto } : undefined
  return await fetch(`http://127.0.0.1:${port}/`, { headers })
}

describe('browser session cookie', () => {
  it('sets Secure, HttpOnly and SameSite through the one-hop TLS proxy', async () => {
    const response = await requestSession(true, 'https')
    const cookies = response.headers.getSetCookie().join('; ')
    expect(cookies).toContain('session=')
    expect(cookies).toMatch(/; secure/i)
    expect(cookies).toMatch(/; httponly/i)
    expect(cookies).toMatch(/; samesite=lax/i)
  })

  it('does not emit the production session over an unencrypted request', async () => {
    const response = await requestSession(true)
    expect(response.headers.getSetCookie().filter(cookie => cookie.startsWith('session='))).toEqual([])
  })

  it('keeps local development usable without the Secure attribute', async () => {
    const response = await requestSession(false)
    const cookies = response.headers.getSetCookie().join('; ')
    expect(cookies).toContain('session=')
    expect(cookies).not.toMatch(/; secure/i)
  })
})
