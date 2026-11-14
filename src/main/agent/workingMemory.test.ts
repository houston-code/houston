import { describe, expect, it } from 'vitest'
import { COMPACTION_SUMMARY_PREFIX, systemNoteMessage, type BackgroundShellInfo, type ChatMessage } from '@shared/agent'
import {
  MAX_PINNED_SHELLS,
  PINNED_MEMORY_PREFIX,
  formatWorkspaceState,
  normalizeWorkspaceState,
  pinnedShells,
  buildPinnedMemory,
  buildPinnedMessages,
  filesInPlay,
  lastUserTurnIndex,
  laterUserMessages,
  latestTodos,
  originalTask,
  originalTaskIndex
} from './workingMemory'

const INVOKED = { kind: 'command' as const, label: '/review' }

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

  it('leaves the task out when the caller already sends it verbatim', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Add OAuth login' },
      toolCall('read_file', { path: 'src/auth.ts' })
    ]
    const block = buildPinnedMemory(msgs, { omitTask: true })
    expect(block.startsWith(PINNED_MEMORY_PREFIX)).toBe(true)
    expect(block).not.toContain('Original task:')
    expect(block).not.toContain('Add OAuth login')
    expect(block).toContain('src/auth.ts')
    // With the task left out and nothing else to say, there is no block at all.
    expect(buildPinnedMemory([{ role: 'user', content: 'Just chat' }], { omitTask: true })).toBe('')
    expect(buildPinnedMessages([{ role: 'user', content: 'Just chat' }], { omitTask: true })).toEqual([])
  })

  it('clips a very long task to keep the block bounded', () => {
    const huge = 'x'.repeat(5000)
    const block = buildPinnedMemory([{ role: 'user', content: huge }])
    expect(block.length).toBeLessThan(huge.length)
    expect(block).toContain('…')
  })
})

describe("the user's later messages in the pinned block", () => {
  const log: ChatMessage[] = [
    { role: 'user', content: 'Build the importer' },
    { role: 'assistant', content: 'on it' },
    { role: 'user', content: 'use pnpm, not npm' },
    systemNoteMessage('You seem to be repeating yourself.'),
    { role: 'user', content: 'Review this', invokedAs: INVOKED },
    { role: 'user', content: `${COMPACTION_SUMMARY_PREFIX}\n\nold summary` },
    { role: 'user', content: 'also   keep\n\nthe CSV header' },
    { role: 'assistant', content: 'ok' }
  ]

  it("lists every message the user wrote after the task, in order, and none of Houston's", () => {
    expect(laterUserMessages(log)).toEqual(['use pnpm, not npm', 'also   keep\n\nthe CSV header'])
    const block = buildPinnedMemory(log)
    expect(block).toContain("The user's later messages, in order (clipped):\n- use pnpm, not npm\n- also keep the CSV header")
    expect(block).not.toContain('repeating yourself')
    expect(block).not.toContain('Review this')
  })

  it('stops at the given index, so messages still in the window are not repeated', () => {
    expect(laterUserMessages(log, 4)).toEqual(['use pnpm, not npm'])
    expect(buildPinnedMemory(log, { userMessagesBefore: 2 })).not.toContain('later messages')
  })

  it('clips each message and keeps the newest when there are too many', () => {
    const many: ChatMessage[] = [{ role: 'user', content: 'task' }]
    for (let i = 0; i < 40; i++) many.push({ role: 'user', content: `note ${i} ${'x'.repeat(600)}` })
    const block = buildPinnedMemory(many)
    expect(block).toContain('note 39 ')
    expect(block).not.toContain('note 0 ')
    expect(block).toMatch(/- \(\d+ earlier messages not shown\)/)
    expect(block).not.toContain('x'.repeat(450))
    expect(block.length).toBeLessThanOrEqual(9000)
  })
})

