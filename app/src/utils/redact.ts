/**
 * Remove credential-bearing share keys and common secret query values before
 * text reaches application logs. This is defence in depth for error paths;
 * callers should still avoid constructing sensitive log messages.
 */
export function redactSensitiveLogText (value: string): string {
  return value
    .replace(/([?&](?:key|password|token)=)[^&\s)]*/gi, '$1[redacted]')
    .replace(/(\/(?:share|s)\/(?:photo\/|video\/|meta\/)?)[^/?\s]+/g, '$1[redacted]')
    // Bare share keys (67 chars) and similar credential-shaped tokens. Job,
    // plan and visitor ids are 24 chars and asset UUIDs 36, so they survive.
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g, '[redacted]')
}

/**
 * Render an unknown thrown value for a log line, including the message of a
 * nested `cause` (undici wraps connection errors this way), with redaction.
 */
export function describeError (error: unknown): string {
  if (!(error instanceof Error)) return redactSensitiveLogText(String(error))
  const parts = [error.stack || `${error.name}: ${error.message}`]
  const cause = (error as { cause?: unknown }).cause
  if (cause instanceof Error) parts.push('caused by: ' + (cause.message || cause.name))
  else if (cause !== undefined) parts.push('caused by: ' + String(cause))
  return redactSensitiveLogText(parts.join('\n'))
}

/** Return only the non-secret path portion of an upstream URL. */
export function urlPathForLog (value: string): string {
  try {
    return new URL(value, 'http://ipp.invalid').pathname
  } catch {
    return '[invalid-url]'
  }
}
