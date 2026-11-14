import { describe, expect, it } from 'vitest'
import type { ContextParts } from './agent'
import { contextEstimate, contextRows, contextShare, priceTierNote, renderContextReport } from './contextBreakdown'

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

  it('notes the long-context price tier, and says when a request crossed it', () => {
    expect(priceTierNote(50_000, null)).toBeNull()
    expect(priceTierNote(50_000, 100_000)).toContain('over 100k tokens')
    expect(priceTierNote(50_000, 100_000)).not.toContain('Past')
    expect(priceTierNote(120_000, 100_000)).toMatch(/^Past this model's long-context price tier/)
    expect(renderContextReport(parts, 21_000, 200_000, 20_000)).toContain('Past this model')
    expect(renderContextReport(parts, 21_000, 200_000)).not.toContain('long-context')
  })

  it('says what to do when nothing has run yet', () => {
    expect(renderContextReport(null, 0, null)).toContain('send a message')
  })

  it('shows where automatic compaction kicks in, with or without a breakdown yet', () => {
    const note = 'Compacts automatically at about 100k tokens (your setting: 50% of the window).'
    const report = renderContextReport(parts, 21_000, 200_000, null, note).split('\n')
    expect(report[report.length - 2]).toBe(note)
    expect(renderContextReport(null, 0, null, null, note)).toContain(note)
    expect(renderContextReport(parts, 21_000, 200_000)).not.toContain('Compacts')
  })
})
