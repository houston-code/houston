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
  runTui,
  type TuiDeps,
  type TuiIo
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

// --- runTui integration (fully dependency-injected, no real terminal) --------

/** A scripted terminal: readLine drains `inputs` in order, null when exhausted. */
function fakeIo(inputs: Array<string | null>) {
  const out: string[] = []
  const interrupts: Array<() => void> = []
  let idx = 0
  const io: TuiIo = {
    out: (s) => out.push(s),
    readLine: async () => (idx < inputs.length ? inputs[idx++] : null),
    onInterrupt: (h) => interrupts.push(h),
    cancelRead: () => {}
  }
  return { io, out, text: () => out.join(''), fireInterrupt: () => interrupts.forEach((h) => h()) }
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
})
