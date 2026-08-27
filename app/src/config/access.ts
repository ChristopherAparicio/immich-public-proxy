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
  const raw = process.env[environmentName]
  if (raw !== undefined && raw.trim() !== '') {
    const value = Number(raw)
    if (Number.isFinite(value)) return value
  }
  return getNumericConfigOption(path, defaultOption)
}
