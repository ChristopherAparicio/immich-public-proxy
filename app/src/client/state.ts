// Shared mutable state for the client gallery. Every module that touches
// gallery-wide state goes through `state` rather than holding its own
// top-level `let`s. Layout / scroll-tuning constants live here too because
// they are read by multiple modules. SVG icon strings live in `icons.ts`.

import type { GalleryItem, LightboxConfig, MetadataConfig, GroupByDateMode } from '../shared/types.js'

// ----- layout / scroll tuning ----------------------------------------------

// Justified-rows target row height (matches Immich's main view)
export const TARGET_ROW_HEIGHT = 235
export const GAP = 4
export const MOBILE_BREAKPOINT = 640
export const MOBILE_COLS = 3
export const IMAGE_LOAD_MARGIN_PX = 300
export const SCROLL_SETTLE_MS = 100
export const BUFFER_VIEWPORTS = 1
// Height reserved for each month header (must agree with .group-header CSS)
export const HEADER_HEIGHT = 48
// Vertical gap between groups
export const GROUP_GAP = 16
// Long-press threshold for entering select mode via touch/mouse
export const LONG_PRESS_MS = 500

// localStorage key for sidebar open state
export const SIDEBAR_STORAGE_KEY = 'ipp-sidebar-open'
// Width of the sidebar when docked (must match the CSS rule)
export const SIDEBAR_WIDTH = 360
// localStorage key for the selection panel collapsed state
export const SELECT_PANEL_STORAGE_KEY = 'ipp-select-panel-collapsed'
// Thumbnails rendered in the selection panel; the rest show as "+N more"
export const SELECT_PANEL_MAX_THUMBS = 200

// ----- mutable state -------------------------------------------------------

export interface LayoutEntry {
  index: number
  left: number
  top: number
  width: number
  height: number
}

export interface HeaderEntry {
  label: string
  top: number
  height: number
}

export interface GroupSpec {
  label: string | null
  indices: number[]
}

// PhotoSwipeLightbox is an external module with no TS types in this project.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PhotoSwipeLightboxInstance = any

export const state = {
  items: [] as GalleryItem[],
  layout: [] as LayoutEntry[],
  headers: [] as HeaderEntry[],
  groupByDate: false as GroupByDateMode | false,
  container: null as HTMLElement | null,
  lightbox: null as PhotoSwipeLightboxInstance,
  lightboxConfig: {} as Partial<LightboxConfig>,
  metadataConfig: {
    descriptionInCaption: false,
    descriptionInSidebar: false,
    sidebarHasContent: false,
    locationWebLink: false
  } as MetadataConfig,
  // True while our pushed history entry is live
  lightboxPushedHistory: false,
  // Guards against re-entering the popstate handler during our own history.back()
  closingFromHistory: false,
  lastContainerW: 0,
  renderedTiles: new Map<number, HTMLAnchorElement>(),
  renderedHeaders: new Map<string, HTMLElement>(),
  // Selection mode (mode-toggle UX: hidden checkmarks until activated)
  selectMode: false,
  selected: new Set<string>(),
  toolbarEl: null as HTMLElement | null,
  countEl: null as HTMLElement | null,
  selectAllBtn: null as HTMLButtonElement | null,
  cancelBtn: null as HTMLButtonElement | null,
  downloadBtn: null as HTMLButtonElement | null,
  // Info sidebar open/closed. Persisted to localStorage so the choice
  // survives navigation between slides and gallery reloads.
  sidebarOpen: false,
  // Base URL (`/share/meta/<key>`) for the on-demand per-asset metadata route.
  metaBase: '',
  // Re-render callbacks registered by lightbox UI elements (sidebar, caption,
  // download button). Each re-renders for the current slide. Invoked after a
  // lazy item's detail arrives so the just-opened slide reflects it.
  slideRefreshers: [] as Array<() => void>,
  // Gallery item indices shown by the lightbox when it runs over a subset (the
  // selection carousel); null when it shows the whole album in order.
  slideIndices: null as number[] | null,
  // Set by lightbox.ts so the selection panel can open its carousel without
  // importing the PhotoSwipe module (keeps selection.ts importable in tests).
  openSelectionLightbox: null as ((id: string) => void) | null
}

/** Gallery item index behind a lightbox slide index (-1 when out of range). */
export function itemIndexForSlide (slide: number): number {
  if (!state.slideIndices) return slide
  return state.slideIndices[slide] ?? -1
}

/** Gallery item behind a lightbox slide index. */
export function itemForSlide (slide: number): GalleryItem | undefined {
  return state.items[itemIndexForSlide(slide)]
}

/** Gallery indices of the selected items, in gallery order. */
export function selectedItemIndices (): number[] {
  const indices: number[] = []
  state.items.forEach((item, index) => { if (state.selected.has(item.id)) indices.push(index) })
  return indices
}
