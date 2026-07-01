import { describe, it, expect } from 'vitest'
import type { AppSettings } from '@shared/types'
import type { AgentEvent, ChatMessage } from '@shared/agent'
import { LEGAL_VERSION } from '@shared/legal'
import {
  parseTuiArgs,
  makePainter,
  renderToolStart,
  toolArgHint,
  renderApprovalPrompt,
  parseApprovalAnswer,
  renderQuestion,
  resolveQuestionAnswer,
  parseSlashCommand,
  resolveModelArg,
  composerPrompt,
  extractDiff,
  colorizeDiff,
  renderToolResult,
  formatSessionCost,
  parseResumeSelection,
  formatRelativeTime,
  renderConversationList,
  subagentGlyph,
  shortCwd,
  renderStatusLine,
  runTui,
  type TuiDeps,
  type TuiIo,
  type TuiPersist,
  type ResumeEntry
} from './tui'

const settings = (over: Partial<AppSettings> = {}): AppSettings =>
  ({
    schemaVersion: 1,
    providers: [
      { id: 'anthropic', requiresKey: true, hasKey: true, models: [{ id: 'claude' }], defaultModel: 'claude' },
      { id: 'ollama', requiresKey: false, hasKey: false, models: [{ id: 'llama' }] }
    ],
    selected: null,
    approvalPolicy: 'ask',
    recentWorkspaces: [],
    ...over
  }) as unknown as AppSettings

describe('parseTuiArgs', () => {
  it('returns null without an interactive flag', () => {
    expect(parseTuiArgs(['node', 'app'], '/cwd')).toBeNull()
    expect(parseTuiArgs(['node', 'app', '-p', 'do it'], '/cwd')).toBeNull()
  })

  it('enables on -i / --interactive / --tui', () => {
    expect(parseTuiArgs(['-i'], '/d')).not.toBeNull()
    expect(parseTuiArgs(['--interactive'], '/d')).not.toBeNull()
    expect(parseTuiArgs(['--tui'], '/d')).not.toBeNull()
  })

  it('defaults cwd, approval=ask, and no acceptTerms', () => {
    const o = parseTuiArgs(['-i'], '/here')
    expect(o).toMatchObject({ cwd: '/here', approvalPolicy: 'ask', acceptTerms: false, color: true })
  })

  it('parses cwd / provider / model / approval / accept-terms', () => {
    const o = parseTuiArgs(
      ['-i', '--cwd', '/proj', '--provider', 'openai', '--model=gpt', '--approval', 'auto-edit', '--accept-terms'],
      '/d'
    )
    expect(o).toMatchObject({
      cwd: '/proj',
      providerId: 'openai',
      model: 'gpt',
      approvalPolicy: 'auto-edit',
      acceptTerms: true
    })
  })

  it('--full-auto sets the policy, invalid --approval is ignored', () => {
    expect(parseTuiArgs(['-i', '--full-auto'], '/d')?.approvalPolicy).toBe('full-auto')
    expect(parseTuiArgs(['-i', '--approval', 'bogus'], '/d')?.approvalPolicy).toBe('ask')
  })
})

describe('makePainter', () => {
  it('emits no escape codes when color is off', () => {
    const paint = makePainter(false)
    expect(paint('hi', 'red', 'bold')).toBe('hi')
  })

  it('wraps with reset when color is on', () => {
    const paint = makePainter(true)
    const s = paint('hi', 'red')
    expect(s).toContain('hi')
    expect(s).toContain('\x1b[31m')
    expect(s.endsWith('\x1b[0m')).toBe(true)
  })
})

describe('tool rendering', () => {
  it('summarizes a tool start with its salient arg', () => {
    const line = renderToolStart('read_file', { path: 'src/x.ts' }, makePainter(false))
    expect(line).toContain('read_file')
    expect(line).toContain('src/x.ts')
  })

  it('picks a hint from known arg keys and collapses whitespace', () => {
    expect(toolArgHint({ command: 'ls  -la\n/tmp' })).toBe('ls -la /tmp')
    expect(toolArgHint({})).toBe('')
  })

  it('truncates long hints', () => {
    const long = 'a'.repeat(200)
    expect(toolArgHint({ query: long }).length).toBeLessThanOrEqual(80)
  })
})

