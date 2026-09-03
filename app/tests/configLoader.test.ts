import { afterEach, describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config/loader'
import { describeZipLimits, getConfigOption } from '../src/config/access'

/*
  A malformed configuration used to be logged and replaced with `{}`, so the
  process kept serving with every limit silently at its code default.
*/

afterEach(() => {
  delete process.env.CONFIG
  delete process.env.IPP_CONFIG
  delete process.env.IPP_ZIP_PLAN_CONCURRENCY
  loadConfig()
})

describe('loadConfig failure paths', () => {
  it('throws on malformed inline JSON instead of falling back to defaults', () => {
    process.env.CONFIG = '{ "ipp": { "maxDownloadZipBytes": 1 '
    expect(() => loadConfig()).toThrow(ConfigError)
    expect(() => loadConfig()).toThrow(/Malformed JSON in the CONFIG environment variable/)
  })

  it('throws when the configuration is not a JSON object', () => {
    process.env.CONFIG = '[1, 2]'
    expect(() => loadConfig()).toThrow(ConfigError)
    process.env.CONFIG = '"just a string"'
    expect(() => loadConfig()).toThrow(ConfigError)
  })

  it('throws when the configured file cannot be read', () => {
    process.env.IPP_CONFIG = '/nonexistent/ipp-config.json'
    expect(() => loadConfig()).toThrow(/Unable to read \/nonexistent\/ipp-config\.json/)
  })

  it('still loads a valid configuration', () => {
    process.env.CONFIG = JSON.stringify({ ipp: { maxDownloadZipBytes: 123 } })
    loadConfig()
    expect(getConfigOption('ipp.maxDownloadZipBytes')).toBe(123)
  })
})

describe('describeZipLimits', () => {
  it('reports which source supplied each numeric limit', () => {
    process.env.CONFIG = JSON.stringify({ ipp: { downloadZipPlanConcurrency: 4 } })
    loadConfig()
    expect(describeZipLimits()).toContain('downloadZipPlanConcurrency=4 (config)')
    expect(describeZipLimits()).toContain('downloadZipPlanMaxInFlight=2 (default)')

    process.env.IPP_ZIP_PLAN_CONCURRENCY = '6'
    expect(describeZipLimits()).toContain('downloadZipPlanConcurrency=6 (env IPP_ZIP_PLAN_CONCURRENCY)')
  })
})
