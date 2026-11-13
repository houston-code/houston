import { describe, expect, it } from 'vitest'
import { buildUsageReport, localDate, type UsageInput } from './usageReport'

const NOW = new Date(2026, 10, 13, 15, 0) // Nov 13, local time
const at = (day: number, hour = 10): string => new Date(2026, 10, day, hour).toISOString()
const reply = (day: number, cost: number, outputTokens: number, inputTokens = 1000) => ({
  role: 'assistant' as const,
  at: at(day),
  usage: { inputTokens, outputTokens, cost }
})

describe('buildUsageReport', () => {
  it('fills every day of the window, oldest first, and sums dated replies into them', () => {
    const r = buildUsageReport(
      [
        {
          project: '/code/app',
          messages: [{ role: 'user', at: at(12) }, reply(12, 0.1, 100), reply(13, 0.2, 200), reply(13, 0.05, 50)],
          usage: { inputTokens: 900, outputTokens: 350, cost: 0.35 }
        }
      ],
      NOW,
      7
    )
    expect(r.days.map((d) => d.date)).toEqual([7, 8, 9, 10, 11, 12, 13].map((d) => localDate(new Date(2026, 10, d))))
    expect(r.days.at(-1)).toMatchObject({ replies: 2, outputTokens: 250, inputTokens: 2000 })
    expect(r.days.at(-1)?.cost).toBeCloseTo(0.25)
    expect(r.days.at(-2)).toMatchObject({ replies: 1, outputTokens: 100 })
    expect(r.recent.cost).toBeCloseTo(0.35)
    expect(r.undated).toEqual({ cost: 0, outputTokens: 0 })
  })

  it('leaves replies outside the window out of the days, but not out of all time', () => {
    const r = buildUsageReport(
      [{ project: '/p', messages: [reply(1, 1, 10)], usage: { inputTokens: 0, outputTokens: 10, cost: 1 } }],
      NOW,
      7
    )
    expect(r.recent.cost).toBe(0)
    expect(r.allTime.cost).toBe(1)
  })

  it('groups chats by project, worktrees under their repository, most expensive first', () => {
    const chat = (project: string, cost: number): UsageInput => ({
      project,
      messages: [reply(13, cost, 10)],
      usage: { inputTokens: 0, outputTokens: 10, cost, perModel: [{ model: 'm', inputTokens: 500, outputTokens: 10, cost, cacheReadTokens: 0, cacheWriteTokens: 0 }] }
    })
    const r = buildUsageReport([chat('/code/a', 0.1), chat('/code/b', 2), chat('/code/a', 0.4)], NOW)
    expect(r.projects.map((p) => [p.name, p.chats])).toEqual([
      ['b', 1],
      ['a', 2]
    ])
    expect(r.projects[1].cost).toBeCloseTo(0.5)
    expect(r.projects[1].inputTokens).toBe(1000)
    expect(r.allTime.chats).toBe(3)
  })

  it('counts subagent spend and older chats as undated, in projects but not in days', () => {
    const r = buildUsageReport(
      [
        // $1 billed to the chat, of which only $0.25 sits on a dated reply (the rest: a subagent).
        { project: '/p', messages: [reply(13, 0.25, 100)], usage: { inputTokens: 0, outputTokens: 400, cost: 1 } },
        // A chat from before replies recorded usage.
        { project: '/q', messages: [{ role: 'assistant' }], usage: { inputTokens: 0, outputTokens: 50, cost: 0.5 } }
      ],
      NOW
    )
    expect(r.undated.cost).toBeCloseTo(1.25)
    expect(r.undated.outputTokens).toBe(350)
    expect(r.recent.cost).toBeCloseTo(0.25)
    expect(r.allTime.cost).toBeCloseTo(1.5)
  })

  it("never counts a fork's copied history as its own spend", () => {
    const r = buildUsageReport(
      [{ project: '/p', messages: [reply(13, 3, 100), reply(13, 0.1, 10)], inherited: 1, usage: { inputTokens: 0, outputTokens: 10, cost: 0.1 } }],
      NOW
    )
    expect(r.recent.cost).toBeCloseTo(0.1)
    expect(r.allTime.cost).toBeCloseTo(0.1)
  })

  it('skips chats that never used a model, and replies with a bad timestamp', () => {
    const r = buildUsageReport(
      [
        { project: '/idle', messages: [{ role: 'user' }] },
        { project: '/p', messages: [{ role: 'assistant', at: 'not a date', usage: { inputTokens: 1, outputTokens: 5, cost: 0 } }] }
      ],
      NOW
    )
    expect(r.projects.map((p) => p.name)).toEqual(['p'])
    expect(r.days.every((d) => d.replies === 0)).toBe(true)
    expect(r.undated.outputTokens).toBe(0)
  })
})
