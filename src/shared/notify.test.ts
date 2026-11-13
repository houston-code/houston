import { describe, expect, it } from 'vitest'
import type { AgentEvent } from './agent'
import { attentionSignals, soundFor } from './notify'

const done = (stopReason: 'end_turn' | 'aborted'): AgentEvent => ({ runId: 'r', type: 'done', stopReason })
const approval: AgentEvent = {
  runId: 'r',
  type: 'tool_approval',
  callId: 'c',
  name: 'run_shell',
  summary: 'npm test',
  kind: 'shell'
}

describe('soundFor', () => {
  it('chimes when a turn ends, finished or failed, but not when the user stopped it', () => {
    expect(soundFor(done('end_turn'))).toBe('done')
    expect(soundFor({ runId: 'r', type: 'error', message: 'boom' })).toBe('done')
    expect(soundFor(done('aborted'))).toBeNull()
  })

  it('knocks for everything that blocks on the user', () => {
    expect(soundFor(approval)).toBe('input')
    expect(soundFor({ runId: 'r', type: 'tool_question', callId: 'q', question: 'Which?' } as AgentEvent)).toBe('input')
    expect(soundFor({ runId: 'r', type: 'plan_ready', callId: 'p', plan: { title: 'T', body: 'B' } } as AgentEvent)).toBe(
      'input'
    )
    expect(
      soundFor({ runId: 'r', type: 'elicitation', elicitId: 'e', serverId: 's', message: 'm', fields: [] } as unknown as AgentEvent)
    ).toBe('input')
  })

  it('stays silent for streaming and progress events', () => {
    expect(soundFor({ runId: 'r', type: 'text', delta: 'hi' })).toBeNull()
    expect(soundFor({ runId: 'r', type: 'usage', inputTokens: 1, outputTokens: 1, cost: 0 })).toBeNull()
  })
})

describe('attentionSignals', () => {
  it('plays no sound unless sounds are turned on (they are off by default)', () => {
    expect(attentionSignals(done('end_turn'), {})).toEqual({ notify: true, sound: null })
    expect(attentionSignals(done('end_turn'), { attentionSounds: true })).toEqual({ notify: true, sound: 'done' })
  })

  it('keeps the sound when notifications are off, and the reverse', () => {
    expect(attentionSignals(approval, { desktopNotifications: false, attentionSounds: true })).toEqual({
      notify: false,
      sound: 'input'
    })
    expect(attentionSignals(approval, { desktopNotifications: true, attentionSounds: false })).toEqual({
      notify: true,
      sound: null
    })
  })

  it('is null when neither applies', () => {
    expect(attentionSignals(approval, { desktopNotifications: false })).toBeNull()
    expect(attentionSignals({ runId: 'r', type: 'text', delta: 'x' }, { attentionSounds: true })).toBeNull()
  })
})
