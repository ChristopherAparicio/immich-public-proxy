// Selection mode (long-press to enter, checkmarks on tiles, toolbar at the
// bottom). Selected IDs are POSTed to /share/:key/download for a server-side
// zip, or downloaded directly for a single selection.

import { state, SELECT_PANEL_STORAGE_KEY, SELECT_PANEL_MAX_THUMBS } from './state.js'
import { startZipDownload } from './downloadQueue.js'
import { ICON_CLOSE } from './icons.js'
import type { GalleryItem } from '../shared/types.js'

/**
 * Activate selection mode. Tiles show their checkmark control, the bottom
 * toolbar reveals itself, and tap on a tile toggles selection instead of
 * opening the lightbox. No-op if already active.
 */
export function enterSelectMode () {
  if (state.selectMode) return
  state.selectMode = true
  if (state.container) state.container.classList.add('select-mode')
  if (state.toolbarEl) state.toolbarEl.hidden = false
}

/**
 * Leave selection mode and clear the selection. Removes the visual marker
 * from every tile currently in the DOM. No-op if not in select mode.
 */
export function exitSelectMode () {
  if (!state.selectMode) return
  state.selectMode = false
  // Clear DOM markers on the tiles currently in the DOM
  for (const a of state.renderedTiles.values()) a.classList.remove('selected')
  state.selected.clear()
  if (state.container) state.container.classList.remove('select-mode')
  if (state.toolbarEl) state.toolbarEl.hidden = true
  updateSelectionUI()
}

/**
 * Add or remove an item from the selection set. Updates the matching tile's
 * visual marker if that tile is currently rendered, and exits selection
 * mode automatically when the last item is deselected.
 */
export function toggleSelection (id: string) {
  if (state.selected.has(id)) state.selected.delete(id)
  else state.selected.add(id)
  const idx = state.items.findIndex(it => it.id === id)
  const tile = idx >= 0 ? state.renderedTiles.get(idx) : null
  if (tile) tile.classList.toggle('selected', state.selected.has(id))
  // Auto-exit if user deselected the last item
  if (state.selected.size === 0 && state.selectMode) exitSelectMode()
  else updateSelectionUI()
}

function updateSelectionUI () {
  if (state.countEl) {
    state.countEl.textContent = state.selected.size + ' selected'
  }
  renderPanel()
  if (state.downloadBtn) state.downloadBtn.disabled = state.selected.size === 0
  if (state.selectAllBtn) {
    state.selectAllBtn.textContent =
      state.selected.size === state.items.length ? 'Deselect all' : 'Select all'
  }
}

function selectAllOrNone () {
  if (state.selected.size === state.items.length) {
    // Deselect all but keep select mode active
    for (const a of state.renderedTiles.values()) a.classList.remove('selected')
    state.selected.clear()
    updateSelectionUI()
  } else {
    if (!state.selectMode) enterSelectMode()
    for (const item of state.items) state.selected.add(item.id)
    for (const a of state.renderedTiles.values()) a.classList.add('selected')
    updateSelectionUI()
  }
}

/**
 * Send the current selection to the download endpoint. A single selection
 * downloads the asset directly (no one-entry zip); two or more selections
 * POST to /share/:key/download and the server streams a zip back.
 */
export function downloadSelected () {
  if (state.selected.size === 0) return
  // Single selection: download the file directly so the user gets the image
  // (or video) instead of a one-entry zip.
  if (state.selected.size === 1) {
    const id = state.selected.values().next().value
    const item = state.items.find(it => it.id === id)
    if (item && item.downloadUrl) {
      const a = document.createElement('a')
      a.href = item.downloadUrl
      a.download = item.downloadFilename || ''
      document.body.appendChild(a)
      a.click()
      a.remove()
      return
    }
  }
  startZipDownload(Array.from(state.selected))
}

/**
 * Look up the selection toolbar in the DOM and wire its buttons (cancel,
 * select-all, download). Called once at init time. If the toolbar element
 * isn't on the page (the share doesn't allow downloads), this short-circuits
 * and selection-related code paths never activate.
 */
export function setupToolbar () {
  state.toolbarEl = document.getElementById('select-toolbar')
  // No toolbar means downloads aren't allowed for this share; nothing to wire
  if (!state.toolbarEl) return
  state.countEl = document.getElementById('select-count')
  state.selectAllBtn = document.getElementById('select-all') as HTMLButtonElement | null
  state.cancelBtn = document.getElementById('select-cancel') as HTMLButtonElement | null
  state.downloadBtn = document.getElementById('select-download') as HTMLButtonElement | null
  if (state.cancelBtn) state.cancelBtn.addEventListener('click', exitSelectMode)
  if (state.selectAllBtn) state.selectAllBtn.addEventListener('click', selectAllOrNone)
  if (state.downloadBtn) state.downloadBtn.addEventListener('click', downloadSelected)
  setupPanel()
  updateSelectionUI()
}

