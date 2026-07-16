import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/agent'
import {
  PINNED_MEMORY_PREFIX,
  buildPinnedMemory,
  buildPinnedMessages,
  filesInPlay,
  lastUserTurnIndex,
  latestTodos,
  originalTask
} from './workingMemory'

function toolCall(name: string, args: Record<string, unknown>): ChatMessage {
  return { role: 'assistant', content: '', toolCalls: [{ id: `c-${name}`, name, arguments: args }] }
}

describe('originalTask', () => {
  it('returns the first user message, trimmed', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: '  Build a login page  ' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'now add tests' }
    ]
    expect(originalTask(msgs)).toBe('Build a login page')
  })

  it('is empty when there is no user turn', () => {
    expect(originalTask([{ role: 'assistant', content: 'hi' }])).toBe('')
    expect(originalTask([])).toBe('')
  })
})

describe('latestTodos', () => {
  it('recovers the most recent todo_write list', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'go' },
      toolCall('todo_write', { todos: [{ content: 'first', status: 'completed' }] }),
      { role: 'tool', content: 'ok', toolCallId: 'c-todo_write', toolName: 'todo_write' },
      toolCall('todo_write', {
        todos: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'in_progress' }
        ]
      })
    ]
    const todos = latestTodos(msgs)
    expect(todos).toHaveLength(2)
    expect(todos[1]).toEqual({ content: 'b', status: 'in_progress' })
  })

  it('is empty when there is no todo_write and tolerates malformed args', () => {
    expect(latestTodos([{ role: 'user', content: 'x' }])).toEqual([])
    expect(latestTodos([toolCall('todo_write', { todos: 'nope' })])).toEqual([])
  })
})

describe('filesInPlay', () => {
  it('collects file paths from file tools, most recent first and deduped', () => {
    const msgs: ChatMessage[] = [
      toolCall('read_file', { path: 'a.ts' }),
      toolCall('edit_file', { path: 'b.ts' }),
      toolCall('read_file', { path: 'a.ts' }), // dup of a.ts
      toolCall('run_shell', { command: 'ls' }), // not a file tool
      toolCall('write_file', { path: 'c.ts' })
    ]
    expect(filesInPlay(msgs)).toEqual(['c.ts', 'a.ts', 'b.ts'])
  })

  it('honors the max cap', () => {
    const msgs: ChatMessage[] = Array.from({ length: 20 }, (_, i) =>
      toolCall('read_file', { path: `f${i}.ts` })
    )
    expect(filesInPlay(msgs, 3)).toEqual(['f19.ts', 'f18.ts', 'f17.ts'])
  })

  it('extracts every file named by an apply_patch envelope, including a rename destination', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: new.ts',
      '+export const x = 1',
      '*** Delete File: gone.ts',
      '*** Update File: old.ts',
      '*** Move to: renamed.ts',
      ' a',
      '-b',
      '+B',
      '*** End Patch'
    ].join('\n')
    const msgs: ChatMessage[] = [
      toolCall('read_file', { path: 'seed.ts' }),
      toolCall('apply_patch', { patch })
    ]
    // Most recent first: the patch's files (in envelope order) ahead of the earlier read.
    expect(filesInPlay(msgs)).toEqual(['new.ts', 'gone.ts', 'old.ts', 'renamed.ts', 'seed.ts'])
  })

  it('skips an apply_patch call with a missing or malformed patch', () => {
    const msgs: ChatMessage[] = [
      toolCall('apply_patch', { patch: 'not a real patch envelope' }),
      toolCall('apply_patch', {}), // no patch arg
      toolCall('edit_file', { path: 'real.ts' })
    ]
    expect(filesInPlay(msgs)).toEqual(['real.ts'])
  })
})

describe('buildPinnedMemory', () => {
  it('assembles task, todos, and files into a labeled block', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Add OAuth login' },
      toolCall('read_file', { path: 'src/auth.ts' }),
      toolCall('todo_write', { todos: [{ content: 'wire provider', status: 'in_progress' }] })
    ]
    const block = buildPinnedMemory(msgs)
    expect(block.startsWith(PINNED_MEMORY_PREFIX)).toBe(true)
    expect(block).toContain('Original task:')
    expect(block).toContain('Add OAuth login')
    expect(block).toContain('Current todo list:')
    expect(block).toContain('wire provider')
    expect(block).toContain('Files in play')
    expect(block).toContain('src/auth.ts')
  })

  it('omits absent sections and returns empty when there is no task', () => {
    const block = buildPinnedMemory([{ role: 'user', content: 'Just chat' }])
    expect(block).toContain('Original task:')
    expect(block).not.toContain('Current todo list:')
    expect(block).not.toContain('Files in play')

    expect(buildPinnedMemory([])).toBe('')
    expect(buildPinnedMemory([{ role: 'assistant', content: 'hi' }])).toBe('')
  })

  it('clips a very long task to keep the block bounded', () => {
    const huge = 'x'.repeat(5000)
    const block = buildPinnedMemory([{ role: 'user', content: huge }])
    expect(block.length).toBeLessThan(huge.length)
    expect(block).toContain('…')
  })
})

describe('buildPinnedMessages', () => {
  it('returns a user/assistant pair when there is something to pin', () => {
    const pair = buildPinnedMessages([{ role: 'user', content: 'Do the thing' }])
    expect(pair).toHaveLength(2)
    expect(pair[0].role).toBe('user')
    expect(pair[0].content).toContain(PINNED_MEMORY_PREFIX)
    expect(pair[1].role).toBe('assistant')
  })

  it('returns [] when there is nothing to pin', () => {
    expect(buildPinnedMessages([])).toEqual([])
  })
})

describe('lastUserTurnIndex', () => {
  it('finds the final user turn, ignoring the assistant/tool messages after it', () => {
    expect(
      lastUserTurnIndex([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'current' },
        { role: 'assistant', content: 'working' },
        { role: 'tool', content: 'result' }
      ])
    ).toBe(2)
  })

  it('returns -1 when the log has no user turn', () => {
    expect(lastUserTurnIndex([])).toBe(-1)
    expect(lastUserTurnIndex([{ role: 'assistant', content: 'hi' }])).toBe(-1)
  })

  it('is 0 for a first turn, which leaves an empty head and pins nothing', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'only task' }]
    const at = lastUserTurnIndex(messages)
    expect(at).toBe(0)
    expect(buildPinnedMessages(messages.slice(0, at))).toEqual([])
  })

  it('freezes the block for the duration of a turn: the head drives it, not the tail', () => {
    // What the loop passes: everything before the final user turn. Appending the
    // turn's own work (a read_file, whose path would otherwise land in "files in
    // play") must not change the block — that stability is what the provider's
    // prefix cache is matching on across the turn's iterations.
    const head: ChatMessage[] = [
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'answer' }
    ]
    const before = buildPinnedMessages(head)
    const messages: ChatMessage[] = [
      ...head,
      { role: 'user', content: 'current' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'a', name: 'read_file', arguments: { path: 'a.ts' } }]
      },
      { role: 'tool', content: 'contents', toolCallId: 'a', toolName: 'read_file' }
    ]
    expect(buildPinnedMessages(messages.slice(0, lastUserTurnIndex(messages)))).toEqual(before)
    // Derived from the whole log instead, the same block churns — the bug this guards.
    expect(buildPinnedMessages(messages)).not.toEqual(before)
  })
})
