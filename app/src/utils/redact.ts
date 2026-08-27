/**
 * Remove credential-bearing share keys and common secret query values before
 * text reaches application logs. This is defence in depth for error paths;
 * callers should still avoid constructing sensitive log messages.
 */
export function redactSensitiveLogText (value: string): string {
  return value
    .replace(/([?&](?:key|password|token)=)[^&\s)]*/gi, '$1[redacted]')
    .replace(/(\/(?:share|s)\/(?:photo\/|video\/|meta\/)?)[^/?\s]+/g, '$1[redacted]')
}

/** Return only the non-secret path portion of an upstream URL. */
export function urlPathForLog (value: string): string {
  try {
    return new URL(value, 'http://ipp.invalid').pathname
  } catch {
    return '[invalid-url]'
  }
}
