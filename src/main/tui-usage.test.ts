import { describe, it, expect } from 'vitest'
import { buildUsageReport, type UsageInput } from '@shared/usageReport'
import { renderUsageReport, usageDayLabel } from './tui-usage'
import type { Painter } from './tui'

const plain: Painter = (s) => s
const NOW = new Date(2026, 10, 13, 15) // Fri Nov 13 2026, local time

function reply(at: Date, cost: number, inputTokens: number, outputTokens: number) {
  return { role: 'assistant' as const, at: at.getTime(), usage: { cost, inputTokens, outputTokens } }
}

function chat(project: string, replies: ReturnType<typeof reply>[], undatedCost = 0): UsageInput {
  const cost = replies.reduce((n, r) => n + r.usage.cost, 0) + undatedCost
  const out = replies.reduce((n, r) => n + r.usage.outputTokens, 0)
  const inp = replies.reduce((n, r) => n + r.usage.inputTokens, 0)
  return {
    project,
    messages: replies,
    usage: { cost, outputTokens: out, inputTokens: inp, perModel: [{ model: 'm', inputTokens: inp, outputTokens: out, cost }] }
  } as unknown as UsageInput
}

const day = (offset: number): Date => new Date(2026, 10, 13 - offset, 10)

describe('usageDayLabel', () => {
  it('names the weekday, month and day', () => {
    expect(usageDayLabel('2026-11-13')).toBe('Fri Nov 13')
    expect(usageDayLabel('2026-11-02')).toBe('Mon Nov  2')
  })
})

describe('renderUsageReport', () => {
  it('says so when nothing was spent', () => {
    expect(renderUsageReport(buildUsageReport([], NOW), plain)).toContain('No spend recorded yet.')
  })

  it('shows the last 7 days, the top projects, and the totals', () => {
    const report = buildUsageReport(
      [
        chat('/work/houston', [reply(day(0), 1.5, 12_000, 3_000), reply(day(2), 0.25, 1_000, 500)]),
        chat('/work/site', [reply(day(10), 2, 5_000, 1_000)], 0.5)
      ],
      NOW
    )
    const text = renderUsageReport(report, plain)
    const lines = text.split('\n')
    // Seven day rows, oldest first, ending today.
    const dayRows = lines.filter((l) => /^ {2}(Sun|Mon|Tue|Wed|Thu|Fri|Sat) /.test(l))
    expect(dayRows).toHaveLength(7)
    expect(dayRows[0]).toContain('Sat Nov  7')
    expect(dayRows[6]).toMatch(/Fri Nov 13\s+\$1\.50\s+1\s+12k\s+3k$/)
    expect(dayRows[4]).toMatch(/Wed Nov 11\s+\$0\.250\s+1\s+1k\s+500$/)
    expect(dayRows[5]).toMatch(/Thu Nov 12\s+–$/)
    // Projects, most expensive first; the 10-day-old spend shows here and in 30 days, not in 7.
    const site = lines.findIndex((l) => l.trimStart().startsWith('site'))
    const houston = lines.findIndex((l) => l.trimStart().startsWith('houston'))
    expect(site).toBeGreaterThan(0)
    expect(site).toBeLessThan(houston)
    expect(text).toContain('Last 7 days: $1.75  (13k in, 3.5k out)')
    expect(text).toContain('Last 30 days: $3.75')
    expect(text).toContain('All time: $4.25  (18k in, 4.5k out), 2 chats')
    expect(text).toContain('$0.500 and 0 output tokens came from subagents')
  })

  it('lists at most five projects and counts the rest', () => {
    const chats = Array.from({ length: 7 }, (_, i) => chat(`/p/proj${i}`, [reply(day(0), i + 1, 10, 10)]))
    const text = renderUsageReport(buildUsageReport(chats, NOW), plain)
    expect(text).toContain('proj6')
    expect(text).not.toContain('proj1 ')
    expect(text).toContain('…and 2 more projects')
  })

  it('strips control characters from project names', () => {
    const text = renderUsageReport(buildUsageReport([chat('/p/\x1b[31mevil', [reply(day(0), 1, 1, 1)])], NOW), plain)
    expect(text).not.toContain('\x1b[31m')
  })
})
