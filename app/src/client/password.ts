import { readPasswordFragment } from '../shared/passwordFragment.js'

function csrfToken (): string {
  const prefix = 'ipp-csrf='
  const part = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(prefix))
  if (!part) return ''
  try { return decodeURIComponent(part.slice(prefix.length)) } catch (e) { return '' }
}

async function submitForm (form: HTMLFormElement, fragmentPassword?: string): Promise<void> {
  const formData = new FormData(form)
  if (fragmentPassword !== undefined) formData.set('password', fragmentPassword)
  try {
    const res = await fetch('/share/unlock', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-IPP-CSRF-Token': csrfToken()
      },
      body: JSON.stringify(Object.fromEntries(formData.entries()))
    })
    if (res.status === 200 || res.status === 403) window.location.reload()
  } catch (e) { }
}

const form = document.getElementById('unlock')
if (form instanceof HTMLFormElement) {
  form.addEventListener('submit', event => {
    event.preventDefault()
    void submitForm(form)
  })

  const fragment = readPasswordFragment(window.location.hash)
  if (fragment.present) {
    // Clear the credential before any network request or navigation. If the
    // browser refuses history replacement, leave the manual form in place and
    // do not submit the fragment.
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
      if (fragment.password !== undefined) void submitForm(form, fragment.password)
    } catch (e) { }
  }
}