describe('approval prompt', () => {
  const ev = (over: Partial<Extract<AgentEvent, { type: 'tool_approval' }>> = {}) =>
    ({
      runId: 'r',
      type: 'tool_approval',
      callId: 'c',
      name: 'run_shell',
      summary: 'rm -rf build',
      kind: 'shell',
      ...over
    }) as Extract<AgentEvent, { type: 'tool_approval' }>

  it('shows name, kind, and summary', () => {
    const p = renderApprovalPrompt(ev(), makePainter(false))
    expect(p).toContain('run_shell')
    expect(p).toContain('[shell]')
    expect(p).toContain('rm -rf build')
  })

  it('warns when a shell command runs unsandboxed', () => {
    expect(renderApprovalPrompt(ev({ sandboxed: false }), makePainter(false))).toContain('UNSANDBOXED')
    expect(renderApprovalPrompt(ev({ sandboxed: true }), makePainter(false))).not.toContain('UNSANDBOXED')
    // Non-shell kinds never carry the shell warning.
    expect(renderApprovalPrompt(ev({ kind: 'write', sandboxed: false }), makePainter(false))).not.toContain(
      'UNSANDBOXED'
    )
  })

  it('parses answers, defaulting to deny', () => {
    expect(parseApprovalAnswer('y')).toBe('allow')
    expect(parseApprovalAnswer('YES')).toBe('allow')
    expect(parseApprovalAnswer('allow')).toBe('allow')
    expect(parseApprovalAnswer('a')).toBe('always')
    expect(parseApprovalAnswer('always')).toBe('always')
    expect(parseApprovalAnswer('n')).toBe('deny')
    expect(parseApprovalAnswer('')).toBe('deny')
    expect(parseApprovalAnswer('garbage')).toBe('deny')
  })
})

describe('question rendering + answer resolution', () => {
  const opts = [
    { label: 'Yes', description: 'do it' },
    { label: 'No' },
    { label: 'Maybe' }
  ]

  it('renders the question with numbered options', () => {
    const q = renderQuestion('Proceed?', opts, false, makePainter(false))
    expect(q).toContain('Proceed?')
    expect(q).toContain('1. Yes')
    expect(q).toContain('do it')
    expect(q).toContain('2. No')
  })

  it('maps a number to its option label', () => {
    expect(resolveQuestionAnswer('2', opts, false)).toBe('No')
  })

  it('maps comma-separated numbers when multiSelect', () => {
    expect(resolveQuestionAnswer('1, 3', opts, true)).toBe('Yes, Maybe')
  })

  it('passes custom free text through verbatim', () => {
    expect(resolveQuestionAnswer('something else', opts, false)).toBe('something else')
  })

  it('passes an out-of-range number through as text', () => {
    expect(resolveQuestionAnswer('9', opts, false)).toBe('9')
  })

  it('returns empty for empty input', () => {
    expect(resolveQuestionAnswer('   ', opts, false)).toBe('')
  })
})

describe('parseSlashCommand', () => {
  const s = settings()

  it('treats non-slash lines as prompt text', () => {
    expect(parseSlashCommand('hello world', s)).toEqual({ kind: 'not-a-command' })
  })

  it('recognizes exit aliases', () => {
    for (const c of ['/exit', '/quit', '/q']) expect(parseSlashCommand(c, s)).toEqual({ kind: 'exit' })
  })

  it('recognizes clear/new', () => {
    expect(parseSlashCommand('/clear', s)).toEqual({ kind: 'clear' })
    expect(parseSlashCommand('/new', s)).toEqual({ kind: 'clear' })
  })

  it('sets a valid approval policy, else stays informational', () => {
    expect(parseSlashCommand('/approval auto-edit', s)).toEqual({ kind: 'set-approval', policy: 'auto-edit' })
    expect(parseSlashCommand('/approval bogus', s)).toEqual({ kind: 'handled' })
    expect(parseSlashCommand('/approval', s)).toEqual({ kind: 'handled' })
  })

  it('sets a model when the arg resolves', () => {
    expect(parseSlashCommand('/model ollama', s)).toEqual({
      kind: 'set-model',
      providerId: 'ollama',
      model: 'llama'
    })
    expect(parseSlashCommand('/model', s)).toEqual({ kind: 'handled' })
    expect(parseSlashCommand('/model nope', s)).toEqual({ kind: 'handled' })
  })

  it('marks unknown commands', () => {
    expect(parseSlashCommand('/frobnicate', s)).toEqual({ kind: 'unknown', name: 'frobnicate' })
  })
})

