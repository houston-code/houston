import { describe, expect, it } from 'vitest'
import {
  LABEL_COLORS,
  MAX_LABEL_NAME,
  MAX_LABELS,
  MAX_LABELS_PER_CHAT,
  cleanLabelName,
  cycleLabelColor,
  newLabelId,
  nextLabelColor,
  readChatLabels,
  readLabelFilters,
  sanitizeLabelIds
} from './chatLabels'
import type { ChatLabel } from './types'

describe('sanitizeLabelIds', () => {
  it('keeps string ids in order and drops duplicates', () => {
    expect(sanitizeLabelIds(['a', 'b', 'a', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('drops anything that is not a non-empty, short string', () => {
    expect(sanitizeLabelIds(['a', '', 3, null, { id: 'x' }, 'x'.repeat(65), 'b'])).toEqual(['a', 'b'])
  })

  it('reads a non-array as no labels', () => {
    for (const raw of [undefined, null, 'a', 7, { a: 1 }]) expect(sanitizeLabelIds(raw)).toEqual([])
  })

  it('caps how many labels one chat carries', () => {
    const many = Array.from({ length: MAX_LABELS_PER_CHAT + 5 }, (_, i) => `l${i}`)
    expect(sanitizeLabelIds(many)).toEqual(many.slice(0, MAX_LABELS_PER_CHAT))
  })
})

describe('cleanLabelName', () => {
  it('trims, collapses inner whitespace, and caps the length', () => {
    expect(cleanLabelName('  needs   review \n')).toBe('needs review')
    expect(cleanLabelName('x'.repeat(MAX_LABEL_NAME + 10))).toHaveLength(MAX_LABEL_NAME)
    expect(cleanLabelName('   ')).toBe('')
  })
})

describe('readChatLabels', () => {
  it('keeps well-formed labels in order', () => {
    const labels: ChatLabel[] = [
      { id: 'a', name: 'bug', color: 'red' },
      { id: 'b', name: 'review', color: 'teal' }
    ]
    expect(readChatLabels(labels)).toEqual(labels)
  })

  it('drops malformed entries, duplicate ids, and blank names', () => {
    expect(
      readChatLabels([
        null,
        'bug',
        { id: 1, name: 'x', color: 'red' },
        { id: 'a', name: '  ', color: 'red' },
        { id: 'b', name: 'bug', color: 'red' },
        { id: 'b', name: 'again', color: 'blue' },
        { id: 'c', color: 'red' }
      ])
    ).toEqual([{ id: 'b', name: 'bug', color: 'red' }])
  })

  it('falls back to the first color for an unknown one, and cleans the name', () => {
    expect(readChatLabels([{ id: 'a', name: '  wip  ', color: 'chartreuse' }])).toEqual([
      { id: 'a', name: 'wip', color: LABEL_COLORS[0] }
    ])
  })

  it('reads a non-array as no labels and caps the count', () => {
    expect(readChatLabels({ id: 'a' })).toEqual([])
    const many = Array.from({ length: MAX_LABELS + 3 }, (_, i) => ({ id: `l${i}`, name: `n${i}`, color: 'red' }))
    expect(readChatLabels(many)).toHaveLength(MAX_LABELS)
  })
})

describe('readLabelFilters', () => {
  const known = new Set(['a', 'b'])

  it('keeps each section’s known label ids', () => {
    expect(readLabelFilters({ g1: ['a'], pinned: ['b', 'a'] }, known)).toEqual({ g1: ['a'], pinned: ['b', 'a'] })
  })

  it('drops deleted labels, and a section left with none', () => {
    expect(readLabelFilters({ g1: ['a', 'gone'], g2: ['gone'], g3: 'a' }, known)).toEqual({ g1: ['a'] })
  })

  it('reads anything but an object as no filters', () => {
    for (const raw of [undefined, null, ['a'], 'a']) expect(readLabelFilters(raw, known)).toEqual({})
  })
})

describe('label colors and ids', () => {
  it('gives a new label the first unused color, then cycles', () => {
    expect(nextLabelColor([])).toBe(LABEL_COLORS[0])
    expect(nextLabelColor([{ id: 'a', name: 'a', color: LABEL_COLORS[0] }])).toBe(LABEL_COLORS[1])
    const all = LABEL_COLORS.map((color, i) => ({ id: `${i}`, name: `${i}`, color }))
    expect(nextLabelColor(all)).toBe(LABEL_COLORS[0])
  })

  it('steps through every color and wraps around', () => {
    let c = LABEL_COLORS[0]
    const seen = [c]
    for (let i = 1; i < LABEL_COLORS.length; i++) seen.push((c = cycleLabelColor(c)))
    expect(seen).toEqual([...LABEL_COLORS])
    expect(cycleLabelColor(c)).toBe(LABEL_COLORS[0])
  })

  it('makes a fresh id each time', () => {
    const a = newLabelId()
    expect(a).toMatch(/^lbl-/)
    expect(newLabelId()).not.toBe(a)
    expect(sanitizeLabelIds([a])).toEqual([a])
  })
})
