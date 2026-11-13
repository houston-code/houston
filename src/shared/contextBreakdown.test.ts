import { describe, expect, it } from 'vitest'
import type { ContextParts } from './agent'
import { contextEstimate, contextRows, contextShare, renderContextReport } from './contextBreakdown'

const parts: ContextParts = {
  system: 4000,
  tools: 5000,
  instructions: 1000,
  memory: 200,
  conversation: 6000,
  toolResults: 3800
}

describe('context breakdown', () => {
  it('lists every part in a fixed order with plain labels', () => {
    expect(contextRows(parts).map((r) => [r.label, r.tokens])).toEqual([
      ["Houston's instructions", 4000],
      ['Tool definitions', 5000],
      ['Project instructions', 1000],
      ['Memories', 200],
      ['Conversation', 6000],
      ['Tool results', 3800]
    ])
    expect(contextEstimate(parts)).toBe(20_000)
    expect(contextShare(5000, 20_000)).toBe(25)
    expect(contextShare(5, 0)).toBe(0)
  })

  it('renders the terminal report against the measured total and the window', () => {
    const out = renderContextReport(parts, 21_000, 200_000)
    expect(out).toContain('What fills the context window (approximate):')
    expect(out).toMatch(/Tool definitions\s+~\s*5k\s+25%/)
    expect(out).toMatch(/Total\s+21k of 200k \(11%\)/)
    expect(out).toContain('approximate')
  })

  it('falls back to the estimate when the provider measured nothing, marked as approximate', () => {
    expect(renderContextReport(parts, 0, null)).toMatch(/Total\s+~\s*20k$/m)
  })

  it('says what to do when nothing has run yet', () => {
    expect(renderContextReport(null, 0, null)).toContain('send a message')
  })
})
