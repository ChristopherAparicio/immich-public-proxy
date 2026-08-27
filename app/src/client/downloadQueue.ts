type ZipState = 'queued' | 'preparing' | 'ready' | 'downloading' | 'complete' | 'failed' | 'cancelled'

type ZipStatus = {
  id: string
  state: ZipState
  phase?: 'fetching' | 'finalizing'
  completedItems?: number
  totalItems?: number
  sizeBytes?: number
  message?: string
  partIndex?: number
  partCount?: number
}

type ZipPlanPart = {
  index: number
  assetCount: number
  sizeBytes: number
}

type ZipPlan = {
  id: string
  totalItems: number
  totalBytes: number
  requiresSplit: boolean
  parts: ZipPlanPart[]
}

let downloadPath = ''
let currentJob: ZipStatus | null = null
let pollTimer: number | undefined
let pendingAssets: string[] | undefined
let currentPlan: ZipPlan | null = null
let pendingPart: number | undefined

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null

function csrfToken (): string {
  const prefix = 'ipp-csrf='
  const part = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(prefix))
  if (!part) return ''
  try { return decodeURIComponent(part.slice(prefix.length)) } catch { return '' }
}

function validJobId (value: string): boolean {
  return /^[A-Za-z0-9_-]{24}$/.test(value)
}

function safeDownloadPath (path?: string): string {
  if (!path) return ''
  try {
    const url = new URL(path, window.location.origin)
    if (url.origin !== window.location.origin || url.search || url.hash) return ''
    return /^\/(?:share|s)\/[A-Za-z0-9_-]{1,128}\/download$/.test(url.pathname) ? url.pathname : ''
  } catch {
    return ''
  }
}

function storageKey () { return 'ipp-zip-job:' + downloadPath }

