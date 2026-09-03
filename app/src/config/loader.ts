import { readFileSync } from 'fs'
import { resolve } from 'path'
import { applyMigrations } from './migrations'

export type Config = Record<string, unknown>

/** A configuration source that cannot be trusted: unreadable or not a JSON object. */
export class ConfigError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

// Module-level cache populated by `loadConfig()`. Access through
// `getCurrentConfig()` rather than importing directly; that gives
// `config/access.ts` a stable read path even before `loadConfig()` has
// been called (returning an empty object so calls fall back to defaults).
let currentConfig: Config = {}

/**
 * Read the runtime configuration from `process.env.CONFIG` (an inline JSON
 * string, typically set in docker-compose) or from the config file. Applies
 * backward-compatibility migrations, caches the result, and returns it.
 *
 * Fails closed: a malformed or unreadable source throws `ConfigError` so the
 * process exits at startup instead of silently running on defaults that may
 * be looser than the operator intended (ZIP ceilings, queue bounds).
 *
 * Called once from `index.ts` at startup. Safe to call again in tests with
 * a fresh env to reset state.
 */
export function loadConfig (): Config {
  let config: Config
  if (process.env.CONFIG) {
    config = parseConfig(process.env.CONFIG, 'the CONFIG environment variable')
  } else {
    // Default config.json sits one level above the compiled dist/ output.
    // IPP_CONFIG (if set) is taken as-is for absolute paths, or resolved
    // against the current working directory for relative paths.
    const configPath = process.env.IPP_CONFIG
      ? resolve(process.env.IPP_CONFIG)
      : resolve(__dirname, '../../config.json')
    let raw: string
    try {
      raw = readFileSync(configPath, 'utf8')
    } catch (e) {
      throw new ConfigError(`Unable to read ${configPath}: ${e instanceof Error ? e.message : String(e)}`)
    }
    config = parseConfig(raw, configPath)
  }

  applyMigrations(config)
  currentConfig = config
  return config
}

function parseConfig (raw: string, source: string): Config {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new ConfigError(`Malformed JSON in ${source}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`${source} must contain a JSON object`)
  }
  return parsed as Config
}

/**
 * Return the most recently loaded config, or an empty object if
 * `loadConfig()` hasn't been called yet. Used by `getConfigOption`.
 */
export function getCurrentConfig (): Config {
  return currentConfig
}
