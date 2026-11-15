import { describe, it, expect } from 'vitest'
import {
  midRunRows,
  oneLine,
  waitingAnnouncement,
  MAX_WAITING_ROWS,
  MIDRUN_TAKE_BACK_HINT,
  MIDRUN_TYPING_HINT
} from './tui-midrun'
import { visibleWidth } from './tui-wrap'

const plain = (s: string): string => s

describe('oneLine', () => {
  it('shows line breaks as a mark, and drops control characters', () => {
    expect(oneLine('one\ntwo')).toBe('one ↵ two')
    expect(oneLine('a\x1b[31mb')).not.toContain('\x1b')
  })
})

describe('midRunRows', () => {
  it('shows nothing when nothing waits and nothing is typed', () => {
    expect(midRunRows([], { width: 80, paint: plain, typing: false })).toEqual([])
  })

  it('names each waiting message by what it waits for, with the take-back hint', () => {
    const rows = midRunRows(
      [
        { id: 'a', text: 'use YAML', kind: 'steer' },
        { id: 'b', text: 'then update\nthe docs', kind: 'queued' }
      ],
      { width: 80, paint: plain, typing: false }
    )
    expect(rows[0]).toContain('steering next: use YAML')
    expect(rows[1]).toContain('queued: then update ↵ the docs')
    expect(rows.at(-1)).toContain(MIDRUN_TAKE_BACK_HINT)
  })

  it('shows the typing keys while a line is being typed', () => {
    const rows = midRunRows([], { width: 80, paint: plain, typing: true })
    expect(rows).toEqual([`  ${MIDRUN_TYPING_HINT}`])
  })

  it('collapses older messages past the row limit to a count', () => {
    const waiting = Array.from({ length: MAX_WAITING_ROWS + 2 }, (_, i) => ({
      id: String(i),
      text: `message ${i}`,
      kind: 'queued' as const
    }))
    const rows = midRunRows(waiting, { width: 80, paint: plain, typing: false })
    expect(rows[0]).toContain('2 earlier waiting')
    expect(rows.some((r) => r.includes('message 0'))).toBe(false)
    expect(rows.some((r) => r.includes(`message ${MAX_WAITING_ROWS + 1}`))).toBe(true)
  })

  it('never draws a row wider than the terminal', () => {
    const rows = midRunRows([{ id: 'a', text: 'x'.repeat(300), kind: 'queued' }], {
      width: 30,
      paint: plain,
      typing: true
    })
    for (const r of rows) expect(visibleWidth(r)).toBeLessThanOrEqual(30)
  })
})

describe('waitingAnnouncement', () => {
  it('says where the message went', () => {
    expect(waitingAnnouncement({ id: 'a', text: 'x', kind: 'steer' }, 0)).toBe('sent to the running turn')
    expect(waitingAnnouncement({ id: 'a', text: 'x', kind: 'queued' }, 2)).toBe('queued for after this turn (2 waiting)')
  })
})
