import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/agent'
import { INTERRUPTED_TOOL_RESULT, missingToolResults, repairDanglingToolResults } from './repair'

const user = (content: string): ChatMessage => ({ role: 'user', content })
const assistant = (content: string, toolCalls?: ChatMessage['toolCalls']): ChatMessage => ({
  role: 'assistant',
  content,
  ...(toolCalls ? { toolCalls } : {})
})
const toolCall = (id: string, name = 'web_fetch'): NonNullable<ChatMessage['toolCalls']>[number] => ({
  id,
  name,
  arguments: {}
})
const toolResult = (toolCallId: string, name = 'web_fetch'): ChatMessage => ({
  role: 'tool',
  content: 'ok',
  toolCallId,
  toolName: name
})

describe('missingToolResults', () => {
  it('returns nothing for an empty log', () => {
    expect(missingToolResults([])).toEqual([])
  })

  it('returns nothing when the last assistant turn made no tool calls', () => {
    const messages = [user('hi'), assistant('hello')]
    expect(missingToolResults(messages)).toEqual([])
  })

  it('returns nothing when every tool call is already answered', () => {
    const messages = [
      user('go'),
      assistant('working', [toolCall('a'), toolCall('b')]),
      toolResult('a'),
      toolResult('b'),
      assistant('done')
    ]
    expect(missingToolResults(messages)).toEqual([])
  })

  it('backfills every dangling call when a turn is interrupted with no results', () => {
    const messages = [
      user('compare the apps'),
      assistant('fetching', [toolCall('t1', 'web_fetch'), toolCall('t2', 'web_fetch')])
    ]
    const fill = missingToolResults(messages)
    expect(fill).toEqual([
      { role: 'tool', content: INTERRUPTED_TOOL_RESULT, toolCallId: 't1', toolName: 'web_fetch' },
      { role: 'tool', content: INTERRUPTED_TOOL_RESULT, toolCallId: 't2', toolName: 'web_fetch' }
    ])
  })

  it('backfills only the unanswered calls (partial interruption mid-sequence)', () => {
    // e.g. Stop after the first call was denied but before the second ran.
    const messages = [
      user('go'),
      assistant('working', [toolCall('a'), toolCall('b')]),
      toolResult('a')
    ]
    const fill = missingToolResults(messages)
    expect(fill).toHaveLength(1)
    expect(fill[0].toolCallId).toBe('b')
    expect(fill[0].content).toBe(INTERRUPTED_TOOL_RESULT)
  })

  it('only repairs the final tool-calling turn, leaving earlier balanced turns alone', () => {
    const messages = [
      user('first'),
      assistant('a', [toolCall('x')]),
      toolResult('x'),
      assistant('answer'),
      user('second'),
      assistant('b', [toolCall('y')])
    ]
    const fill = missingToolResults(messages)
    expect(fill).toHaveLength(1)
    expect(fill[0].toolCallId).toBe('y')
  })

  it('carries the original tool name onto the placeholder', () => {
    const messages = [user('go'), assistant('', [toolCall('c', 'run_shell')])]
    expect(missingToolResults(messages)[0].toolName).toBe('run_shell')
  })
})

describe('repairDanglingToolResults', () => {
  const roles = (ms: ChatMessage[]): string[] =>
    ms.map((m) => (m.role === 'tool' ? `tool(${m.toolCallId})` : m.role))

  it('returns the same array reference when the log is already balanced', () => {
    const messages = [
      user('go'),
      assistant('working', [toolCall('a')]),
      toolResult('a'),
      assistant('done')
    ]
    expect(repairDanglingToolResults(messages)).toBe(messages)
  })

  it('inserts a placeholder immediately after a trailing dangling call', () => {
    const messages = [user('go'), assistant('', [toolCall('p1', 'present_plan')])]
    const out = repairDanglingToolResults(messages)
    expect(roles(out)).toEqual(['user', 'assistant', 'tool(p1)'])
    expect(out[2].content).toBe(INTERRUPTED_TOOL_RESULT)
  })

  it('inserts the placeholder BEFORE a user turn that was sent after the dangling call', () => {
    // The exact present_plan bug: the app quit while the plan was pending, the user
    // re-sent a message, and a tail-append would drop the placeholder after it.
    const messages = [
      user('plan it'),
      assistant('', [toolCall('p1', 'present_plan')]),
      user('resurface the plan again please')
    ]
    const out = repairDanglingToolResults(messages)
    expect(roles(out)).toEqual(['user', 'assistant', 'tool(p1)', 'user'])
    expect(out[2].content).toBe(INTERRUPTED_TOOL_RESULT)
    // No dangling calls remain in the trailing turn.
    expect(missingToolResults(out)).toEqual([])
  })

  it('pulls a displaced result back up to follow its tool_use (heals a corrupted log)', () => {
    // A log a prior tail-append already broke: result stranded after the user turn.
    const messages = [
      user('plan it'),
      assistant('', [toolCall('p1', 'present_plan')]),
      user('resurface the plan again please'),
      toolResult('p1', 'present_plan') // displaced — not immediately after its use
    ]
    const out = repairDanglingToolResults(messages)
    expect(roles(out)).toEqual(['user', 'assistant', 'tool(p1)', 'user'])
    // The real (non-placeholder) result was moved, not duplicated.
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(1)
    expect(out[2].content).toBe('ok')
  })

  it('repairs a dangling call in a NON-trailing turn (unlike missingToolResults)', () => {
    const messages = [
      user('first'),
      assistant('', [toolCall('a', 'ask_user')]),
      user('second'),
      assistant('done')
    ]
    const out = repairDanglingToolResults(messages)
    expect(roles(out)).toEqual(['user', 'assistant', 'tool(a)', 'user', 'assistant'])
    expect(out[2].content).toBe(INTERRUPTED_TOOL_RESULT)
  })
})
