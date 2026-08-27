import dayjs from 'dayjs'
import { redactSensitiveLogText } from './redact'

/**
 * Output a timestamped log message. Calling `log(...)` is equivalent to
 * `log.info(...)` and stays available for existing call sites.
 *
 *   log.info('...')   informational, goes to stdout
 *   log.warn('...')   non-fatal anomaly, goes to stderr with WARN prefix
 *   log.error('...')  failure / unexpected error, goes to stderr with ERROR prefix
 */
const timestamp = () => dayjs().format()

type LogFn = ((message: string) => void) & {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

const safe = (message: string) => redactSensitiveLogText(message)

const logImpl: LogFn = ((message: string) => console.log(timestamp() + ' ' + safe(message))) as LogFn
logImpl.info = (message: string) => console.log(timestamp() + ' ' + safe(message))
logImpl.warn = (message: string) => console.warn(timestamp() + ' WARN ' + safe(message))
logImpl.error = (message: string) => console.error(timestamp() + ' ERROR ' + safe(message))

export const log = logImpl
