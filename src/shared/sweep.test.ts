import { describe, expect, it } from 'vitest'
import {
  formatSweepList,
  formatSweepSummary,
  parseSweepItems,
  parseSweepItemsSafe,
  parseSweepMode,
  type SweepItem
} from './sweep'

describe('parseSweepMode', () => {
  it('accepts the two modes', () => {
    expect(parseSweepMode('author')).toBe('author')
    expect(parseSweepMode('process')).toBe('process')
  })
  it('rejects anything else', () => {
    expect(() => parseSweepMode('merge')).toThrow(/mode must be one of/)
    expect(() => parseSweepMode(undefined)).toThrow(/mode must be one of/)
  })
})

describe('parseSweepItems', () => {
  it('normalizes valid items and trims strings', () => {
    const items = parseSweepItems([
      { task: '  Add tests ', status: 'in_progress', branch: ' feat/x ', pr: ' https://u ', note: ' wip ' }
    ])
    expect(items).toEqual([
      { task: 'Add tests', status: 'in_progress', branch: 'feat/x', pr: 'https://u', note: 'wip' }
    ])
  })

  it('coerces a numeric pr to "#N"', () => {
    expect(parseSweepItems([{ task: 't', status: 'pr_open', pr: 42 }])[0].pr).toBe('#42')
  })

  it('drops empty optional fields', () => {
    const item = parseSweepItems([{ task: 't', status: 'done', branch: '  ', note: '' }])[0]
    expect(item).toEqual({ task: 't', status: 'done' })
  })

  it('rejects a non-array', () => {
    expect(() => parseSweepItems({})).toThrow(/items must be an array/)
  })

  it('rejects an empty task', () => {
    expect(() => parseSweepItems([{ task: '  ', status: 'pending' }])).toThrow(/task must be a non-empty/)
  })

  it('rejects an unknown status', () => {
    expect(() => parseSweepItems([{ task: 't', status: 'reviewing' }])).toThrow(/status must be one of/)
  })

  it('parseSweepItemsSafe swallows bad input', () => {
    expect(parseSweepItemsSafe('nope')).toEqual([])
  })
})

describe('formatSweepSummary', () => {
  it('reports a cleared board', () => {
    expect(formatSweepSummary('author', [])).toBe('Cleared the author PR sweep.')
  })

  it('counts statuses', () => {
    const items: SweepItem[] = [
      { task: 'a', status: 'done' },
      { task: 'b', status: 'pr_open' },
      { task: 'c', status: 'in_progress' },
      { task: 'd', status: 'failed' }
    ]
    expect(formatSweepSummary('process', items)).toBe(
      'PR sweep (process): 4 items — 1 done, 1 PR open, 1 in progress, 1 failed.'
    )
  })
})

describe('formatSweepList', () => {
  it('renders marks, chips, and notes', () => {
    const items: SweepItem[] = [
      { task: 'Fix auth', status: 'pr_open', branch: 'feat/auth', pr: '#12' },
      { task: 'Broken one', status: 'failed', note: 'tests fail' }
    ]
    expect(formatSweepList(items)).toBe(
      '[PR] Fix auth (feat/auth #12)\n[!] Broken one — tests fail'
    )
  })
})
