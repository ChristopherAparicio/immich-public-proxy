import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import type { NextFunction, Request, Response } from 'express-serve-static-core'
import { ensureCsrfCookie, requireCsrf } from '../src/csrf'

type FakeResponse = {
  cookie: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
  json: ReturnType<typeof vi.fn>
}

function response (): FakeResponse {
  const res: FakeResponse = {
    cookie: vi.fn(),
    set: vi.fn(),
    status: vi.fn(),
    json: vi.fn()
  }
  res.set.mockReturnValue(res)
  res.status.mockReturnValue(res)
  res.json.mockReturnValue(res)
  return res
}

function request (cookie = '', header = '', fetchSite = 'same-origin'): Request {
  const headers: Record<string, string> = { cookie }
  if (header) headers['x-ipp-csrf-token'] = header
  if (fetchSite) headers['sec-fetch-site'] = fetchSite
  return {
    headers,
    get: (name: string) => headers[name.toLowerCase()]
  } as unknown as Request
}

function issuedToken (res: FakeResponse): string {
  return String(res.cookie.mock.calls[0]?.[1] || '')
}

describe('CSRF protection', () => {
  it('attaches the CSRF guard to every unsafe Express route', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const unsafeRoutes = source.split('\n').filter(line => /^app\.(post|put|patch|delete)\(/.test(line))
    expect(unsafeRoutes.length).toBeGreaterThan(0)
    for (const route of unsafeRoutes) expect(route).toContain('requireCsrf')
  })

  it('issues an HMAC-authenticated, host-only double-submit cookie', () => {
    const res = response()
    const next = vi.fn() as NextFunction
    ensureCsrfCookie(request(), res as unknown as Response, next)
    expect(next).toHaveBeenCalledOnce()
    expect(issuedToken(res)).toMatch(/^[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{43}$/)
    expect(res.cookie).toHaveBeenCalledWith('ipp-csrf', expect.any(String), expect.objectContaining({
      httpOnly: false,
      sameSite: 'strict',
      path: '/'
    }))
  })

  it('accepts a same-origin request only when cookie and header match', () => {
    const issuer = response()
    ensureCsrfCookie(request(), issuer as unknown as Response, vi.fn())
    const token = issuedToken(issuer)
    const next = vi.fn() as NextFunction
    const res = response()
    requireCsrf(request(`ipp-csrf=${token}`, token), res as unknown as Response, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('rejects missing, forged, and cross-site tokens', () => {
    const issuer = response()
    ensureCsrfCookie(request(), issuer as unknown as Response, vi.fn())
    const token = issuedToken(issuer)

    for (const req of [
      request(`ipp-csrf=${token}`),
      request('ipp-csrf=forged.value', 'forged.value'),
      request(`ipp-csrf=${token}`, token, 'cross-site')
    ]) {
      const next = vi.fn() as NextFunction
      const res = response()
      requireCsrf(req, res as unknown as Response, next)
      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(403)
    }
  })
})
