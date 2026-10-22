import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/agent'
import { SUBAGENT_CAPS } from '@shared/subagents'
import { SubagentRecorder, type RecorderEvent } from './subagentRecorder'

type Ev = Extract<AgentEvent, { type: 'subagent_start' | 'subagent_step' | 'subagent_end' }>

function setup(): { rec: SubagentRecorder; events: RecorderEvent[] } {
  const events: RecorderEvent[] = []
  let t = 1000
  const rec = new SubagentRecorder(
    (e) => events.push(e),
    (s) => s.replaceAll('SECRET', '[redacted]'),
    (_model, u) => (u.input + u.output) / 1_000_000,
    () => (t += 500)
  )
  return { rec, events }
}

const start = {
  kind: 'research' as const,
  label: 'Trace',
  model: 'm',
  modelSource: 'run' as const,
  prompt: 'find SECRET',
  systemPrompt: 'You are SECRET',
  tools: ['read_file']
}

describe('SubagentRecorder', () => {
  it('streams a record from start to end and hands it over once', () => {
    const { rec, events } = setup()
    const h = rec.start('call1', start)
    h.step({ index: 0, turn: 1, kind: 'tool', tool: 'read_file', summary: 'Read a', startedAt: 1 })
    h.step({ index: 0, turn: 1, kind: 'tool', tool: 'read_file', summary: 'Read a', ok: true, hint: '3 lines', output: 'x SECRET' })
    h.usage({ inputTokens: 1000, outputTokens: 200 })
    h.end({ status: 'done', report: 'report with SECRET', resumeId: 'ag1', budget: { used: 2, limit: 40, ceiling: 200 } })

    expect(events.map((e) => e.type)).toEqual(['subagent_start', 'subagent_step', 'subagent_step', 'subagent_end'])
    const first = events[0] as Extract<Ev, { type: 'subagent_start' }>
    expect(first.record.prompt).toBe('find [redacted]')
    expect(first.record.systemPrompt).toBe('You are [redacted]')
    const end = events[3] as Extract<Ev, { type: 'subagent_end' }>
    expect(end.update).toMatchObject({ status: 'done', report: 'report with [redacted]', resumeId: 'ag1' })
    expect(end.update.usage).toEqual({ input: 1000, output: 200, costUsd: 0.0012 })

    const saved = rec.take('call1')!
    expect(saved).toHaveLength(1)
    expect(saved[0].steps).toHaveLength(1)
    expect(saved[0].steps[0]).toMatchObject({ ok: true, output: 'x [redacted]' })
    expect(saved[0].endedAt! - saved[0].startedAt).toBeGreaterThan(0)
    expect(rec.take('call1')).toBeUndefined()
  })

  it('redacts the text of a write’s diff', () => {
    const { rec } = setup()
    const h = rec.start('c', start)
    h.step({
      index: 0,
      turn: 1,
      kind: 'tool',
      tool: 'write_file',
      summary: 'Write .env',
      ok: true,
      preview: [{ path: '.env', diff: [{ type: 'add', text: 'KEY=SECRET' }] }]
    })
    expect(rec.take('c')![0].steps[0].preview![0].diff[0].text).toBe('KEY=[redacted]')
  })

  it('ignores steps after the end and a second end', () => {
    const { rec, events } = setup()
    const h = rec.start('c', start)
    h.end({ status: 'aborted' })
    h.step({ index: 0, turn: 1, kind: 'notice', summary: 'late' })
    h.end({ status: 'done' })
    expect(events.filter((e) => e.type === 'subagent_end')).toHaveLength(1)
    expect(rec.take('c')![0].steps).toEqual([])
  })

  it('points the parent’s dispatching step at a nested child', () => {
    const { rec, events } = setup()
    const parent = rec.start('c', start)
    parent.step({ index: 4, turn: 2, kind: 'tool', tool: 'dispatch_agent', summary: 'Subagent: x' })
    const child = rec.start('c', { ...start, label: 'Inner', parentId: parent.id, parentStep: 4 })
    const saved = rec.take('c')!
    expect(saved.find((r) => r.id === child.id)?.parentId).toBe(parent.id)
    expect(saved.find((r) => r.id === parent.id)?.steps[0].childId).toBe(child.id)
    expect(events.some((e) => e.type === 'subagent_step' && e.step.childId === child.id)).toBe(true)
  })

  it('clips oversized text and keeps the step list within its cap', () => {
    const { rec } = setup()
    const h = rec.start('c', { ...start, prompt: 'p'.repeat(SUBAGENT_CAPS.prompt + 50) })
    for (let i = 0; i < SUBAGENT_CAPS.steps + 10; i++) {
      h.step({ index: i, turn: i + 1, kind: 'tool', summary: 's'.repeat(1000), output: 'o'.repeat(5000), ok: true })
    }
    const r = rec.take('c')![0]
    expect(r.prompt.length).toBe(SUBAGENT_CAPS.prompt + 1)
    expect(r.steps).toHaveLength(SUBAGENT_CAPS.steps)
    expect(r.stepsOmitted).toBe(10)
    expect(r.steps[0].summary.length).toBe(SUBAGENT_CAPS.stepSummary + 1)
    expect(r.steps[0].output!.length).toBe(SUBAGENT_CAPS.stepOutput + 1)
  })
})