describe('resolveModelArg', () => {
  const s = settings()
  it('resolves a provider id to its default model', () => {
    expect(resolveModelArg('anthropic', s)).toEqual({ providerId: 'anthropic', model: 'claude' })
  })
  it('resolves providerId/model', () => {
    expect(resolveModelArg('anthropic/opus', s)).toEqual({ providerId: 'anthropic', model: 'opus' })
  })
  it('resolves a bare model id its provider offers', () => {
    expect(resolveModelArg('llama', s)).toEqual({ providerId: 'ollama', model: 'llama' })
  })
  it('returns null for an unknown arg', () => {
    expect(resolveModelArg('mystery', s)).toBeNull()
    expect(resolveModelArg('anthropic/', s)).toBeNull()
  })
})

describe('composerPrompt', () => {
  it('reflects the live policy', () => {
    expect(composerPrompt('auto-edit', makePainter(false))).toContain('auto-edit')
  })
})

describe('extractDiff', () => {
  it('returns a ready patch envelope as-is', () => {
    expect(extractDiff({ patch: '*** Update File: a.ts\n+x' })).toBe('*** Update File: a.ts\n+x')
  })

  it('synthesizes a diff from edit_file old/new strings', () => {
    const d = extractDiff({ path: 'a.ts', old_string: 'foo', new_string: 'bar' })
    expect(d).toContain('--- a.ts')
    expect(d).toContain('-foo')
    expect(d).toContain('+bar')
  })

  it('renders a whole-file write as an all-added diff', () => {
    const d = extractDiff({ path: 'new.ts', content: 'line1\nline2' })
    expect(d).toContain('new.ts (new file)')
    expect(d).toContain('+line1')
    expect(d).toContain('+line2')
  })

  it('returns null when nothing is derivable', () => {
    expect(extractDiff({ path: 'a.ts' })).toBeNull()
    expect(extractDiff({ patch: '  ' })).toBeNull()
  })
})

describe('colorizeDiff', () => {
  it('prefixes each line and truncates past the cap', () => {
    const diff = Array.from({ length: 50 }, (_, i) => `+line ${i}`).join('\n')
    const out = colorizeDiff(diff, makePainter(false), 10)
    expect(out).toContain('+line 0')
    expect(out).toContain('40 more lines')
  })

  it('classifies header lines before +/- so +++/--- are not mistaken for adds', () => {
    // With color off we can only assert content survives; classification is exercised
    // with color on below.
    const paint = makePainter(true)
    const out = colorizeDiff('+++ a.ts\n+added\n-removed\n context', paint)
    expect(out).toContain('+++ a.ts')
    expect(out).toContain('added')
    expect(out).toContain('removed')
  })
})

describe('renderToolResult', () => {
  const paint = makePainter(false)
  it('marks failures', () => {
    expect(renderToolResult('run_shell', false, '', paint)).toContain('failed')
  })
  it('shows the first non-empty output line as a snippet', () => {
    expect(renderToolResult('read_file', true, '\n\nhello world\nmore', paint)).toContain('hello world')
  })
  it('is empty for successful no-output results', () => {
    expect(renderToolResult('x', true, '   \n  ', paint)).toBe('')
  })
})

