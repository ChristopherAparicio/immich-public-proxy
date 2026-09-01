import { describe, expect, it } from 'vitest'
import { h } from 'preact'
import { readFileSync } from 'fs'
import { renderPage } from '../src/view/render'
import { Password } from '../src/view/password'
import { readPasswordFragment } from '../src/shared/passwordFragment'

describe('password URL fragment', () => {
  it('decodes one bounded password without accepting duplicates or controls', () => {
    expect(readPasswordFragment('#ipp-password=correct.horse%26battery%3D123')).toEqual({
      present: true,
      password: 'correct.horse&battery=123'
    })
    expect(readPasswordFragment('#asset-id')).toEqual({ present: false })
    expect(readPasswordFragment('#ipp-password=short')).toEqual({ present: true })
    expect(readPasswordFragment('#ipp-password=valid.password.123&ipp-password=second.password.456')).toEqual({ present: true })
    expect(readPasswordFragment('#ipp-password=valid.password.123%0A')).toEqual({ present: true })
  })

  it('serves an external client module and a no-referrer policy', () => {
    const html = renderPage(h(Password, {
      shareKey: 'safe_share_key_123',
      notifyInvalidPassword: false
    }))

    expect(html).toContain('name="referrer" content="no-referrer"')
    expect(html).toMatch(/\/share\/static\/[^/]+\/js\/client\/password\.js/)
    expect(html).not.toContain('ipp-password=')
  })

  it('clears the fragment before submitting the password', () => {
    const source = readFileSync(new URL('../src/client/password.ts', import.meta.url), 'utf8')
    const clear = source.indexOf('window.history.replaceState')
    const submit = source.indexOf('submitForm(form, fragment.password)')

    expect(clear).toBeGreaterThan(-1)
    expect(submit).toBeGreaterThan(clear)
    expect(source).toContain("fetch('/share/unlock'")
    expect(source).not.toContain('window.location.href')
  })
})
