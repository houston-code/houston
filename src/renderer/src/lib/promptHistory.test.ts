import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadPromptHistory,
  appendPromptHistory,
  historyUp,
  historyDown
} from './promptHistory'

beforeEach(() => {
  localStorage.clear()
})

describe('appendPromptHistory / loadPromptHistory', () => {
  it('appends prompts oldest → newest', () => {
    appendPromptHistory('first')
    appendPromptHistory('second')
    expect(loadPromptHistory()).toEqual(['first', 'second'])
  })

  it('ignores blank/whitespace-only prompts', () => {
    appendPromptHistory('   ')
    appendPromptHistory('')
    expect(loadPromptHistory()).toEqual([])
  })

  it('trims and de-duplicates, moving a repeat to the newest slot', () => {
    appendPromptHistory('hello')
    appendPromptHistory('world')
    appendPromptHistory('  hello  ')
    expect(loadPromptHistory()).toEqual(['world', 'hello'])
  })

  it('caps the list at 100, dropping the oldest', () => {
    for (let i = 0; i < 120; i++) appendPromptHistory(`p${i}`)
    const list = loadPromptHistory()
    expect(list).toHaveLength(100)
    expect(list[0]).toBe('p20')
    expect(list[99]).toBe('p119')
  })

  it('returns an empty list when storage is empty or corrupt', () => {
    expect(loadPromptHistory()).toEqual([])
    localStorage.setItem('houston.promptHistory', 'not json')
    expect(loadPromptHistory()).toEqual([])
    localStorage.setItem('houston.promptHistory', '{"not":"an array"}')
    expect(loadPromptHistory()).toEqual([])
  })
})

describe('historyUp / historyDown', () => {
  // A 3-item history; index 3 is the live draft.
  it('Up walks back from the draft and clamps at the oldest', () => {
    expect(historyUp(3, 3)).toBe(2)
    expect(historyUp(3, 2)).toBe(1)
    expect(historyUp(3, 1)).toBe(0)
    expect(historyUp(3, 0)).toBe(0)
  })

  it('Down walks forward and stops at the draft sentinel', () => {
    expect(historyDown(3, 0)).toBe(1)
    expect(historyDown(3, 2)).toBe(3)
    expect(historyDown(3, 3)).toBe(3)
  })

  it('Up is a no-op with no history', () => {
    expect(historyUp(0, 0)).toBe(0)
  })
})
