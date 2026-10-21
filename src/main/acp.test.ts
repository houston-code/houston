import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppSettings, ApprovalPolicy } from '@shared/types'
import {
  BLOCKING_EVENT_TYPES,
  type AgentEvent,
  type AgentRunRequest,
  type BlockingEvent,
  type BlockingEventType,
  type ChatMessage,
  type ElicitationResult,
  type PlanDecision,
  type ToolApprovalDecision
} from '@shared/agent'
import {
  ACP_DECLINED_ANSWER,
  ACP_ERROR,
  ACP_NO_QUESTION_ANSWER,
  acpMcpServersToConfigs,
  acpToolKind,
  elicitationSchema,
  previewToDiffContent,
  promptFromBlocks,
  replayUpdates,
  serveAcp,
  type AcpDeps,
  type AcpStoredSession
} from './acp'

const settings = {
  providers: [{ id: 'anthropic', requiresKey: true, hasKey: true, models: [{ id: 'claude-sonnet-4-5' }] }],
  selected: { providerId: 'anthropic', model: 'claude-sonnet-4-5' },
  approvalPolicy: 'ask'
} as unknown as AppSettings

/** A scripted stand-in for the agent loop: each run's body decides what it emits. */
type RunBody = (
  req: AgentRunRequest,
  send: (e: AgentEvent) => void,
  loop: FakeLoop,
  onMessages?: (m: ChatMessage[]) => void
) => Promise<void>

class FakeLoop {
  approvals: Array<[string, string, ToolApprovalDecision]> = []
  questions: Array<[string, string, string]> = []
  plans: Array<[string, string, PlanDecision]> = []
  elicitations: Array<[string, string, ElicitationResult]> = []
  cancelled: string[] = []
  policies: Array<[string, ApprovalPolicy]> = []
  requests: AgentRunRequest[] = []
  private waiters = new Map<string, () => void>()
  private aborts = new Map<string, () => void>()

  /** Resolve when the client resolves the blocking prompt keyed `key`. */
  waitFor(key: string): Promise<void> {
    return new Promise((r) => this.waiters.set(key, r))
  }
  /** Resolve when the run is cancelled. */
  waitForCancel(runId: string): Promise<void> {
    return new Promise((r) => this.aborts.set(runId, r))
  }
  private settle(key: string): void {
    this.waiters.get(key)?.()
    this.waiters.delete(key)
  }

  resolveApproval = (runId: string, callId: string, d: ToolApprovalDecision): void => {
    this.approvals.push([runId, callId, d])
    this.settle(callId)
  }
  resolveQuestion = (runId: string, callId: string, a: string): void => {
    this.questions.push([runId, callId, a])
    this.settle(callId)
  }
  resolvePlan = (runId: string, callId: string, d: PlanDecision): void => {
    this.plans.push([runId, callId, d])
    this.settle(callId)
  }
  resolveElicitation = (runId: string, elicitId: string, r: ElicitationResult): void => {
    this.elicitations.push([runId, elicitId, r])
    this.settle(elicitId)
  }
  cancelRun = (runId: string): void => {
    this.cancelled.push(runId)
    this.aborts.get(runId)?.()
  }
  setRunPolicy = (runId: string, policy: ApprovalPolicy): void => {
    this.policies.push([runId, policy])
  }
}

interface Harness {
  loop: FakeLoop
  frames: any[]
  stored: Map<string, AcpStoredSession>
  saved: Map<string, ChatMessage[]>
  /** Send a request and await its response frame. */
  call: (method: string, params?: unknown) => Promise<any>
  notify: (method: string, params?: unknown) => void
  /** Session updates received so far, for one session. */
  updates: (sessionId: string) => any[]
  /** End the input stream and wait for the server to wind down. */
  end: () => Promise<void>
  cwd: string
}

/**
 * Drive the server over an in-memory stdio pair: requests go in as JSON lines on a
 * stream, frames come out through `write`, and requests the server sends (permission,
 * elicitation) are answered by `answer`.
 */
