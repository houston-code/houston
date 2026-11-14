import { describe, it, expect } from 'vitest'
import { chatAtIndex, cycleChatId, windowTitle } from './sessionNav'

describe('windowTitle', () => {
  it('leads with the open chat, then the app, joined by a plain hyphen', () => {
    expect(windowTitle('Fix the parser')).toBe('Fix the parser - Houston')
  })

  it('is just the app with no chat, or a blank title', () => {
    expect(windowTitle(null)).toBe('Houston')
    expect(windowTitle('  ')).toBe('Houston')
  })
})

const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

describe('chatAtIndex', () => {
  it('returns the id at the index', () => {
    expect(chatAtIndex(list, 0)).toBe('a')
    expect(chatAtIndex(list, 2)).toBe('c')
  })

  it('returns null when out of range', () => {
    expect(chatAtIndex(list, 3)).toBeNull()
    expect(chatAtIndex(list, -1)).toBeNull()
    expect(chatAtIndex([], 0)).toBeNull()
  })
})

describe('cycleChatId', () => {
  it('steps forward and backward, wrapping around', () => {
    expect(cycleChatId(list, 'a', 1)).toBe('b')
    expect(cycleChatId(list, 'c', 1)).toBe('a') // wrap forward
    expect(cycleChatId(list, 'a', -1)).toBe('c') // wrap backward
    expect(cycleChatId(list, 'b', -1)).toBe('a')
  })

  it('falls back to an end when the current id is absent', () => {
    expect(cycleChatId(list, null, 1)).toBe('a')
    expect(cycleChatId(list, 'zzz', 1)).toBe('a')
    expect(cycleChatId(list, null, -1)).toBe('c')
  })

  it('returns null for an empty list', () => {
    expect(cycleChatId([], 'a', 1)).toBeNull()
  })
})
