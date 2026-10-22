import { describe, expect, it } from 'vitest'
import type { ChatMessage } from './agent'
import {
  chatSignal,
  pendingReason,
  signalLabel,
  rendersAsReply,
  replyMessageIndexes,
  signalReason,
  statusSignal,
  strongestSignal,
  SIGNAL_PRIORITY,
  type ChatLiveStatus
} from './chatStatus'

const running: ChatLiveStatus = { running: true, pending: [] }
const blocked: ChatLiveStatus = { running: true, pending: [{ kind: 'approval', label: 'run_shell' }] }

describe('chatSignal', () => {
  it('is idle with nothing live and nothing unread', () => {
    expect(chatSignal(undefined)).toBe('idle')
    expect(chatSignal({ running: false, pending: [] })).toBe('idle')
  })

  it('ranks needs-input above everything, even on the open chat', () => {
    expect(chatSignal(blocked, { failed: true, unread: true })).toBe('input')
    expect(chatSignal(blocked, { active: true })).toBe('input')
  })

  it('ranks failed above working and unread, but never on the open chat', () => {
    expect(chatSignal(running, { failed: true, unread: true })).toBe('error')
    expect(chatSignal(undefined, { failed: true })).toBe('error')
    expect(chatSignal(undefined, { failed: true, active: true })).toBe('idle')
    expect(chatSignal(running, { failed: true, active: true })).toBe('working')
  })

  it('shows working over unread, and working on the open chat too', () => {
    expect(chatSignal(running, { unread: true })).toBe('working')
    expect(chatSignal(running, { active: true })).toBe('working')
  })

  it('shows unread only when the chat is not open', () => {
    expect(chatSignal(undefined, { unread: true })).toBe('unread')
    expect(chatSignal(undefined, { unread: true, active: true })).toBe('idle')
  })
})

describe('strongestSignal', () => {
  it('returns idle for nothing', () => {
    expect(strongestSignal([])).toBe('idle')
  })

  it('picks the highest-priority signal present', () => {
    expect(strongestSignal(['unread', 'working'])).toBe('working')
    expect(strongestSignal(['working', 'error', 'unread'])).toBe('error')
    expect(strongestSignal(['idle', 'unread', 'input', 'error'])).toBe('input')
  })

  it('follows SIGNAL_PRIORITY for every pair', () => {
    for (const [i, a] of SIGNAL_PRIORITY.entries())
      for (const b of SIGNAL_PRIORITY.slice(i)) expect(strongestSignal([b, a])).toBe(a)
  })
})

describe('pendingReason', () => {
  it('is undefined when nothing is pending', () => {
    expect(pendingReason([])).toBeUndefined()
  })

  it('names a single prompt by kind', () => {
    expect(pendingReason([{ kind: 'approval', label: 'run_shell' }])).toBe('Needs approval: run_shell')
    expect(pendingReason([{ kind: 'approval' }])).toBe('Needs approval')
    expect(pendingReason([{ kind: 'question' }])).toBe('Has a question')
    expect(pendingReason([{ kind: 'plan', label: 'Docs IA' }])).toBe('Plan ready for review')
    expect(pendingReason([{ kind: 'elicitation', label: 'linear' }])).toBe('linear is asking for input')
    expect(pendingReason([{ kind: 'elicitation' }])).toBe('Server is asking for input')
  })

  it('counts several prompts of one kind', () => {
    expect(pendingReason([{ kind: 'approval', label: 'a' }, { kind: 'approval', label: 'b' }])).toBe(
      '2 approvals waiting'
    )
    expect(pendingReason([{ kind: 'question' }, { kind: 'question' }])).toBe('2 questions waiting')
    expect(pendingReason([{ kind: 'elicitation' }, { kind: 'elicitation' }])).toBe('2 input requests waiting')
  })

  it('totals a mix of kinds', () => {
    expect(pendingReason([{ kind: 'approval' }, { kind: 'question' }, { kind: 'plan' }])).toBe(
      '3 prompts waiting'
    )
  })
})

describe('signalLabel', () => {
  it('names every visible signal and leaves idle unlabeled', () => {
    expect(signalLabel('input')).toBe('Needs input')
    expect(signalLabel('error')).toBe('Failed')
    expect(signalLabel('working')).toBe('Working')
    expect(signalLabel('unread')).toBe('Unread')
    expect(signalLabel('idle')).toBeUndefined()
  })
})

describe('statusSignal and signalReason', () => {
  const unread = (outcome: 'done' | 'limit' | 'error' | 'manual', note?: string) => ({
    running: false,
    pending: [],
    unread: { since: 1, outcome, ...(note ? { note } : {}) }
  })

  it('reads failed and unread from the unread mark', () => {
    expect(statusSignal(unread('error'), false)).toBe('error')
    expect(statusSignal(unread('done'), false)).toBe('unread')
    expect(statusSignal(unread('done'), true)).toBe('idle')
    expect(statusSignal(undefined, false)).toBe('idle')
  })

  it('describes each outcome', () => {
    expect(signalReason(unread('error', 'boom'), 'error')).toBe('Failed: boom')
    expect(signalReason(unread('error'), 'error')).toBe('Failed')
    expect(signalReason(unread('limit'), 'unread')).toBe('Stopped at step limit')
    expect(signalReason(unread('limit', 'Stopped: no progress'), 'unread')).toBe('Stopped: no progress')
    expect(signalReason(unread('manual'), 'unread')).toBe('Marked unread')
    expect(signalReason(unread('done'), 'unread')).toBe('Finished')
    expect(signalReason(unread('done', 'Opened PR #4'), 'unread')).toBe('Opened PR #4')
  })

  it('has no reason for working or idle, and names the prompt for input', () => {
    expect(signalReason({ running: true, pending: [] }, 'working')).toBeUndefined()
    expect(signalReason(unread('done'), 'idle')).toBeUndefined()
    expect(signalReason({ running: true, pending: [{ kind: 'question' }] }, 'input')).toBe('Has a question')
  })
})

describe('replies', () => {
  it('counts text and reasoning-only assistant messages, not empty tool-call ones', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'assistant', content: '  ', toolCalls: [{ id: 't', name: 'x', arguments: {} }] },
      { role: 'tool', content: 'ok', toolCallId: 't' },
      { role: 'assistant', content: '', reasoning: [{ text: 'thinking' }] },
      { role: 'assistant', content: '', reasoning: [{ text: '' }] }
    ]
    expect(messages.map(rendersAsReply)).toEqual([false, true, false, false, true, false])
    expect(replyMessageIndexes(messages)).toEqual([1, 4])
    expect(replyMessageIndexes([])).toEqual([])
  })
})
