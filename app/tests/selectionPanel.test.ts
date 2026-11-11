import { describe, expect, it } from 'vitest'
import { selectedEntries } from '../src/client/selection'
import { state, itemForSlide, itemIndexForSlide, selectedItemIndices } from '../src/client/state'
import type { GalleryItem } from '../src/shared/types'

function item (id: string): GalleryItem {
  return { id, type: 'IMAGE', previewUrl: '', thumbnailUrl: `/thumb/${id}`, downloadFilename: '' }
}

describe('selection panel entries', () => {
  const items = ['a', 'b', 'c', 'd', 'e'].map(item)

  it('lists selected items in gallery order, not click order', () => {
    const { shown, hidden } = selectedEntries(items, new Set(['d', 'a', 'c']), 10)
    expect(shown.map(i => i.id)).toEqual(['a', 'c', 'd'])
    expect(hidden).toBe(0)
  })

  it('caps rendered thumbnails and counts the rest', () => {
    const { shown, hidden } = selectedEntries(items, new Set(items.map(i => i.id)), 2)
    expect(shown.map(i => i.id)).toEqual(['a', 'b'])
    expect(hidden).toBe(3)
  })

  it('ignores ids that are not gallery items and handles an empty selection', () => {
    expect(selectedEntries(items, new Set(['zz']), 10)).toEqual({ shown: [], hidden: 0 })
    expect(selectedEntries(items, new Set(), 10)).toEqual({ shown: [], hidden: 0 })
  })
})

describe('lightbox slide to gallery item mapping', () => {
  const items = ['a', 'b', 'c', 'd', 'e'].map(item)

  it('maps slides one to one over the whole album', () => {
    state.items = items
    state.slideIndices = null
    expect(itemIndexForSlide(3)).toBe(3)
    expect(itemForSlide(0)?.id).toBe('a')
  })

  it('maps the selection carousel slides to the selected gallery items', () => {
    state.items = items
    state.selected = new Set(['e', 'b', 'd'])
    state.slideIndices = selectedItemIndices()
    expect(state.slideIndices).toEqual([1, 3, 4])
    expect([0, 1, 2].map(i => itemForSlide(i)?.id)).toEqual(['b', 'd', 'e'])
    expect(itemIndexForSlide(3)).toBe(-1)
    expect(itemForSlide(-1)).toBeUndefined()
    state.slideIndices = null
    state.selected = new Set()
  })
})
