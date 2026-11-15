import { describe, expect, it } from 'vitest'
import type { SubagentSpend } from '@shared/subagents'
import { makePainter } from './tui'
import { MAX_AGENT_ROWS, renderLogFileLine, renderSubagentSpend, renderWhatsNew } from './tui-info'

const paint = makePainter(false)

const agent = (i: number, over: Partial<SubagentSpend> = {}): SubagentSpend => ({
  id: `a${i}`,
  label: `agent ${i}`,
  model: 'claude-haiku',
  input: 1000 * i,
  output: 100 * i,
  costUsd: 0.01 * i,
  ...over
})

describe('renderSubagentSpend', () => {
  it('lists each subagent with its tokens, cost and model, as already counted above', () => {
    const out = renderSubagentSpend([agent(2), agent(1)], paint)
    expect(out).toContain('Subagents (included above):')
    const row = out.split('\n').find((l) => l.includes('agent 2'))!
    expect(row).toContain('+200 tok')
    expect(row).toContain('$0.02')
    // Most expensive first, as given.
    expect(out.indexOf('agent 2')).toBeLessThan(out.indexOf('agent 1'))
    expect(out).toContain('claude-haiku')
  })

  it('sums the rows past the cap into one, as the desktop does', () => {
    const many = Array.from({ length: MAX_AGENT_ROWS + 3 }, (_, i) => agent(i + 1))
    const out = renderSubagentSpend(many, paint)
    expect(out).toContain('3 more subagents')
    expect(out.split('\n')).toHaveLength(1 + MAX_AGENT_ROWS + 1)
  })

  it('prints nothing without subagents, and a dash for no known cost', () => {
    expect(renderSubagentSpend([], paint)).toBe('')
    expect(renderSubagentSpend([agent(1, { costUsd: 0 })], paint)).toContain('–')
  })

  it('never passes escape sequences from a label', () => {
    expect(renderSubagentSpend([agent(1, { label: 'x\u001b[2Jy' })], paint)).not.toContain('\u001b[2J')
  })
})

describe('renderLogFileLine', () => {
  it('prints the log file, or says it could not be found', () => {
    expect(renderLogFileLine('/home/me/.houston/logs/houston.log', paint)).toContain('Log file: /home/me/.houston/logs/houston.log')
    expect(renderLogFileLine('/home/me/.houston/logs/houston.log', paint)).toContain('it can name your folders')
    expect(renderLogFileLine(null, paint)).toContain('could not be found')
  })
})

describe('renderWhatsNew', () => {
  it('names the version and the summary on one line', () => {
    expect(renderWhatsNew({ version: '1.2.0', highlights: 'Adds a thing.\nAnd more.' }, paint)).toBe(
      "What's new in Houston 1.2.0: Adds a thing. And more."
    )
  })
})
