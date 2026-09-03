import { describe, expect, it } from 'vitest'
import { describeError, redactSensitiveLogText, urlPathForLog } from '../src/utils/redact'

describe('log redaction', () => {
  it('removes share keys from every public route shape', () => {
    const key = 'sensitiveShareKey123'
    const message = [
      `/share/${key}/download/jobs/job-id`,
      `/s/${key}`,
      `/share/photo/${key}/asset-id/original`,
      `/share/video/${key}/asset-id`,
      `/share/meta/${key}/asset-id`
    ].join(' ')

    const redacted = redactSensitiveLogText(message)
    expect(redacted).not.toContain(key)
    expect(redacted).toContain('/share/[redacted]/download')
    expect(redacted).toContain('/share/photo/[redacted]/asset-id')
  })

  it('removes credential query values', () => {
    const redacted = redactSensitiveLogText('/api/assets/id/original?key=secret&token=other&safe=yes')
    expect(redacted).toBe('/api/assets/id/original?key=[redacted]&token=[redacted]&safe=yes')
  })

  it('keeps only the path of an upstream URL', () => {
    expect(urlPathForLog('http://immich/api/assets/id/original?key=secret')).toBe('/api/assets/id/original')
  })

  it('scrubs bare credential-shaped tokens but keeps job ids and asset UUIDs', () => {
    const shareKey = 'Qw3rTy_uI0pAsDfGhJkLzXcVbNm-1234567890QWERTYUIOPASDFGHJKLZXCVBNM01'
    const redacted = redactSensitiveLogText(
      `key ${shareKey} job abcdefghijklmnopqrstuvwx asset 123e4567-e89b-12d3-a456-426614174000`
    )
    expect(redacted).not.toContain(shareKey)
    expect(redacted).toBe('key [redacted] job abcdefghijklmnopqrstuvwx asset 123e4567-e89b-12d3-a456-426614174000')
  })

  it('describes an error including its redacted cause', () => {
    const cause = new Error('connect failed for /share/secretKey123/download?key=abc')
    const error = new Error('fetch failed', { cause })
    const described = describeError(error)
    expect(described).toContain('fetch failed')
    expect(described).toContain('caused by: connect failed for /share/[redacted]/download?key=[redacted]')
    expect(described).not.toContain('secretKey123')
    expect(describeError('plain /s/secretKey123')).toBe('plain /s/[redacted]')
  })
})