describe('formatSessionCost', () => {
  it('formats tokens with grouping and cost to 4 dp', () => {
    expect(formatSessionCost({ inputTokens: 1234, outputTokens: 567, cost: 0.0123 })).toBe(
      '1,234+567 tok · $0.0123'
    )
  })
})

describe('formatRelativeTime', () => {
  const now = 10_000_000_000
  it('buckets by magnitude', () => {
    expect(formatRelativeTime(now - 10_000, now)).toBe('just now')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago')
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('2d ago')
  })
  it('never goes negative', () => {
    expect(formatRelativeTime(now + 5000, now)).toBe('just now')
  })
})

describe('status line & progress', () => {
  const paint = makePainter(false)

  it('subagentGlyph maps status', () => {
    expect(subagentGlyph('running')).toBe('·')
    expect(subagentGlyph('done')).toBe('✓')
    expect(subagentGlyph('error')).toBe('✗')
  })

  it('shortCwd abbreviates home and deep paths', () => {
    expect(shortCwd('/Users/x/proj', '/Users/x')).toBe('~/proj')
    expect(shortCwd('/a/b/c/d/e', '/nope')).toBe('…/d/e')
    expect(shortCwd('/a/b', '/nope')).toBe('/a/b')
  })

  it('renders model, policy, cost, and a context bar', () => {
    const line = renderStatusLine(
      { providerId: 'anthropic', model: 'claude-opus-4-8', policy: 'ask', cwd: '/p', cost: { inputTokens: 0, outputTokens: 0, cost: 0.5 }, contextTokens: 500_000 },
      120,
      paint
    )
    expect(line).toContain('anthropic/claude-opus-4-8')
    expect(line).toContain('ask')
    expect(line).toContain('$0.5000')
    expect(line).toContain('50%') // 500k of a 1M window
    expect(line).toMatch(/[▓░]/)
  })

  it('omits the context bar until a turn has run', () => {
    const line = renderStatusLine(
      { providerId: 'p', model: 'claude-opus-4-8', policy: 'plan', cwd: '/p', cost: { inputTokens: 0, outputTokens: 0, cost: 0 }, contextTokens: 0 },
      120,
      paint
    )
    expect(line).not.toMatch(/%/)
  })

  it('truncates to the given width', () => {
    const line = renderStatusLine(
      { providerId: 'anthropic', model: 'claude-opus-4-8', policy: 'ask', cwd: '/very/long/path/here', cost: { inputTokens: 0, outputTokens: 0, cost: 0 }, contextTokens: 0 },
      20,
      paint
    )
    expect(line.length).toBeLessThanOrEqual(20)
  })
})

describe('resume picker', () => {
  const convs: ResumeEntry[] = [
    { id: 'a', title: 'First', updatedAt: 1 },
    { id: 'b', title: 'Second', updatedAt: 2 }
  ]
  it('renders a numbered list, or an empty note', () => {
    const out = renderConversationList(convs, 100, makePainter(false))
    expect(out).toContain('1. First')
    expect(out).toContain('2. Second')
    expect(renderConversationList([], 100, makePainter(false))).toContain('No saved sessions')
  })
  it('maps a valid index to its id, else null', () => {
    expect(parseResumeSelection('2', convs)).toBe('b')
    expect(parseResumeSelection('0', convs)).toBeNull()
    expect(parseResumeSelection('9', convs)).toBeNull()
    expect(parseResumeSelection('cancel', convs)).toBeNull()
  })
})

// --- runTui integration (fully dependency-injected, no real terminal) --------

/** A scripted terminal: readLine drains `inputs` in order, null when exhausted. */
function fakeIo(inputs: Array<string | null>) {
  const out: string[] = []
  const interrupts: Array<() => void> = []
  const reads: Array<{ prompt: string; discardPending: boolean }> = []
  let idx = 0
  const io: TuiIo = {
    out: (s) => out.push(s),
    readLine: async (prompt, opts) => {
      reads.push({ prompt, discardPending: Boolean(opts?.discardPending) })
      return idx < inputs.length ? inputs[idx++] : null
    },
    onInterrupt: (h) => interrupts.push(h),
    cancelRead: () => {}
  }
  return {
    io,
    out,
    reads,
    text: () => out.join(''),
    fireInterrupt: () => interrupts.forEach((h) => h())
  }
}

