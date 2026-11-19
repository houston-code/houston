import { describe, expect, it } from 'vitest'
import type { ChatStatusMap, PendingPrompt } from '@shared/chatStatus'
import { arrivedPrompts, waitingToastText } from './otherChatPrompts'

const waiting = (...pending: PendingPrompt[]): ChatStatusMap[string] => ({ running: true, pending })
const approve: PendingPrompt = { kind: 'approval', label: 'Run npm test' }

describe('arrivedPrompts', () => {
  it('reports a prompt that just started blocking another chat', () => {
    expect(arrivedPrompts({ a: waiting() }, { a: waiting(approve) }, 'b')).toEqual([{ id: 'a', prompt: approve }])
  })

  it('ignores the open chat, which shows its own prompts', () => {
    expect(arrivedPrompts({}, { a: waiting(approve) }, 'a')).toEqual([])
  })

  it('does not repeat a prompt that was already waiting', () => {
    expect(arrivedPrompts({ a: waiting(approve) }, { a: waiting(approve) }, null)).toEqual([])
  })

  it('reports a follow-up prompt that replaces an answered one', () => {
    const next: PendingPrompt = { kind: 'approval', label: 'Run npm run lint' }
    expect(arrivedPrompts({ a: waiting(approve) }, { a: waiting(next) }, null)).toEqual([{ id: 'a', prompt: next }])
  })

  it('stays quiet when a chat stops waiting or finishes', () => {
    expect(arrivedPrompts({ a: waiting(approve) }, { a: waiting() }, null)).toEqual([])
    expect(arrivedPrompts({ a: waiting(approve) }, {}, null)).toEqual([])
  })
})

describe('waitingToastText', () => {
  it('says what the chat is waiting for', () => {
    expect(waitingToastText('Fix login', approve)).toBe('Fix login needs your approval: Run npm test')
    expect(waitingToastText('Fix login', { kind: 'approval' })).toBe('Fix login needs your approval')
    expect(waitingToastText('Fix login', { kind: 'question' })).toBe('Fix login has a question for you')
    expect(waitingToastText('Fix login', { kind: 'plan', label: 'Plan' })).toBe('Fix login has a plan for you to review')
    expect(waitingToastText('Fix login', { kind: 'elicitation', label: 'github' })).toBe(
      'Fix login needs your input for github'
    )
  })

  it('names an untitled chat generically', () => {
    expect(waitingToastText('  ', { kind: 'question' })).toBe('Another chat has a question for you')
  })
})