function harness(opts: {
  run: RunBody
  answer?: (method: string, params: any) => unknown
  deps?: Partial<AcpDeps>
  stored?: AcpStoredSession[]
}): Harness {
  const loop = new FakeLoop()
  const input = new PassThrough()
  const frames: any[] = []
  const pending = new Map<number, (m: any) => void>()
  const stored = new Map((opts.stored ?? []).map((s) => [s.id, s]))
  const saved = new Map<string, ChatMessage[]>()
  let ids = 0
  let convIds = 0
  const cwd = mkdtempSync(join(tmpdir(), 'houston-acp-'))

  const send = (m: object): void => {
    input.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`)
  }

  const deps: AcpDeps = {
    getSettings: () => settings,
    startRun: async (req, s, onMessages) => {
      loop.requests.push(req)
      await opts.run(req, s, loop, onMessages)
    },
    resolveApproval: loop.resolveApproval,
    resolveQuestion: loop.resolveQuestion,
    resolvePlan: loop.resolvePlan,
    resolveElicitation: loop.resolveElicitation,
    cancelRun: loop.cancelRun,
    setRunPolicy: loop.setRunPolicy,
    store: {
      create: ({ workspace }) => {
        const id = `conv-${++convIds}`
        stored.set(id, { id, workspace, messages: [] })
        return { id }
      },
      get: (id) => stored.get(id) ?? null,
      list: () => [...stored.values()],
      setMessages: (id, m) => void saved.set(id, m),
      setModel: () => {}
    },
    write: (line) => {
      expect(line.endsWith('\n')).toBe(true)
      const m = JSON.parse(line)
      expect(m.jsonrpc).toBe('2.0')
      frames.push(m)
      if (m.method !== undefined && m.id !== undefined) {
        // A request from the agent to the client.
        const result = opts.answer?.(m.method, m.params)
        if (result === undefined) return // left unanswered
        setImmediate(() => send({ id: m.id, result }))
      } else if (m.method === undefined) {
        pending.get(m.id)?.(m)
        pending.delete(m.id)
      }
    },
    version: '1.2.3',
    newId: (() => {
      let n = 0
      return () => `run-${++n}`
    })(),
    readFile: () => null,
    ...opts.deps
  }
  const served = serveAcp(input, deps)

  return {
    loop,
    frames,
    stored,
    saved,
    cwd,
    call: (method, params) => {
      const id = ++ids
      return new Promise((resolve) => {
        pending.set(id, resolve)
        send({ id, method, ...(params !== undefined ? { params } : {}) })
      })
    },
    notify: (method, params) => send({ method, params }),
    updates: (sessionId) =>
      frames.filter((f) => f.method === 'session/update' && f.params.sessionId === sessionId).map((f) => f.params.update),
    end: async () => {
      input.end()
      await served
    }
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

async function ready(h: Harness, clientCapabilities: object = {}): Promise<string> {
  const init = await h.call('initialize', { protocolVersion: 1, clientCapabilities })
  expect(init.result.protocolVersion).toBe(1)
  const created = await h.call('session/new', { cwd: h.cwd, mcpServers: [] })
  return created.result.sessionId
}

const text = (t: string) => [{ type: 'text', text: t }]

describe('ACP server: protocol flow', () => {
  it('initializes with honest capabilities', async () => {
    const h = harness({ run: async () => {} })
    const res = await h.call('initialize', { protocolVersion: 1, clientCapabilities: {} })
    expect(res.result).toEqual({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { list: {} }
      },
      authMethods: [],
      agentInfo: { name: 'houston', title: 'Houston', version: '1.2.3' }
    })
    // An editor that can open a terminal is offered the interactive setup.
    const withTerminal = await h.call('initialize', { protocolVersion: 1, clientCapabilities: { auth: { terminal: true } } })
    expect(withTerminal.result.authMethods).toEqual([expect.objectContaining({ type: 'terminal', args: ['-i'] })])
    await h.end()
  })

  it('runs initialize, new session, prompt with streamed updates and a permission round-trip, then load', async () => {
    const h = harness({
      answer: (method) =>
        method === 'session/request_permission' ? { outcome: { outcome: 'selected', optionId: 'rule-allow' } } : undefined,
      run: async (req, send, loop, onMessages) => {
        const r = req.runId
        send({ runId: r, type: 'reasoning', delta: 'thinking' })
        send({ runId: r, type: 'text', delta: 'Editing ' })
        send({ runId: r, type: 'tool_start', callId: 't0', name: 'todo_write', args: { todos: [{ content: 'Fix it', status: 'in_progress' }] }, kind: 'read' })
        send({ runId: r, type: 'tool_result', callId: 't0', name: 'todo_write', ok: true, output: 'Updated' })
        const preview = [{ path: 'a.txt', diff: [{ type: 'del' as const, text: 'old' }, { type: 'add' as const, text: 'new' }] }]
        const approved = loop.waitFor('c1')
        send({ runId: r, type: 'tool_approval', callId: 'c1', name: 'edit_file', summary: 'Edit a.txt', args: { path: 'a.txt' }, kind: 'write', preview })
        await approved
        send({ runId: r, type: 'tool_start', callId: 'c1', name: 'edit_file', args: { path: 'a.txt' }, kind: 'write', preview })
        send({ runId: r, type: 'tool_progress', callId: 'c1', message: 'applying' })
        send({ runId: r, type: 'tool_result', callId: 'c1', name: 'edit_file', ok: true, output: 'Edited a.txt' })
        send({ runId: r, type: 'usage', inputTokens: 1000, outputTokens: 50, cost: 0.01, model: 'claude-sonnet-4-5' })
        onMessages?.([...req.messages, { role: 'assistant', content: 'Editing done' }])
        send({ runId: r, type: 'done', stopReason: 'end_turn' })
      }
    })
    const sessionId = await ready(h)
    expect(h.frames.find((f) => f.result?.sessionId)?.result.modes).toEqual(
      expect.objectContaining({ currentModeId: 'ask', availableModes: expect.arrayContaining([expect.objectContaining({ id: 'plan' })]) })
    )

    const res = await h.call('session/prompt', { sessionId, prompt: text('fix a.txt') })
    expect(res.result).toEqual({ stopReason: 'end_turn' })

    // The run got the editor's folder and the user's words.
    const req = h.loop.requests[0]
    expect(req.workspace).toBe(h.cwd)
    expect(req.conversationId).toBe(sessionId)
    expect(req.approvalPolicy).toBe('ask')
    expect(req.messages.at(-1)).toEqual({ role: 'user', content: 'fix a.txt' })

    // Permission round-trip: four choices, the pick reaches the loop as a saved rule.
    const perm = h.frames.find((f) => f.method === 'session/request_permission')
    expect(perm.params.sessionId).toBe(sessionId)
    expect(perm.params.toolCall).toEqual(expect.objectContaining({ toolCallId: 'c1', title: 'Edit a.txt', kind: 'edit' }))
    expect(perm.params.toolCall.content).toEqual([
      { type: 'diff', path: join(h.cwd, 'a.txt'), oldText: 'old', newText: 'new' }
    ])
    expect(perm.params.options.map((o: any) => o.kind)).toEqual(['allow_once', 'allow_always', 'reject_once', 'reject_always'])
    expect(h.loop.approvals).toEqual([['run-1', 'c1', 'rule-allow']])

    const ups = h.updates(sessionId)
    const kinds = ups.map((u) => u.sessionUpdate)
    expect(kinds).toEqual([
      'agent_thought_chunk',
      'agent_message_chunk',
      'plan',
      'tool_call',
      'tool_call_update',
      'tool_call_update',
      'tool_call_update',
      'usage_update'
    ])
    expect(ups[2]).toEqual({ sessionUpdate: 'plan', entries: [{ content: 'Fix it', priority: 'medium', status: 'in_progress' }] })
    expect(ups[3]).toEqual(expect.objectContaining({ toolCallId: 'c1', status: 'pending', locations: [{ path: join(h.cwd, 'a.txt') }] }))
    expect(ups[4]).toEqual(expect.objectContaining({ toolCallId: 'c1', status: 'in_progress' }))
    expect(ups[5].content[0].content.text).toBe('applying')
    expect(ups[6]).toEqual(expect.objectContaining({ toolCallId: 'c1', status: 'completed' }))
    expect(ups[7]).toEqual({ sessionUpdate: 'usage_update', used: 1050, size: expect.any(Number), cost: { amount: 0.01, currency: 'USD' } })

    // The turn was persisted, so another process can load it.
    expect(h.saved.get(sessionId)?.at(-1)).toEqual({ role: 'assistant', content: 'Editing done' })
    h.stored.get(sessionId)!.messages = h.saved.get(sessionId)!
    const before = h.updates(sessionId).length
    const loaded = await h.call('session/load', { sessionId, cwd: h.cwd, mcpServers: [] })
    expect(loaded.result.modes.currentModeId).toBe('ask')
    expect(h.updates(sessionId).slice(before)).toEqual([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'fix a.txt' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Editing done' } }
    ])
    await h.end()
  })

  it('shows an edit as a full before/after diff, but never reads through a symlink out of the folder', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'houston-acp-out-'))
    writeFileSync(join(outside, 'secret.txt'), 'top secret\n')
    let cwd = ''
    const h = harness({
      deps: { readFile: undefined },
      run: async (req, send) => {
        const r = req.runId
        const edit = (callId: string, path: string, after: () => void): void => {
          const preview = [{ path, diff: [{ type: 'add' as const, text: 'x' }] }]
          send({ runId: r, type: 'tool_start', callId, name: 'edit_file', args: { path }, kind: 'write', preview })
          after()
          send({ runId: r, type: 'tool_result', callId, name: 'edit_file', ok: true, output: 'ok' })
        }
        edit('c1', 'a.txt', () => writeFileSync(join(cwd, 'a.txt'), 'new\n'))
        edit('c2', 'link/secret.txt', () => {})
        send({ runId: r, type: 'done', stopReason: 'end_turn' })
      }
    })
    cwd = h.cwd
    writeFileSync(join(cwd, 'a.txt'), 'old\n')
    symlinkSync(outside, join(cwd, 'link'))
    const sessionId = await ready(h)
    await h.call('session/prompt', { sessionId, prompt: text('edit') })
    const done = h.updates(sessionId).filter((u) => u.status === 'completed')
    expect(done[0].content[0]).toEqual({ type: 'diff', path: join(cwd, 'a.txt'), oldText: 'old\n', newText: 'new\n' })
    expect(JSON.stringify(done[1])).not.toContain('top secret')
    expect(done[1].content.map((c: any) => c.type)).toEqual(['content'])
    await h.end()
  })

  it('maps session/cancel to cancelRun and reports the turn as cancelled', async () => {
    const h = harness({
      run: async (req, send, loop) => {
        send({ runId: req.runId, type: 'text', delta: 'working' })
        await loop.waitForCancel(req.runId)
        send({ runId: req.runId, type: 'done', stopReason: 'aborted' })
      }
    })
    const sessionId = await ready(h)
    const reply = h.call('session/prompt', { sessionId, prompt: text('long task') })
    await vi.waitFor(() => expect(h.updates(sessionId)).toHaveLength(1))
    h.notify('session/cancel', { sessionId })
    expect((await reply).result).toEqual({ stopReason: 'cancelled' })
    expect(h.loop.cancelled).toEqual(['run-1'])
    await h.end()
  })

  it('denies a pending permission when the editor cancels it', async () => {
    const h = harness({
      answer: (method) => (method === 'session/request_permission' ? { outcome: { outcome: 'cancelled' } } : undefined),
      run: async (req, send, loop) => {
        const done = loop.waitFor('c1')
        send({ runId: req.runId, type: 'tool_approval', callId: 'c1', name: 'run_shell', summary: 'rm -rf build', args: { command: 'rm -rf build' }, kind: 'shell' })
        await done
        send({ runId: req.runId, type: 'done', stopReason: 'end_turn' })
      }
    })
    const sessionId = await ready(h)
    await h.call('session/prompt', { sessionId, prompt: text('clean') })
    expect(h.loop.approvals).toEqual([['run-1', 'c1', 'deny']])
    expect(h.updates(sessionId).at(-1)).toEqual({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed' })
    await h.end()
  })

  it('switches modes onto the session and the live run', async () => {
    let release: () => void = () => {}
    const h = harness({
      run: async (req, send) => {
        await new Promise<void>((r) => (release = r))
        send({ runId: req.runId, type: 'done', stopReason: 'end_turn' })
      }
    })
    const sessionId = await ready(h)
    expect((await h.call('session/set_mode', { sessionId, modeId: 'plan' })).result).toEqual({})
    const reply = h.call('session/prompt', { sessionId, prompt: text('look around') })
    await vi.waitFor(() => expect(h.loop.requests).toHaveLength(1))
    expect(h.loop.requests[0].approvalPolicy).toBe('plan')
    await h.call('session/set_mode', { sessionId, modeId: 'full-auto' })
    expect(h.loop.policies).toEqual([['run-1', 'full-auto']])
    release()
    await reply
    const bad = await h.call('session/set_mode', { sessionId, modeId: 'yolo' })
    expect(bad.error.code).toBe(ACP_ERROR.invalidParams)
    await h.end()
  })

  it('accepts a presented plan through a permission request and moves the mode', async () => {
    const h = harness({
      answer: () => ({ outcome: { outcome: 'selected', optionId: 'accept-auto-edit' } }),
      run: async (req, send, loop) => {
        const done = loop.waitFor('p1')
        send({ runId: req.runId, type: 'plan_ready', callId: 'p1', plan: { title: 'Refactor', body: 'Step one' } })
        await done
        send({ runId: req.runId, type: 'done', stopReason: 'end_turn' })
      }
    })
    const sessionId = await ready(h)
    await h.call('session/set_mode', { sessionId, modeId: 'plan' })
    await h.call('session/prompt', { sessionId, prompt: text('plan it') })
    expect(h.loop.plans).toEqual([['run-1', 'p1', { kind: 'accept', mode: 'auto-edit' }]])
    const perm = h.frames.find((f) => f.method === 'session/request_permission')
    expect(perm.params.toolCall.content[0].content.text).toContain('Step one')
    expect(h.updates(sessionId)).toContainEqual({ sessionUpdate: 'current_mode_update', currentModeId: 'auto-edit' })
    // The next prompt runs under the accepted mode.
    await h.call('session/prompt', { sessionId, prompt: text('go') })
    expect(h.loop.requests[1].approvalPolicy).toBe('auto-edit')
    await h.end()
  })

  it('asks ask_user through elicitation when the editor supports forms', async () => {
    const h = harness({
      answer: (method, params) => {
        expect(method).toBe('elicitation/create')
        expect(params.requestedSchema.properties.answer.oneOf).toEqual([{ const: 'Postgres', title: 'Postgres' }, { const: 'SQLite', title: 'SQLite' }])
        return { action: 'accept', content: { answer: 'SQLite' } }
      },
      run: async (req, send, loop) => {
        const done = loop.waitFor('q1')
        send({ runId: req.runId, type: 'tool_question', callId: 'q1', question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] })
        await done
        send({ runId: req.runId, type: 'done', stopReason: 'end_turn' })
      }
    })
    const sessionId = await ready(h, { elicitation: { form: {} } })
    await h.call('session/prompt', { sessionId, prompt: text('set up storage') })
    expect(h.loop.questions).toEqual([['run-1', 'q1', 'SQLite']])
    await h.end()
  })

  it('passes client MCP servers to the run and fails a broken run as a JSON-RPC error', async () => {
    const h = harness({
      run: async (req, send) => {
        send({ runId: req.runId, type: 'error', message: 'provider exploded' })
        send({ runId: req.runId, type: 'done', stopReason: 'error' })
      }
    })
    await h.call('initialize', { protocolVersion: 1 })
    const created = await h.call('session/new', {
      cwd: h.cwd,
      mcpServers: [{ name: 'docs', command: 'docs-mcp', args: ['--stdio'], env: [{ name: 'TOKEN', value: 't' }] }]
    })
    const res = await h.call('session/prompt', { sessionId: created.result.sessionId, prompt: text('hi') })
    expect(res.error).toEqual({ code: ACP_ERROR.internal, message: 'provider exploded' })
    expect(h.loop.requests[0].extraMcpServers).toEqual([
      expect.objectContaining({ id: 'acp-docs', command: 'docs-mcp', args: ['--stdio'], env: { TOKEN: 't' } })
    ])
    await h.end()
  })

  it('reports protocol errors without crashing', async () => {
    const h = harness({ run: async () => {} })
    expect((await h.call('nope/nothing')).error.code).toBe(ACP_ERROR.methodNotFound)
    expect((await h.call('session/prompt', { sessionId: 'missing', prompt: [] })).error.code).toBe(ACP_ERROR.notFound)
    expect((await h.call('session/new', { cwd: 'relative/dir', mcpServers: [] })).error.code).toBe(ACP_ERROR.invalidParams)
    expect((await h.call('session/load', { sessionId: 'gone', cwd: h.cwd, mcpServers: [] })).error.code).toBe(ACP_ERROR.notFound)
    await h.end()
  })

  it('answers a malformed line with a parse error', async () => {
    const frames: any[] = []
    const input = new PassThrough()
    const served = serveAcp(input, {
      write: (f: string) => void frames.push(JSON.parse(f))
    } as unknown as AcpDeps)
    input.write('{not json\n')
    input.end()
    await served
    expect(frames).toEqual([{ jsonrpc: '2.0', id: null, error: { code: ACP_ERROR.parse, message: 'Parse error' } }])
  })

  it('asks the editor to authenticate when no provider is configured', async () => {
    const h = harness({
      run: async () => {},
      deps: { getSettings: () => ({ providers: [], approvalPolicy: 'ask' }) as unknown as AppSettings }
    })
    await h.call('initialize', { protocolVersion: 1 })
    const res = await h.call('session/new', { cwd: h.cwd, mcpServers: [] })
    expect(res.error.code).toBe(ACP_ERROR.authRequired)
    await h.end()
  })

  it('lists saved sessions for a folder, newest first', async () => {
    const h = harness({
      run: async () => {},
      stored: [
        { id: 'old', workspace: '/w', messages: [], title: 'Old', updatedAt: 1 },
        { id: 'new', workspace: '/w', messages: [], title: 'New', updatedAt: 2 },
        { id: 'other', workspace: '/x', messages: [], updatedAt: 3 }
      ]
    })
    const res = await h.call('session/list', { cwd: '/w' })
    expect(res.result.sessions.map((s: any) => s.sessionId)).toEqual(['new', 'old'])
    expect(res.result.sessions[0]).toEqual({ sessionId: 'new', cwd: '/w', title: 'New', updatedAt: new Date(2).toISOString() })
    await h.end()
  })
})

/**
 * Client parity: every event the loop blocks on must be resolved by the ACP client
 * too, or an editor-driven run hangs. The sample table is keyed by
 * BLOCKING_EVENT_TYPES, so a new blocking event fails to compile here until it has a
 * sample, and then fails at runtime until the server resolves it.
 */
describe('ACP server: resolves every blocking interaction', () => {
  const samples: Record<BlockingEventType, (runId: string) => BlockingEvent> = {
    tool_approval: (runId) => ({ runId, type: 'tool_approval', callId: 'k-tool_approval', name: 'run_shell', summary: 'ls', kind: 'shell' }),
    tool_question: (runId) => ({ runId, type: 'tool_question', callId: 'k-tool_question', question: 'Which?', options: [{ label: 'A' }] }),
    plan_ready: (runId) => ({ runId, type: 'plan_ready', callId: 'k-plan_ready', plan: { title: 'Plan' } }),
    elicitation: (runId) => ({
      runId,
      type: 'elicitation',
      callId: 'm1',
      elicitId: 'k-elicitation',
      serverId: 'srv',
      message: 'Region?',
      fields: [{ name: 'region', kind: 'string', required: true }]
    })
  }

  const runAll: RunBody = async (req, send, loop) => {
    for (const type of BLOCKING_EVENT_TYPES) {
      const done = loop.waitFor(`k-${type}`)
      send(samples[type](req.runId))
      await done
    }
    send({ runId: req.runId, type: 'done', stopReason: 'end_turn' })
  }

  const resolvedCount = (loop: FakeLoop): number =>
    loop.approvals.length + loop.questions.length + loop.plans.length + loop.elicitations.length

  it('with an editor that answers every request', async () => {
    const h = harness({
      answer: (method) =>
        method === 'session/request_permission'
          ? { outcome: { outcome: 'selected', optionId: 'allow' } }
          : { action: 'accept', content: { answer: 'A', region: 'us-east' } },
      run: runAll
    })
    const sessionId = await ready(h, { elicitation: { form: {} } })
    expect((await h.call('session/prompt', { sessionId, prompt: text('go') })).result.stopReason).toBe('end_turn')
    expect(resolvedCount(h.loop)).toBe(BLOCKING_EVENT_TYPES.length)
    expect(h.loop.approvals[0][2]).toBe('allow')
    expect(h.loop.questions[0][2]).toBe('A')
    expect(h.loop.plans[0][2]).toEqual({ kind: 'reject' }) // 'allow' is not a plan option
    expect(h.loop.elicitations[0][2]).toEqual({ action: 'accept', content: { answer: 'A', region: 'us-east' } })
    await h.end()
  })

  it('with an editor that has no question surface (auto-resolved like headless)', async () => {
    const h = harness({
      answer: (method) => (method === 'session/request_permission' ? { outcome: { outcome: 'cancelled' } } : undefined),
      run: runAll
    })
    const sessionId = await ready(h)
    await h.call('session/prompt', { sessionId, prompt: text('go') })
    expect(resolvedCount(h.loop)).toBe(BLOCKING_EVENT_TYPES.length)
    expect(h.loop.questions[0][2]).toBe(ACP_NO_QUESTION_ANSWER)
    expect(h.loop.elicitations[0][2]).toEqual({ action: 'decline' })
    expect(h.frames.some((f) => f.method === 'elicitation/create')).toBe(false)
    await h.end()
  })

  it('with an editor that goes away mid-prompt (resolved the safe way)', async () => {
    const h = harness({ run: runAll }) // never answers anything
    const sessionId = await ready(h, { elicitation: { form: {} } })
    const reply = h.call('session/prompt', { sessionId, prompt: text('go') })
    await vi.waitFor(() => expect(h.frames.some((f) => f.method === 'session/request_permission')).toBe(true))
    await tick()
    await h.end()
    await reply
    expect(h.loop.approvals[0][2]).toBe('deny')
    expect(h.loop.questions[0][2]).toBe(ACP_DECLINED_ANSWER)
    expect(h.loop.plans[0][2]).toEqual({ kind: 'reject' })
    expect(h.loop.elicitations[0][2]).toEqual({ action: 'cancel' })
  })
})

describe('ACP mapping helpers', () => {
  // A workspace root that is absolute on every platform.
  const W = resolve(tmpdir(), 'houston-acp-ws')

  it('turns prompt blocks into one user turn', () => {
    const png = Buffer.from('png').toString('base64')
    // Real absolute paths for this platform (a drive letter on Windows).
    const src = resolve(W, 'src', 'a.ts')
    const readme = resolve(W, 'README.md')
    const r = promptFromBlocks([
      { type: 'text', text: 'Look at this' },
      { type: 'resource', resource: { uri: pathToFileURL(src).href, text: 'const a = 1' } },
      { type: 'resource_link', uri: pathToFileURL(readme).href, name: 'README.md' },
      { type: 'image', data: png, mimeType: 'image/png' },
      { type: 'audio', data: 'x', mimeType: 'audio/wav' }
    ])
    expect(r.text).toContain('Look at this')
    expect(r.text).toContain(`Contents of ${src}:\n\`\`\`\nconst a = 1\n\`\`\``)
    expect(r.text).toContain(`Referenced file: ${readme}`)
    expect(r.text).toContain('audio attachment was not included')
    expect(r.images).toEqual([{ mediaType: 'image/png', data: png }])
    expect(() => promptFromBlocks('nope')).toThrow()
  })

  it('maps tool kinds by name, then by permission kind', () => {
    expect(acpToolKind('read_file')).toBe('read')
    expect(acpToolKind('search_files')).toBe('search')
    expect(acpToolKind('apply_patch')).toBe('edit')
    expect(acpToolKind('run_shell')).toBe('execute')
    expect(acpToolKind('web_search')).toBe('fetch')
    expect(acpToolKind('mcp__x__y', 'mcp')).toBe('other')
    expect(acpToolKind('gh_pr_create', 'network')).toBe('fetch')
  })

  it('rebuilds a diff from preview hunks, keeping folds as context', () => {
    const [d] = previewToDiffContent(W, [
      {
        path: 'f.ts',
        diff: [
          { type: 'ctx', text: 'a' },
          { type: 'skip', text: '', count: 3 },
          { type: 'del', text: 'b' },
          { type: 'add', text: 'c' }
        ]
      }
    ])
    expect(d).toEqual({ type: 'diff', path: resolve(W, 'f.ts'), oldText: 'a\n⋯ 3 unchanged lines\nb', newText: 'a\n⋯ 3 unchanged lines\nc' })
    const [created] = previewToDiffContent(W, [{ path: 'n.ts', created: true, diff: [{ type: 'add', text: 'x' }] }])
    expect(created).toEqual(expect.objectContaining({ oldText: null, newText: 'x' }))
  })

  it('converts client MCP servers, skipping malformed ones', () => {
    const { servers, skipped } = acpMcpServersToConfigs([
      { name: 'My Docs', command: 'docs', args: [], env: [] },
      { name: 'My Docs', type: 'http', url: 'https://mcp.example.com', headers: [{ name: 'Authorization', value: 'Bearer x' }] },
      { name: 'bad', type: 'http', url: 'ftp://nope', headers: [] },
      { name: 'weird', type: 'carrier-pigeon' },
      { command: 'nameless' }
    ])
    expect(servers.map((s) => s.id)).toEqual(['acp-My-Docs', 'acp-My-Docs-2'])
    expect(servers[1]).toEqual(
      expect.objectContaining({ transport: 'http', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer x' } })
    )
    expect(skipped).toEqual(['bad', 'weird', '(unnamed)'])
  })

  it('builds an elicitation schema from MCP fields', () => {
    expect(
      elicitationSchema([
        { name: 'region', kind: 'enum', options: ['us', 'eu'], required: true },
        { name: 'count', kind: 'integer', title: 'How many' }
      ])
    ).toEqual({
      type: 'object',
      properties: { region: { type: 'string', enum: ['us', 'eu'] }, count: { type: 'integer', title: 'How many' } },
      required: ['region']
    })
  })

  it('replays a conversation without loop notes, and shows invoked turns as what the user did', () => {
    const ups = replayUpdates(
      [
        { role: 'user', content: 'Long review prompt', invokedAs: { kind: 'command', label: '/review', typed: '/review' } },
        { role: 'user', content: 'Automated note from Houston (not from the user): keep going' },
        {
          role: 'assistant',
          content: 'Looking',
          reasoning: [{ text: 'hmm' }],
          toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }]
        },
        { role: 'tool', content: 'file body', toolCallId: 'c1', toolName: 'read_file' }
      ],
      W
    )
    expect(ups).toEqual([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '/review' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looking' } },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'read_file: a.ts',
        kind: 'read',
        status: 'completed',
        rawInput: { path: 'a.ts' },
        locations: [{ path: resolve(W, 'a.ts') }]
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'file body' } }]
      }
    ])
  })
})