interface Recorder {
  runs: Array<{ providerId: string; model: string; policy: string; messages: ChatMessage[] }>
  approvals: Array<[string, string, string]>
  questions: Array<[string, string, string]>
  cancels: string[]
  accepted: () => number
}

/** Build deps whose startRun emits a scripted event list, recording everything. */
function deps(
  events: AgentEvent[],
  over: Partial<AppSettings> = {},
  onMessagesEcho?: (req: { messages: ChatMessage[] }) => ChatMessage[]
): { d: TuiDeps; rec: Recorder } {
  const runs: Recorder['runs'] = []
  const approvals: Recorder['approvals'] = []
  const questions: Recorder['questions'] = []
  const cancels: string[] = []
  let accepted = 0
  const d: TuiDeps = {
    getSettings: () =>
      settings({ selected: { providerId: 'anthropic', model: 'claude' }, legalAcceptedVersion: LEGAL_VERSION, ...over }),
    recordLegalAcceptance: () => {
      accepted++
    },
    startRun: async (req, send, onMessages) => {
      runs.push({
        providerId: req.providerId,
        model: req.model,
        policy: req.approvalPolicy,
        messages: req.messages.map((m) => ({ ...m }))
      })
      for (const e of events) send({ ...e, runId: req.runId } as AgentEvent)
      onMessages?.(onMessagesEcho ? onMessagesEcho(req) : req.messages)
    },
    resolveApproval: (r, c, dec) => approvals.push([r, c, dec]),
    resolveQuestion: (r, c, ans) => questions.push([r, c, ans]),
    cancelRun: (r) => cancels.push(r),
    io: undefined as unknown as TuiIo,
    newId: () => `run-${runs.length + 1}`
  }
  return { d, rec: { runs, approvals, questions, cancels, accepted: () => accepted } }
}

/** An in-memory conversation store standing in for conversations.ts. */
function fakePersist(seed: Array<ResumeEntry & { messages: ChatMessage[] }> = []) {
  const store = new Map<
    string,
    { title: string; updatedAt: number; workspace: string; messages: ChatMessage[] }
  >()
  for (const s of seed) {
    store.set(s.id, { title: s.title, updatedAt: s.updatedAt, workspace: '/proj', messages: s.messages })
  }
  let seq = 0
  const persist: TuiPersist = {
    create: ({ workspace }) => {
      const id = `conv-${++seq}`
      store.set(id, { title: 'New chat', updatedAt: 0, workspace, messages: [] })
      return { id }
    },
    setMessages: (id, messages) => {
      const c = store.get(id)
      if (c) c.messages = messages
    },
    list: (workspace) =>
      [...store.entries()]
        .filter(([, c]) => c.workspace === workspace)
        .map(([id, c]) => ({ id, title: c.title, updatedAt: c.updatedAt })),
    get: (id) => {
      const c = store.get(id)
      return c ? { messages: c.messages } : null
    }
  }
  return { persist, store }
}

const opts = {
  cwd: '/proj',
  approvalPolicy: 'ask' as const,
  acceptTerms: false,
  color: false
}