function formatBytes (bytes?: number): string {
  if (!bytes || bytes < 1) return ''
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit >= 2 ? 1 : 0)} ${units[unit]}`
}

function openDialog () {
  const dialog = byId<HTMLDialogElement>('zip-dialog')
  if (dialog && !dialog.open) dialog.showModal()
}

function setMainButtonState (state: ZipState | 'idle' | 'planning') {
  const button = byId<HTMLAnchorElement>('download-all')
  if (!button) return
  button.dataset.state = state
  const label = state === 'planning'
    ? 'Analyzing album'
    : state === 'queued'
      ? 'ZIP queued'
      : state === 'preparing'
        ? 'Preparing ZIP'
        : state === 'ready'
          ? 'ZIP ready to download'
          : 'Download all'
  button.title = label
  button.setAttribute('aria-label', label)
}

function showElement (id: string, visible: boolean) {
  const element = byId<HTMLElement>(id)
  if (element) element.hidden = !visible
}

function clearParts () {
  const parts = byId<HTMLElement>('zip-parts')
  if (parts) parts.replaceChildren()
  showElement('zip-parts', false)
}

function renderPlanPicker (plan: ZipPlan) {
  currentPlan = plan
  currentJob = null
  pendingPart = undefined
  setMainButtonState('idle')
  const title = byId<HTMLElement>('zip-dialog-title')
  const message = byId<HTMLElement>('zip-dialog-message')
  const detail = byId<HTMLElement>('zip-dialog-detail')
  const parts = byId<HTMLElement>('zip-parts')
  if (title) title.textContent = 'Download this album in parts'
  if (message) message.textContent = `${formatBytes(plan.totalBytes)} will be split into ${plan.parts.length} independent ZIP files.`
  if (detail) detail.textContent = 'Choose one part. Other visitors can use the queue between your downloads.'
  showElement('zip-progress', false)
  showElement('zip-leave', false)
  showElement('zip-action', false)
  showElement('zip-parts', true)
  if (!parts) return
  parts.replaceChildren()
  for (const part of plan.parts) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'zip-part'
    const label = document.createElement('span')
    label.textContent = `Part ${part.index} of ${plan.parts.length}`
    const meta = document.createElement('span')
    meta.className = 'zip-part-meta'
    meta.textContent = `${part.assetCount} ${part.assetCount === 1 ? 'item' : 'items'} · ${formatBytes(part.sizeBytes)}`
    button.append(label, meta)
    button.addEventListener('click', () => {
      pendingPart = part.index
      prepare()
    })
    parts.append(button)
  }
}

function renderStatus (status: ZipStatus) {
  currentJob = status
  if (validJobId(status.id)) sessionStorage.setItem(storageKey(), status.id)
  else sessionStorage.removeItem(storageKey())
  setMainButtonState(status.state)

  const title = byId<HTMLElement>('zip-dialog-title')
  const message = byId<HTMLElement>('zip-dialog-message')
  const detail = byId<HTMLElement>('zip-dialog-detail')
  const progress = byId<HTMLProgressElement>('zip-progress')
  const action = byId<HTMLButtonElement>('zip-action')
  clearParts()

  showElement('zip-leave', ['queued', 'preparing', 'ready'].includes(status.state))
  showElement('zip-action', status.state === 'ready' || status.state === 'failed')
  showElement('zip-progress', status.state === 'queued' || status.state === 'preparing')

  if (status.state === 'queued') {
    if (title) title.textContent = 'Your ZIP is in the download queue'
    if (message) message.textContent = 'Another ZIP is currently being prepared or downloaded. Preparation will start automatically when resources become available.'
    if (detail) detail.textContent = 'You can close this window. Your request will remain queued while this page is open.'
    if (progress) progress.removeAttribute('value')
  } else if (status.state === 'preparing') {
    if (title) {
      title.textContent = status.partIndex && status.partCount
        ? `Preparing part ${status.partIndex} of ${status.partCount}…`
        : 'Preparing your ZIP…'
    }
    if (message) {
      message.textContent = status.phase === 'finalizing'
        ? 'Finalizing the archive…'
        : 'Fetching the original files…'
    }
    const completed = status.completedItems || 0
    const total = status.totalItems || 0
    if (detail) detail.textContent = total > 0 ? `${completed} of ${total} items` : 'Preparation in progress…'
    if (progress && total > 0) {
      progress.max = total
      progress.value = completed
    } else if (progress) {
      progress.removeAttribute('value')
    }
  } else if (status.state === 'ready') {
    const size = formatBytes(status.sizeBytes)
    if (title) {
      title.textContent = status.partIndex && status.partCount
        ? `Part ${status.partIndex} of ${status.partCount} is ready`
        : 'Your ZIP is ready'
    }
    if (message) message.textContent = size ? `Archive size: ${size}` : 'The archive is ready to download.'
    if (detail) detail.textContent = 'Tap the button below to start the download.'
    if (action) action.textContent = size ? `Download ZIP — ${size}` : 'Download ZIP'
  } else if (status.state === 'downloading') {
    if (title) title.textContent = 'Downloading your ZIP…'
    if (message) message.textContent = 'Keep the browser download active until it completes.'
    if (detail) detail.textContent = ''
  } else if (status.state === 'complete') {
    if (title) title.textContent = 'Download sent'
    if (message) message.textContent = 'The ZIP was sent to your browser.'
    if (detail) detail.textContent = ''
    showElement('zip-leave', false)
    setMainButtonState('idle')
    sessionStorage.removeItem(storageKey())
    if (currentPlan?.requiresSplit && status.partIndex) {
      window.setTimeout(() => {
        if (currentPlan) renderPlanPicker(currentPlan)
      }, 750)
    }
  } else if (status.state === 'failed' || status.state === 'cancelled') {
    if (title) title.textContent = status.state === 'failed' ? 'ZIP preparation failed' : 'ZIP request cancelled'
    if (message) message.textContent = status.message || 'Please try again.'
    if (detail) detail.textContent = ''
    if (action) action.textContent = 'Retry'
    showElement('zip-leave', false)
    setMainButtonState('idle')
    sessionStorage.removeItem(storageKey())
  }
}

async function poll () {
  if (!currentJob) return
  try {
    const response = await fetch(`${downloadPath}/jobs/${currentJob.id}`, {
      credentials: 'same-origin',
      cache: 'no-store'
    })
    if (response.status === 404) {
      reset()
      return
    }
    if (!response.ok) throw new Error('status request failed')
    renderStatus(await response.json() as ZipStatus)
  } catch {
    // A transient mobile-network interruption should not discard the job.
  }
  if (currentJob && !['complete', 'failed', 'cancelled'].includes(currentJob.state)) {
    pollTimer = window.setTimeout(poll, 2000)
  }
}

function schedulePoll () {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer)
  pollTimer = window.setTimeout(poll, 1000)
}

function showLocalError (message: string) {
  const status: ZipStatus = { id: '', state: 'failed', message }
  renderStatus(status)
  openDialog()
}

async function prepare () {
  openDialog()
  const title = byId<HTMLElement>('zip-dialog-title')
  const message = byId<HTMLElement>('zip-dialog-message')
  if (title) title.textContent = 'Requesting your ZIP…'
  if (message) message.textContent = 'Please wait.'
  clearParts()
  try {
    const response = await fetch(`${downloadPath}/prepare`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-IPP-CSRF-Token': csrfToken()
      },
      body: JSON.stringify(pendingAssets
        ? { assets: pendingAssets }
        : currentPlan && pendingPart
          ? { planId: currentPlan.id, part: pendingPart }
          : {})
    })
    if (response.status === 403) {
      window.location.reload()
      return
    }
    if (response.status === 429) {
      showLocalError('The download queue is full. Please try again later.')
      return
    }
    if (!response.ok) {
      showLocalError('The ZIP request could not be created. Please try again.')
      return
    }
    renderStatus(await response.json() as ZipStatus)
    schedulePoll()
  } catch {
    showLocalError('The ZIP request could not be created. Check your connection and try again.')
  }
}

async function planDownload () {
  currentJob = null
  currentPlan = null
  pendingPart = undefined
  openDialog()
  clearParts()
  setMainButtonState('planning')
  const title = byId<HTMLElement>('zip-dialog-title')
  const message = byId<HTMLElement>('zip-dialog-message')
  const detail = byId<HTMLElement>('zip-dialog-detail')
  if (title) title.textContent = 'Analyzing this album…'
  if (message) message.textContent = 'Checking original file sizes before using VPS resources.'
  if (detail) detail.textContent = 'No ZIP is being generated yet.'
  showElement('zip-progress', true)
  showElement('zip-leave', false)
  showElement('zip-action', false)
  try {
    const response = await fetch(`${downloadPath}/plan`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-IPP-CSRF-Token': csrfToken() }
    })
    if (response.status === 403) {
      window.location.reload()
      return
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { message?: string }
      showLocalError(body.message || 'The album could not be planned safely. Please try again.')
      return
    }
    const plan = await response.json() as ZipPlan
    const validParts = Array.isArray(plan.parts) &&
      plan.parts.length >= 1 &&
      plan.parts.length <= 256 &&
      plan.parts.every((part, index) =>
        part?.index === index + 1 &&
        Number.isSafeInteger(part.assetCount) && part.assetCount > 0 &&
        Number.isSafeInteger(part.sizeBytes) && part.sizeBytes > 0
      )
    const summedItems = validParts ? plan.parts.reduce((sum, part) => sum + part.assetCount, 0) : 0
    const summedBytes = validParts ? plan.parts.reduce((sum, part) => sum + part.sizeBytes, 0) : 0
    if (!validJobId(plan.id) ||
      !validParts ||
      !Number.isSafeInteger(plan.totalItems) || plan.totalItems !== summedItems ||
      !Number.isSafeInteger(plan.totalBytes) || plan.totalBytes !== summedBytes ||
      plan.requiresSplit !== (plan.parts.length > 1)) {
      showLocalError('The ZIP plan was invalid. Please try again.')
      return
    }
    currentPlan = plan
    if (plan.requiresSplit) {
      renderPlanPicker(plan)
      return
    }
    pendingPart = 1
    prepare()
  } catch {
    showLocalError('The album could not be analyzed. Check your connection and try again.')
  }
}

function reset () {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer)
  pollTimer = undefined
  currentJob = null
  pendingAssets = undefined
  pendingPart = undefined
  if (downloadPath) sessionStorage.removeItem(storageKey())
  setMainButtonState('idle')
}

async function leaveQueue () {
  if (!currentJob) return
  const id = currentJob.id
  try {
    await fetch(`${downloadPath}/jobs/${id}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'X-IPP-CSRF-Token': csrfToken() }
    })
  } finally {
    reset()
    const dialog = byId<HTMLDialogElement>('zip-dialog')
    if (dialog?.open) dialog.close()
  }
}

