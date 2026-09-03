import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { notFoundHandler } from '../src/http'

/*
  index.ts used to register the fallback with `app.get('*')`, so a `PUT /x`
  fell through to Express's default handler and its HTML "Cannot PUT" page.
*/

describe('notFoundHandler via app.all', () => {
  let server: Server
  let base: string

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const app = express()
    app.get('/ok', (_req, res) => { res.send('ok') })
    app.all('*', notFoundHandler)
    await new Promise<void>(resolve => { server = app.listen(0, resolve) })
    base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  })

  afterAll(() => {
    server?.close()
    vi.restoreAllMocks()
  })

  it('serves matched routes', async () => {
    const res = await fetch(base + '/ok')
    expect(res.status).toBe(200)
  })

  it.each(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])('answers %s on an unknown route with an empty 404', async method => {
    const res = await fetch(base + '/nope', { method })
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('')
    expect(res.headers.get('content-type') || '').not.toContain('html')
  })
})
