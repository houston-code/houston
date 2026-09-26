import { describe, expect, it } from 'vitest'
import type { ReviewFinding } from './agent'
import {
  createFindingPrinter,
  droppedSummary,
  findingLine,
  findingTally,
  sortFindings,
  upsertFinding
} from './reviewFindings'

const f = (id: string, over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id,
  dimension: 'security',
  severity: 'medium',
  title: `title ${id}`,
  status: 'candidate',
  ...over
})

describe('upsertFinding', () => {
  it('appends new ids and replaces existing ones in place', () => {
    let list = upsertFinding([], f('a'))
    list = upsertFinding(list, f('b'))
    list = upsertFinding(list, f('a', { status: 'confirmed' }))
    expect(list.map((x) => [x.id, x.status])).toEqual([
      ['a', 'confirmed'],
      ['b', 'candidate']
    ])
  })
})

describe('sortFindings', () => {
  it('orders most severe first and keeps arrival order within a severity', () => {
    const list = [f('1', { severity: 'low' }), f('2', { severity: 'high' }), f('3', { severity: 'critical' }), f('4', { severity: 'high' })]
    expect(sortFindings(list).map((x) => x.id)).toEqual(['3', '2', '4', '1'])
  })
})

describe('findingTally', () => {
  it('counts kept findings by severity', () => {
    const list = [
      f('1', { severity: 'high', status: 'confirmed' }),
      f('2', { severity: 'high', status: 'confirmed' }),
      f('3', { severity: 'low', status: 'confirmed' }),
      f('4', { severity: 'critical', status: 'rejected' })
    ]
    expect(findingTally(list)).toBe('2 high · 1 low')
  })

  it('says no confirmed issues when everything was dropped, and null with no findings', () => {
    expect(findingTally([f('1', { status: 'rejected' }), f('2', { status: 'merged' })])).toBe('no confirmed issues')
    expect(findingTally([])).toBeNull()
  })
})

describe('droppedSummary', () => {
  it('names rejected and merged findings separately, with singular forms', () => {
    expect(droppedSummary([f('1', { status: 'rejected' })])).toBe('1 dropped as a false positive')
    expect(
      droppedSummary([f('1', { status: 'rejected' }), f('2', { status: 'rejected' }), f('3', { status: 'merged' })])
    ).toBe('2 dropped as false positives, 1 merged as a duplicate')
    expect(droppedSummary([f('1', { status: 'confirmed' })])).toBeNull()
  })
})

describe('findingLine', () => {
  it('formats each printable status and skips the transient verifying state', () => {
    const base = { severity: 'high' as const, location: 'a.ts:1', title: 'hole' }
    expect(findingLine(f('1', { ...base, status: 'candidate' }))).toBe('◇ HIGH      a.ts:1  hole')
    expect(findingLine(f('1', { ...base, status: 'confirmed' }))).toBe('✓ HIGH      a.ts:1  hole')
    expect(findingLine(f('1', { ...base, status: 'rejected' }))).toBe('✕ rejected  a.ts:1  hole')
    expect(findingLine(f('1', { ...base, status: 'merged' }))).toBe('↳ merged  a.ts:1  hole')
    expect(findingLine(f('1', { ...base, status: 'verifying' }))).toBeNull()
  })


  it('strips terminal control characters from model-written text', () => {
    const line = findingLine(f('1', { location: 'a.ts:1', title: 'x\x1b[2J\x1b]8;;http://evil\x07y\nz', status: 'candidate' }))
    // eslint-disable-next-line no-control-regex -- asserting control characters are gone
    expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/)
    expect(line).toContain('x [2J ]8;;http://evil y z')
  })
})

describe('createFindingPrinter', () => {
  it('prints once per status change, per review call', () => {
    const print = createFindingPrinter()
    expect(print('c1', f('a'))).not.toBeNull()
    expect(print('c1', f('a', { status: 'verifying' }))).toBeNull()
    expect(print('c1', f('a', { status: 'confirmed', votes: { confirmed: 2, cast: 2, total: 3 } }))).not.toBeNull()
    // The third vote re-emits the same verdict: nothing new to print.
    expect(print('c1', f('a', { status: 'confirmed', votes: { confirmed: 3, cast: 3, total: 3 } }))).toBeNull()
    // Same finding id under a different review call is its own finding.
    expect(print('c2', f('a'))).not.toBeNull()
  })
})
