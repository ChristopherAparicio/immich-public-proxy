import { h } from 'preact'
import { renderToString } from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import { SourceOffer, sourceCodeUrl } from '../src/view/sourceOffer'

describe('AGPL source offer', () => {
  it('links interactive users to the exact release source', () => {
    expect(sourceCodeUrl()).toContain('/tree/v3.2.1-immich-share.5')
    const html = renderToString(h(SourceOffer, {}))
    expect(html).toContain('Source code for this service (AGPL-3.0)')
    expect(html).toContain('rel="license"')
  })
})