function downloadReadyZip () {
  if (!currentJob) return
  if (currentJob.state === 'failed' || currentJob.state === 'cancelled') {
    const retryPart = currentJob.partIndex || pendingPart
    const retryAssets = pendingAssets
    reset()
    if (currentPlan && retryPart) {
      pendingPart = retryPart
      prepare()
    } else if (retryAssets) {
      pendingAssets = retryAssets
      prepare()
    } else {
      planDownload()
    }
    return
  }
  if (currentJob.state !== 'ready') return
  if (!validJobId(currentJob.id)) {
    reset()
    return
  }
  const link = document.createElement('a')
  link.href = `${downloadPath}/jobs/${encodeURIComponent(currentJob.id)}/file`
  link.download = ''
  document.body.appendChild(link)
  link.click()
  link.remove()
  currentJob.state = 'downloading'
  renderStatus(currentJob)
  schedulePoll()
}

export function startZipDownload (assets?: string[]) {
  pendingAssets = assets
  if (currentJob && !['complete', 'failed', 'cancelled'].includes(currentJob.state)) {
    openDialog()
    return
  }
  if (assets) {
    currentPlan = null
    prepare()
  } else if (currentPlan?.requiresSplit) {
    openDialog()
    renderPlanPicker(currentPlan)
  } else {
    planDownload()
  }
}

export function setupZipDownload (path?: string) {
  downloadPath = safeDownloadPath(path)
  if (!downloadPath) return
  const button = byId<HTMLAnchorElement>('download-all')
  const dialog = byId<HTMLDialogElement>('zip-dialog')
  button?.addEventListener('click', event => {
    event.preventDefault()
    startZipDownload()
  })
  byId<HTMLButtonElement>('zip-close')?.addEventListener('click', () => dialog?.close())
  byId<HTMLButtonElement>('zip-leave')?.addEventListener('click', leaveQueue)
  byId<HTMLButtonElement>('zip-action')?.addEventListener('click', downloadReadyZip)

  const saved = sessionStorage.getItem(storageKey())
  if (saved && validJobId(saved)) {
    currentJob = { id: saved, state: 'queued' }
    poll()
  }
}
