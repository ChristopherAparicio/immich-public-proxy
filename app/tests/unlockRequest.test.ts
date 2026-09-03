import { describe, expect, it } from 'vitest'
import { unlockRequest } from '../src/session'

describe('unlockRequest validation', () => {
  const key = 'AbCdEf0123456789-_AbCdEf0123456789-_AbCdEf0123456789-_AbCdEf012345'

  it('accepts a well-formed key and a bounded string password', () => {
    expect(unlockRequest({ key, password: 'hunter2' })).toEqual({ key, password: 'hunter2' })
    expect(unlockRequest({ key, password: '' })).toEqual({ key, password: '' })
    expect(unlockRequest({ key, password: 'x'.repeat(256) })).toBeDefined()
  })

  it('rejects malformed or non-string keys', () => {
    expect(unlockRequest({ key: 'not a key!', password: 'p' })).toBeUndefined()
    expect(unlockRequest({ key: '../etc', password: 'p' })).toBeUndefined()
    expect(unlockRequest({ key: 42, password: 'p' })).toBeUndefined()
    expect(unlockRequest({ key: { toString: () => key }, password: 'p' })).toBeUndefined()
    expect(unlockRequest({ key: 'k'.repeat(129), password: 'p' })).toBeUndefined()
    expect(unlockRequest({ password: 'p' })).toBeUndefined()
  })

  it('rejects object-graph property names as keys', () => {
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      expect(unlockRequest({ key: name, password: 'p' })).toBeUndefined()
    }
  })

  it('rejects non-string or oversized passwords', () => {
    expect(unlockRequest({ key, password: ['p'] })).toBeUndefined()
    expect(unlockRequest({ key, password: { toString: () => 'p' } })).toBeUndefined()
    expect(unlockRequest({ key, password: 1234 })).toBeUndefined()
    expect(unlockRequest({ key, password: 'x'.repeat(257) })).toBeUndefined()
    expect(unlockRequest({ key })).toBeUndefined()
  })

  it('rejects non-object bodies', () => {
    expect(unlockRequest(undefined)).toBeUndefined()
    expect(unlockRequest('key=x')).toBeUndefined()
    expect(unlockRequest(null)).toBeUndefined()
  })
})
