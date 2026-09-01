export const PASSWORD_FRAGMENT_PARAMETER = 'ipp-password'

export interface PasswordFragment {
  present: boolean
  password?: string
}

/**
 * Decode the opt-in, client-only password fragment emitted by immich-share.
 * The fragment never reaches the HTTP server. Keep this parser strict so a
 * malformed or duplicated credential is cleared without being submitted.
 */
export function readPasswordFragment (hash: string): PasswordFragment {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw) return { present: false }

  const params = new URLSearchParams(raw)
  const values = params.getAll(PASSWORD_FRAGMENT_PARAMETER)
  if (values.length === 0) return { present: false }
  if (values.length !== 1) return { present: true }

  const password = values[0]
  if (password.length < 16 || password.length > 128 || /[\r\n\0]/.test(password)) {
    return { present: true }
  }
  return { present: true, password }
}
