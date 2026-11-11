import { describe, expect, it } from 'vitest'
import { selectedEntries } from '../src/client/selection'
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
