import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssetType, KeyType, type Asset, type SharedLink } from '../src/types'

/*
  ZIP planning probes Immich once per asset. The limiter must be shared by
  every concurrent plan, otherwise N plans issue N x concurrency requests.
*/

const { config } = vi.hoisted(() => ({ config: {} as Record<string, number> }))

vi.mock('../src/config/access', () => ({
  getConfigOption: (_key: string, fallback: unknown) => fallback,
  getNumericConfigOption: (key: string, fallback: number) => config[key] ?? fallback,
  getNumericEnvConfigOption: (environmentName: string, key: string, fallback: number) =>
    config[environmentName] ?? config[key] ?? fallback
}))

const { estimateDownloadAssets } = await import('../src/stream/download')

function asset (id: string): Asset {
  return {
    id,
    key: 'plan-key',
    keyType: KeyType.key,
    type: AssetType.image,
    isTrashed: false,
    originalFileName: `${id}.jpg`,
    originalMimeType: 'image/jpeg'
  }
}

const share: SharedLink = { key: 'plan-key', keyType: KeyType.key, type: 'ALBUM', assets: [] }

describe('estimateDownloadAssets', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    for (const key of Object.keys(config)) delete config[key]
  })

  it('caps upstream probes across concurrent plans with one process-wide limiter', async () => {
    config.IPP_ZIP_PLAN_CONCURRENCY = 2
    let active = 0
    let peak = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
      return new globalThis.Response('x', { status: 200, headers: { 'content-length': '1' } })
    }))
    const first = Array.from({ length: 6 }, (_, index) => asset(`a-${index}`))
    const second = Array.from({ length: 6 }, (_, index) => asset(`b-${index}`))

    const [one, two] = await Promise.all([
      estimateDownloadAssets(share, first),
      estimateDownloadAssets(share, second)
    ])

    expect(one).toHaveLength(6)
    expect(two).toHaveLength(6)
    expect(peak).toBeLessThanOrEqual(2)
  })
})
