import { getCurrentConfig } from './loader'

/**
 * Read a configuration option using dotted notation. Returns `defaultOption`
 * when the path doesn't resolve to a value.
 *
 * @example
 *   getConfigOption('ipp.gallery.singleImage', false)
 */
export function getConfigOption (path: string, defaultOption?: unknown) {
  const value = path.split('.').reduce(
    (obj: { [key: string]: unknown }, key) => (obj || {})[key] as { [key: string]: unknown },
    getCurrentConfig() as { [key: string]: unknown }
  )
  if (value === undefined) {
    return defaultOption
  }
  return value
}

/**
 * Read a configuration option that must be a finite number. Non-numeric
 * values fall back to `defaultOption` instead of propagating `NaN`.
 */
export function getNumericConfigOption (path: string, defaultOption: number): number {
  const value = Number(getConfigOption(path, defaultOption))
  return Number.isFinite(value) ? value : defaultOption
}

/**
 * Read a numeric environment override before falling back to config.json.
 * Resource limits are deployment concerns, so operators can tune them without
 * rebuilding or mutating the read-only application configuration mount.
 */
export function getNumericEnvConfigOption (
  environmentName: string,
  path: string,
  defaultOption: number
): number {
  return resolveNumericOption(environmentName, path, defaultOption).value
}

export type NumericOptionSource = 'env' | 'config' | 'default'

/**
 * `getNumericEnvConfigOption` plus which source supplied the value, so the
 * boot log can show operators whether an env override or config.json won.
 */
export function resolveNumericOption (
  environmentName: string | undefined,
  path: string,
  defaultOption: number
): { value: number, source: NumericOptionSource } {
  const raw = environmentName ? process.env[environmentName] : undefined
  if (raw !== undefined && raw.trim() !== '') {
    const value = Number(raw)
    if (Number.isFinite(value)) return { value, source: 'env' }
  }
  const configured = getConfigOption(path)
  const value = Number(configured)
  if (configured !== undefined && Number.isFinite(value)) return { value, source: 'config' }
  return { value: defaultOption, source: 'default' }
}

/*
 * ZIP resource limits and their code defaults, mirrored here for the one-time
 * boot summary. Values are the configured inputs; call sites still clamp.
 */
const ZIP_LIMIT_OPTIONS: Array<{ path: string, env?: string, defaultValue: number }> = [
  { path: 'ipp.maxDownloadZipBytes', defaultValue: 2147483648 },
  { path: 'ipp.minDownloadZipFreeBytes', defaultValue: 5368709120 },
  { path: 'ipp.downloadZipCacheTtlSeconds', defaultValue: 1800 },
  { path: 'ipp.downloadFromImmichConcurrencyLimit', defaultValue: 20 },
  { path: 'ipp.downloadZipQueueMaxWaiting', defaultValue: 3 },
  { path: 'ipp.downloadZipQueueHeartbeatSeconds', defaultValue: 300 },
  { path: 'ipp.downloadZipQueuedPollSeconds', defaultValue: 30 },
  { path: 'ipp.downloadZipReadyLeaseSeconds', defaultValue: 120 },
  { path: 'ipp.downloadZipMaxReadyLeaseSeconds', defaultValue: 300 },
  { path: 'ipp.downloadZipDiskBudgetPercent', env: 'IPP_ZIP_DISK_BUDGET_PERCENT', defaultValue: 50 },
  { path: 'ipp.downloadZipSplitThresholdBytes', env: 'IPP_ZIP_SPLIT_THRESHOLD_BYTES', defaultValue: 1073741824 },
  { path: 'ipp.downloadZipPartTargetBytes', env: 'IPP_ZIP_PART_TARGET_BYTES', defaultValue: 536870912 },
  { path: 'ipp.downloadZipPlanConcurrency', env: 'IPP_ZIP_PLAN_CONCURRENCY', defaultValue: 12 },
  { path: 'ipp.downloadZipPlanMaxInFlight', env: 'IPP_ZIP_PLAN_MAX_IN_FLIGHT', defaultValue: 2 },
  { path: 'ipp.downloadZipPlanTtlSeconds', defaultValue: 3600 },
  { path: 'ipp.downloadZipPlanMaxAssets', defaultValue: 5000 },
  { path: 'ipp.downloadZipMaxParts', defaultValue: 64 },
  { path: 'ipp.downloadZipMaxParallelDownloads', env: 'IPP_ZIP_MAX_PARALLEL_DOWNLOADS', defaultValue: 2 }
]

/** One `name=value (source)` entry per ZIP limit, for the startup log. No secrets. */
export function describeZipLimits (): string[] {
  return ZIP_LIMIT_OPTIONS.map(option => {
    const resolved = resolveNumericOption(option.env, option.path, option.defaultValue)
    const source = resolved.source === 'env'
      ? 'env ' + option.env
      : resolved.source === 'config' ? 'config' : 'default'
    return `${option.path.replace(/^ipp\./, '')}=${resolved.value} (${source})`
  })
}