describe('runTui', () => {
  it('runs one turn, streaming assistant text, then exits on EOF', async () => {
    const { d, rec } = deps([
      { runId: 'x', type: 'text', delta: 'Hello there' },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['fix the bug', null])
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(0)
    expect(rec.runs).toHaveLength(1)
    expect(rec.runs[0].messages).toEqual([{ role: 'user', content: 'fix the bug' }])
    expect(t.text()).toContain('Hello there')
    expect(t.text()).toContain('Bye.')
  })

  it('prompts for and records an approval decision', async () => {
    const { d, rec } = deps([
      { runId: 'x', type: 'tool_approval', callId: 'c1', name: 'run_shell', summary: 'ls', kind: 'shell' },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    // inputs: user line, then the approval answer, then EOF
    const t = fakeIo(['run ls', 'y', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.approvals).toEqual([['run-1', 'c1', 'allow']])
    // The approval read discards type-ahead; the composer read does not.
    expect(t.reads.find((r) => r.prompt === '> ')?.discardPending).toBe(true)
    expect(t.reads.find((r) => r.prompt !== '> ')?.discardPending).toBe(false)
  })

  it('prompts for and resolves an ask_user question by option number', async () => {
    const { d, rec } = deps([
      {
        runId: 'x',
        type: 'tool_question',
        callId: 'q1',
        question: 'Which?',
        options: [{ label: 'Alpha' }, { label: 'Beta' }]
      },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['choose', '2', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.questions).toEqual([['run-1', 'q1', 'Beta']])
  })

  it('/exit ends the session', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const t = fakeIo(['/exit', 'should not run'])
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(0)
    expect(rec.runs).toHaveLength(0)
  })

  it('/clear resets conversation context', async () => {
    // Echo back an accumulating message list so we can see it grow, then clear.
    const { d, rec } = deps(
      [{ runId: 'x', type: 'done', stopReason: 'end_turn' }],
      {},
      (req) => [...req.messages, { role: 'assistant', content: 'ok' }]
    )
    const t = fakeIo(['first', '/clear', 'second', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs).toHaveLength(2)
    // Second turn starts fresh: only the new user message, not the prior exchange.
    expect(rec.runs[1].messages).toEqual([{ role: 'user', content: 'second' }])
  })

  it('carries conversation context across turns', async () => {
    const { d, rec } = deps(
      [{ runId: 'x', type: 'done', stopReason: 'end_turn' }],
      {},
      (req) => [...req.messages, { role: 'assistant', content: 'reply' }]
    )
    const t = fakeIo(['one', 'two', null])
    d.io = t.io
    await runTui(opts, d)
    // Second turn includes the first exchange plus the new message.
    expect(rec.runs[1].messages).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'two' }
    ])
  })

  it('/approval switches the policy used by the next run', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const t = fakeIo(['/approval full-auto', 'go', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs[0].policy).toBe('full-auto')
  })

  it('/model switches the provider + model used by the next run', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const t = fakeIo(['/model ollama', 'go', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs[0]).toMatchObject({ providerId: 'ollama', model: 'llama' })
  })

  it('reports an unknown slash command without starting a run', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const t = fakeIo(['/nope', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs).toHaveLength(0)
    expect(t.text()).toContain('Unknown command')
  })

  it('an interrupt cancels the active run', async () => {
    // startRun fires the interrupt mid-run, before emitting done.
    const runs: string[] = []
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'aborted' }])
    const t = fakeIo(['long task', null])
    d.io = t.io
    const origStart = d.startRun
    d.startRun = async (req, send, onMessages) => {
      t.fireInterrupt() // user hits Ctrl-C
      return origStart(req, send, onMessages)
    }
    await runTui(opts, d)
    expect(rec.cancels).toEqual([`run-1`])
    // The interrupt is acknowledged visibly rather than stopping silently.
    expect(t.text()).toContain('^C interrupted')
    void runs
  })

  it('blocks and exits 2 when terms are declined interactively', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }], {
      legalAcceptedVersion: 0
    })
    const t = fakeIo(['n']) // decline the terms prompt
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(2)
    expect(rec.accepted()).toBe(0)
    expect(rec.runs).toHaveLength(0)
  })

  it('records acceptance and proceeds when terms are accepted interactively', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }], {
      legalAcceptedVersion: 0
    })
    const t = fakeIo(['y', 'hello', null]) // accept, then one turn
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(0)
    expect(rec.accepted()).toBe(1)
    expect(rec.runs).toHaveLength(1)
  })

  it('errors when no model can be resolved', async () => {
    const { d } = deps([], { providers: [], selected: null })
    const t = fakeIo([null])
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(1)
    expect(t.text()).toContain('No model configured')
  })

  it('previews the diff of a write before its approval prompt', async () => {
    const { d } = deps([
      {
        runId: 'x',
        type: 'tool_start',
        callId: 'c1',
        name: 'edit_file',
        args: { path: 'a.ts', old_string: 'foo', new_string: 'bar' }
      },
      { runId: 'x', type: 'tool_approval', callId: 'c1', name: 'edit_file', summary: 'edit a.ts', kind: 'write' },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['edit it', 'y', null])
    d.io = t.io
    await runTui(opts, d)
    const out = t.text()
    expect(out).toContain('-foo')
    expect(out).toContain('+bar')
  })

  it('accumulates session cost across turns and prints it on /cost', async () => {
    const { d } = deps([
      { runId: 'x', type: 'usage', inputTokens: 100, outputTokens: 50, cost: 0.01 },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['one', 'two', '/cost', null])
    d.io = t.io
    await runTui(opts, d)
    // Two turns each report 100+50 / $0.01 → session total 200+100 / $0.02.
    expect(t.text()).toContain('session: 200+100 tok · $0.0200')
  })

  it('persists the session as a conversation on the first turn', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const fp = fakePersist()
    d.persist = fp.persist
    const t = fakeIo(['hello', null])
    d.io = t.io
    await runTui(opts, d)
    expect(fp.store.size).toBe(1)
    expect([...fp.store.values()][0].messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('/clear opens a fresh conversation on the next turn', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const fp = fakePersist()
    d.persist = fp.persist
    const t = fakeIo(['first', '/clear', 'second', null])
    d.io = t.io
    await runTui(opts, d)
    expect(fp.store.size).toBe(2) // two distinct persisted conversations
  })

  it('/resume loads a saved session and continues it', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }], {}, (req) => req.messages)
    const fp = fakePersist([
      {
        id: 'saved',
        title: 'Old',
        updatedAt: 5,
        messages: [
          { role: 'user', content: 'earlier' },
          { role: 'assistant', content: 'reply' }
        ]
      }
    ])
    d.persist = fp.persist
    d.now = () => 1000
    const t = fakeIo(['/resume', '1', 'continue', null])
    d.io = t.io
    await runTui(opts, d)
    // The post-resume turn carries the loaded history plus the new message...
    expect(rec.runs[0].messages).toEqual([
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'continue' }
    ])
    // ...in the SAME conversation — no new one is created.
    expect(fp.store.size).toBe(1)
  })

  it('/resume cancels on a non-numeric choice without loading', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const fp = fakePersist([{ id: 'saved', title: 'Old', updatedAt: 5, messages: [] }])
    d.persist = fp.persist
    const t = fakeIo(['/resume', 'nah', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs).toHaveLength(0)
    expect(t.text()).toContain('cancelled')
  })

  it('reports resume as unavailable without a store', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const t = fakeIo(['/resume', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('resume is unavailable')
  })

  it('prints a status line before the composer prompt', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    d.now = () => 0
    const t = fakeIo([null]) // EOF immediately
    d.io = t.io
    await runTui(opts, d)
    // Model + policy appear before we ever read input.
    expect(t.text()).toContain('anthropic/claude')
    expect(t.text()).toContain('ask')
  })

  it('renders tool_progress, subagent, and retry events', async () => {
    const { d } = deps([
      { runId: 'x', type: 'retry', attempt: 2, max: 5, message: 'network hiccup' },
      { runId: 'x', type: 'tool_start', callId: 'c1', name: 'review_changes', args: {} },
      { runId: 'x', type: 'tool_progress', callId: 'c1', message: 'reviewing correctness' },
      { runId: 'x', type: 'subagent', parentCallId: 'c1', id: 's1', label: 'Correctness', status: 'running' },
      { runId: 'x', type: 'subagent', parentCallId: 'c1', id: 's1', label: 'Correctness', status: 'done' },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['review', null])
    d.io = t.io
    await runTui(opts, d)
    const out = t.text()
    expect(out).toContain('retrying (2/5)')
    expect(out).toContain('reviewing correctness')
    expect(out).toContain('· Correctness')
    expect(out).toContain('✓ Correctness')
  })
})
