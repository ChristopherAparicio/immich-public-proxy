import { describe, expect, it } from 'vitest'
import { redactSensitiveLogText, urlPathForLog } from '../src/utils/redact'

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
})
