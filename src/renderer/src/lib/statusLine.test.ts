import { describe, it, expect } from 'vitest'
import { statusText } from './statusLine'
import type { DisplayItem } from './items'

const tool = (status: string, name = 'edit_file', id = 'c'): DisplayItem =>
  ({ kind: 'tool', id, name, status }) as unknown as DisplayItem
const user: DisplayItem = { kind: 'user', id: 'u', text: 'go' }

describe('statusText', () => {
  it('is Ready when not running', () => {
    expect(statusText([], false)).toBe('Ready')
  })

  it('reports a running tool', () => {
    expect(statusText([tool('running')], true)).toBe('Running edit_file')
  })

  it('reports awaiting approval', () => {
    expect(statusText([tool('awaiting-approval')], true)).toBe('Waiting for your approval: edit_file')
  })

  it('reports an approval that is not the last row of the turn', () => {
    // A parallel batch: the approval card sits above a read that already started.
    const items = [user, tool('awaiting-approval', 'run_shell', 'a'), tool('running', 'read_file', 'b')]
    expect(statusText(items, true)).toBe('Waiting for your approval: run_shell')
  })

  it('reports an unanswered question as waiting on the user', () => {
    const q = { kind: 'question', id: 'q', question: 'Which db?', options: [] } as DisplayItem
    expect(statusText([user, q], true)).toBe('Waiting for your answer')
  })

  it('stops reporting a question once it is answered', () => {
    const q = { kind: 'question', id: 'q', question: 'Which db?', options: [], answer: 'Postgres' } as DisplayItem
    expect(statusText([user, q], true)).toBe('Working…')
  })

  it('reports a pending plan as waiting for review', () => {
    const plan = { kind: 'plan', id: 'p', plan: { title: 'Plan' }, status: 'pending' } as DisplayItem
    expect(statusText([user, plan], true)).toBe('Waiting for you to review the plan')
  })

  it('reports an open MCP input form as waiting on the user', () => {
    const form = { kind: 'elicitation', id: 'e', serverId: 's', message: 'm', fields: [] } as DisplayItem
    expect(statusText([user, form], true)).toBe('Waiting for your input')
  })

  it('ignores prompts from earlier turns', () => {
    const q = { kind: 'question', id: 'q', question: 'Which db?', options: [] } as DisplayItem
    expect(statusText([q, user], true)).toBe('Working…')
  })

  it('reports responding while the assistant streams', () => {
    const item = { kind: 'assistant', id: 'a', text: 'hi', streaming: true } as DisplayItem
    expect(statusText([item], true)).toBe('Responding…')
  })

  it('falls back to Working… otherwise', () => {
    expect(statusText([user], true)).toBe('Working…')
  })
})
