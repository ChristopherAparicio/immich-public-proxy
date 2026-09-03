import { describe, it, expect } from 'vitest'
import { filenameFromContentDisposition } from '../src/stream/download'
import { contentDisposition } from '../src/utils/sanitize'

// Used by the zip download path to recover the real filename for album grid
// assets (which arrive without originalFileName) from the /original response.

describe('filenameFromContentDisposition', () => {
  it('prefers the RFC 5987 filename* form and percent-decodes it', () => {
    const header = "attachment; filename=\"IMG.jpg\"; filename*=UTF-8''Photo%20%C3%A9t%C3%A9.jpg"
    expect(filenameFromContentDisposition(header)).toBe('Photo été.jpg')
  })

  it('falls back to the plain quoted filename', () => {
    expect(filenameFromContentDisposition('attachment; filename="IMG_1234.HEIC"')).toBe('IMG_1234.HEIC')
  })

  it('handles an unquoted plain filename', () => {
    expect(filenameFromContentDisposition('attachment; filename=clip.mp4')).toBe('clip.mp4')
  })

  it('returns undefined when no filename is present', () => {
    expect(filenameFromContentDisposition('attachment')).toBeUndefined()
    expect(filenameFromContentDisposition(null)).toBeUndefined()
  })
})

describe('contentDisposition', () => {
  it('cannot be split by a parameter separator inside the filename', () => {
    expect(contentDisposition('Trip; filename=evil.exe.zip')).toBe(
      'attachment; filename="Trip; filename=evil.exe.zip"; filename*=UTF-8\'\'Trip%3B%20filename%3Devil.exe.zip'
    )
  })

  it('percent-encodes apostrophes and non-ASCII and keeps an ASCII fallback', () => {
    expect(contentDisposition("O'Brien été.jpg")).toBe(
      'attachment; filename="O\'Brien _t_.jpg"; filename*=UTF-8\'\'O%27Brien%20%C3%A9t%C3%A9.jpg'
    )
  })

  it('neutralises quotes, backslashes and control characters', () => {
    const header = contentDisposition('a"b\\c\r\nd.zip')
    expect(header).toContain('filename="a_b_c__d.zip"')
    expect(header).toContain("filename*=UTF-8''a%22b%5Cc%0D%0Ad.zip")
  })

  it('round-trips through the parser used for upstream headers', () => {
    expect(filenameFromContentDisposition(contentDisposition("Trip; été's & co.zip"))).toBe("Trip; été's & co.zip")
  })
})