describe('workspace state in the pinned block', () => {
  const shell = (over: Partial<BackgroundShellInfo>): BackgroundShellInfo => ({
    id: 'abc12345',
    command: 'npm run dev',
    running: true,
    exitCode: null,
    startedAt: 1,
    exitedAt: null,
    conversationId: 'c1',
    workspace: '/ws',
    ...over
  })
  const label = (dir: string): string | null => (dir === '/ws' ? null : dir.replace('/ws/', ''))

  it('adds branch, shell directory, and running shells after the files', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'Ship it' }, toolCall('read_file', { path: 'a.ts' })]
    const block = buildPinnedMemory(msgs, {
      workspaceState: {
        branch: 'feature/login',
        shellCwd: 'packages/api',
        shells: [{ id: 'abc12345', command: 'npm run dev', status: 'running, http://localhost:5173' }]
      }
    })
    expect(block.indexOf('Files in play')).toBeLessThan(block.indexOf('Workspace state'))
    expect(block).toContain('- Git branch: feature/login')
    expect(block).toContain('- Shell directory: packages/api')
    expect(block).toContain('  - abc12345: npm run dev (running, http://localhost:5173)')
  })

  it('leaves the section out when there is no state, and each line out when absent', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'Ship it' }]
    expect(buildPinnedMemory(msgs)).not.toContain('Workspace state')
    expect(buildPinnedMemory(msgs, { workspaceState: {} })).not.toContain('Workspace state')
    expect(formatWorkspaceState(undefined)).toBe('')
    expect(formatWorkspaceState({ shells: [] })).toBe('')
    const onlyBranch = formatWorkspaceState({ branch: 'main' })
    expect(onlyBranch).toContain('Git branch: main')
    expect(onlyBranch).not.toContain('Shell directory')
    expect(onlyBranch).not.toContain('Background shells')
  })

  it('pins the state on its own once the task is omitted', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'Just chat' }]
    const block = buildPinnedMemory(msgs, { omitTask: true, workspaceState: { branch: 'main' } })
    expect(block.startsWith(PINNED_MEMORY_PREFIX)).toBe(true)
    expect(block).toContain('Git branch: main')
    expect(block).not.toContain('Just chat')
  })

  it('bounds every field and the shell list, and folds control characters', () => {
    const many = Array.from({ length: MAX_PINNED_SHELLS + 4 }, (_, i) => ({
      id: `s${i}`,
      command: `run ${'y'.repeat(500)}`,
      status: 'running'
    }))
    const state = normalizeWorkspaceState({
      branch: 'b'.repeat(500),
      shellCwd: `dir\n${'d'.repeat(500)}`,
      shells: many
    })!
    expect(state.branch!.length).toBeLessThanOrEqual(121)
    expect(state.shellCwd).not.toContain('\n')
    expect(state.shellCwd!.length).toBeLessThanOrEqual(201)
    expect(state.shells).toHaveLength(MAX_PINNED_SHELLS)
    expect(state.shells!.every((s) => s.command.length <= 161)).toBe(true)
    expect(state.moreShells).toBe(1)
    const text = formatWorkspaceState({ ...state, moreShells: 4 })
    expect(text).toContain('and 4 more')
    // Heading, branch, directory, shells heading, the capped shells, the "more" line.
    expect(text.split('\n').length).toBe(4 + MAX_PINNED_SHELLS + 1)
    // The whole pinned block stays capped however large the inputs.
    const block = buildPinnedMemory([{ role: 'user', content: 'x'.repeat(5000) }], { workspaceState: state })
    expect(block.length).toBeLessThanOrEqual(6001)
  })

  it('drops malformed persisted state rather than trusting it', () => {
    expect(normalizeWorkspaceState(null)).toBeUndefined()
    expect(normalizeWorkspaceState('main')).toBeUndefined()
    expect(normalizeWorkspaceState({ branch: 7, shells: 'x' })).toBeUndefined()
    expect(
      normalizeWorkspaceState({ shells: [{ id: 'a', command: 'ls' }, { id: 'b', command: 'dev', status: 'running' }, 5] })
    ).toEqual({ shells: [{ id: 'b', command: 'dev', status: 'running' }] })
    expect(normalizeWorkspaceState({ branch: 'main', moreShells: -3 })).toEqual({ branch: 'main' })
  })

  it("lists only this chat's live shells, newest first, with a short status", () => {
    const { shells, more } = pinnedShells(
      [
        shell({ id: 'old', startedAt: 1 }),
        shell({ id: 'new', startedAt: 5, urls: ['http://localhost:5173'] }),
        shell({ id: 'other-chat', conversationId: 'c2' }),
        shell({ id: 'done', running: false, exitCode: 0, exitedAt: 3 }),
        shell({ id: 'orphan', running: false, exitCode: 0, exitedAt: 3, leftover: true, startedAt: 2 }),
        shell({ id: 'sub', workspace: '/ws/packages/web', startedAt: 0 })
      ],
      'c1',
      label
    )
    expect(more).toBe(0)
    expect(shells).toEqual([
      { id: 'new', command: 'npm run dev', status: 'running, http://localhost:5173' },
      { id: 'orphan', command: 'npm run dev', status: 'exited, left a process running' },
      { id: 'old', command: 'npm run dev', status: 'running' },
      { id: 'sub', command: 'npm run dev', status: 'running', cwd: 'packages/web' }
    ])
    expect(formatWorkspaceState({ shells })).toContain('sub: npm run dev (running; started in packages/web)')
  })

  it('caps the shell list and counts the rest', () => {
    const infos = Array.from({ length: MAX_PINNED_SHELLS + 3 }, (_, i) => shell({ id: `s${i}`, startedAt: i }))
    const { shells, more } = pinnedShells(infos, 'c1', label)
    expect(shells).toHaveLength(MAX_PINNED_SHELLS)
    expect(shells[0].id).toBe(`s${MAX_PINNED_SHELLS + 2}`)
    expect(more).toBe(3)
    expect(pinnedShells(infos, undefined, label)).toEqual({ shells: [], more: 0 })
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

describe('originalTaskIndex', () => {
  it('finds the first user turn, or -1 when there is none', () => {
    expect(
      originalTaskIndex([
        { role: 'assistant', content: 'greeting' },
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' }
      ])
    ).toBe(1)
    expect(originalTaskIndex([{ role: 'assistant', content: 'hi' }])).toBe(-1)
  })

  it('skips the summary /compact wrote into the log: that is not the user\'s task', () => {
    // After /compact the log opens on the summary pair, so the first user message is
    // Houston's summary, not anything the user wrote.
    const summary: ChatMessage[] = [
      { role: 'user', content: `${COMPACTION_SUMMARY_PREFIX}\n\n- The user wanted a CSV exporter; it is done.` },
      { role: 'assistant', content: 'Understood.' }
    ]
    const msgs: ChatMessage[] = [
      ...summary,
      { role: 'user', content: 'Now add a JSON exporter' },
      toolCall('read_file', { path: 'src/export.ts' }),
      { role: 'tool', content: 'contents', toolCallId: 'c-read_file', toolName: 'read_file' },
      { role: 'assistant', content: 'done' }
    ]
    expect(originalTaskIndex(msgs)).toBe(2)
    expect(originalTask(msgs)).toBe('Now add a JSON exporter')

    const block = buildPinnedMemory(msgs)
    expect(block).toContain('Original task:\nNow add a JSON exporter')
    expect(block).not.toContain(COMPACTION_SUMMARY_PREFIX)
    expect(block).not.toContain('CSV exporter')

    // A log that is nothing but the summary has no task of the user's to pin.
    expect(originalTaskIndex(summary)).toBe(-1)
    expect(buildPinnedMemory(summary)).toBe('')
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