// ----- selection panel -----------------------------------------------------
//
// Right-hand column on desktop, bottom sheet on phones: thumbnails of the
// selected items (each removable), a collapse toggle and the same download
// action as the toolbar. Client-only: it reuses the thumbnail URLs the gallery
// already serves and the existing selection download.

/**
 * Selected items in gallery order. Capped so "Select all" on a large album
 * does not request every thumbnail at once; `hidden` counts the rest.
 */
export function selectedEntries (
  items: GalleryItem[],
  selected: ReadonlySet<string>,
  cap: number
): { shown: GalleryItem[], hidden: number } {
  if (selected.size === 0) return { shown: [], hidden: 0 }
  const all = items.filter(item => selected.has(item.id))
  return { shown: all.slice(0, cap), hidden: Math.max(0, all.length - cap) }
}

const panelEntries = new Map<string, HTMLLIElement>()
let panelEl: HTMLElement | null = null
let panelList: HTMLElement | null = null
let panelMore: HTMLElement | null = null
let panelTitle: HTMLElement | null = null
let panelToggle: HTMLButtonElement | null = null

function readPanelCollapsed (): boolean {
  try {
    return localStorage.getItem(SELECT_PANEL_STORAGE_KEY) === '1'
  } catch (e) {
    return false
  }
}

function setPanelCollapsed (collapsed: boolean) {
  if (!panelEl) return
  panelEl.classList.toggle('collapsed', collapsed)
  if (panelToggle) {
    panelToggle.setAttribute('aria-expanded', String(!collapsed))
    panelToggle.setAttribute('aria-label', collapsed ? 'Show selected photos' : 'Hide selected photos')
  }
  try {
    localStorage.setItem(SELECT_PANEL_STORAGE_KEY, collapsed ? '1' : '0')
  } catch (e) {
    // Private mode / quota: the choice stays in memory only.
  }
  syncPanelLayout()
}

/** Reserve room for the open panel so no tile hides behind it. */
function syncPanelLayout () {
  const open = !!panelEl && !panelEl.hidden
  document.body.classList.toggle('select-panel-open', open && !panelEl!.classList.contains('collapsed'))
  document.body.classList.toggle('select-panel-collapsed', open && panelEl!.classList.contains('collapsed'))
}

function setupPanel () {
  panelEl = document.getElementById('select-panel')
  if (!panelEl) return
  panelList = document.getElementById('select-panel-list')
  panelMore = document.getElementById('select-panel-more')
  panelTitle = document.getElementById('select-panel-title')
  panelToggle = document.getElementById('select-panel-toggle') as HTMLButtonElement | null
  const download = document.getElementById('select-panel-download')
  if (panelToggle) {
    panelToggle.addEventListener('click', () => {
      setPanelCollapsed(!panelEl!.classList.contains('collapsed'))
    })
  }
  if (download) download.addEventListener('click', downloadSelected)
  setPanelCollapsed(readPanelCollapsed())
}

function panelEntry (item: GalleryItem): HTMLLIElement {
  const existing = panelEntries.get(item.id)
  if (existing) return existing
  const li = document.createElement('li')
  const img = document.createElement('img')
  img.src = item.thumbnailUrl
  img.alt = ''
  img.loading = 'lazy'
  img.decoding = 'async'
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'select-panel-remove'
  remove.setAttribute('aria-label', 'Remove from selection')
  remove.innerHTML = ICON_CLOSE
  remove.addEventListener('click', () => toggleSelection(item.id))
  li.append(img, remove)
  panelEntries.set(item.id, li)
  return li
}

function renderPanel () {
  if (!panelEl || !panelList) return
  const visible = state.selectMode && state.selected.size > 0
  panelEl.hidden = !visible
  if (!visible) {
    panelList.replaceChildren()
    panelEntries.clear()
    syncPanelLayout()
    return
  }
  const { shown, hidden } = selectedEntries(state.items, state.selected, SELECT_PANEL_MAX_THUMBS)
  const keep = new Set(shown.map(item => item.id))
  for (const [id, li] of panelEntries) {
    if (!keep.has(id)) {
      li.remove()
      panelEntries.delete(id)
    }
  }
  // appendChild moves existing nodes, so images already loaded stay loaded.
  for (const item of shown) panelList.appendChild(panelEntry(item))
  if (panelMore) {
    panelMore.hidden = hidden === 0
    panelMore.textContent = hidden > 0 ? '+' + hidden + ' more' : ''
  }
  if (panelTitle) panelTitle.textContent = state.selected.size + ' selected'
  syncPanelLayout()
}
