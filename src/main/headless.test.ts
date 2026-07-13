import { describe, expect, it } from 'vitest'
import type { AppSettings } from '@shared/types'
import type { AgentEvent, ChatMessage } from '@shared/agent'
import { LEGAL_VERSION } from '@shared/legal'
import {
  legalAcceptanceMessage,
  parseHeadlessArgs,
  resolveHeadlessModel,
  runHeadless,
  type HeadlessDeps
} from './headless'

describe('parseHeadlessArgs', () => {
  it('returns null without a prompt flag (GUI launch)', () => {
    expect(parseHeadlessArgs(['node', 'app'], '/cwd')).toBeNull()
  })

  it('parses -p and defaults to plan policy and the given cwd', () => {
    const o = parseHeadlessArgs(['node', 'app', '-p', 'do it'], '/here')
    expect(o).toMatchObject({ prompt: 'do it', cwd: '/here', approvalPolicy: 'plan', json: false })
  })

  it('parses long flags and --flag=value form', () => {
    const o = parseHeadlessArgs(
      ['--prompt=fix bug', '--cwd', '/proj', '--provider', 'openai', '--model=gpt', '--json'],
      '/d'
    )
    expect(o).toEqual({
      prompt: 'fix bug',
      cwd: '/proj',
      providerId: 'openai',
      model: 'gpt',
      approvalPolicy: 'plan',
      json: true,
      acceptTerms: false,
      continueSession: false,
      resumeId: undefined
    })
  })

  it('parses --accept-terms (defaults to false)', () => {
    expect(parseHeadlessArgs(['-p', 'x'], '/d')?.acceptTerms).toBe(false)
    expect(parseHeadlessArgs(['-p', 'x', '--accept-terms'], '/d')?.acceptTerms).toBe(true)
  })

  it('parses --continue and --resume <id>', () => {
    expect(parseHeadlessArgs(['-p', 'x'], '/d')).toMatchObject({ continueSession: false, resumeId: undefined })
    expect(parseHeadlessArgs(['-p', 'x', '--continue'], '/d')?.continueSession).toBe(true)
    expect(parseHeadlessArgs(['-p', 'x', '--resume', 'conv-9'], '/d')?.resumeId).toBe('conv-9')
    expect(parseHeadlessArgs(['-p', 'x', '--resume=conv-9'], '/d')?.resumeId).toBe('conv-9')
  })

  it('honors --full-auto and a valid --approval, ignoring an invalid one', () => {
    expect(parseHeadlessArgs(['-p', 'x', '--full-auto'], '/d')?.approvalPolicy).toBe('full-auto')
    expect(parseHeadlessArgs(['-p', 'x', '--approval', 'auto-edit'], '/d')?.approvalPolicy).toBe(
      'auto-edit'
    )
    expect(parseHeadlessArgs(['-p', 'x', '--approval', 'bogus'], '/d')?.approvalPolicy).toBe('plan')
  })

  it('ignores unknown tokens like the binary/app path', () => {
    const o = parseHeadlessArgs(['/Applications/Houston.app/...', '-p', 'hi'], '/d')
    expect(o?.prompt).toBe('hi')
  })
})

describe('legalAcceptanceMessage', () => {
  it('uses first-run wording and points to --accept-terms + the doc links', () => {
    const m = legalAcceptanceMessage(false)
    expect(m).toContain('before using headless mode')
    expect(m).not.toContain('have been updated')
    expect(m).toContain('--accept-terms')
    expect(m).toContain('/docs/TERMS.md')
    expect(m).toContain('/docs/PRIVACY.md')
    expect(m).toContain('/LICENSE')
  })

  it('uses re-acceptance wording when the terms changed since a prior acceptance', () => {
    const m = legalAcceptanceMessage(true)
    expect(m).toContain('have been updated and must be re-accepted')
    expect(m).toContain('--accept-terms')
  })
})

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

describe('resolveHeadlessModel', () => {
  it('uses an explicit provider + model', () => {
    expect(resolveHeadlessModel(settings(), { providerId: 'anthropic', model: 'opus' })).toEqual({
      providerId: 'anthropic',
      model: 'opus'
    })
  })

  it('errors on an unknown explicit provider', () => {
    expect(resolveHeadlessModel(settings(), { providerId: 'nope' })).toHaveProperty('error')
  })

  it('falls back to settings.selected', () => {
    const s = settings({ selected: { providerId: 'ollama', model: 'llama' } })
    expect(resolveHeadlessModel(s, {})).toEqual({ providerId: 'ollama', model: 'llama' })
  })

  it('falls back to the first ready provider', () => {
    expect(resolveHeadlessModel(settings(), {})).toEqual({ providerId: 'anthropic', model: 'claude' })
  })

  it('errors when nothing is configured', () => {
    const s = settings({ providers: [], selected: null })
    const result = resolveHeadlessModel(s, {})
    expect(result).toHaveProperty('error')
    // Host-neutral: shared with the standalone CLI, so it must not say "the app".
    const error = (result as { error: string }).error
    expect(error).not.toMatch(/in the app/i)
    expect(error).toContain('--provider')
  })

  it('errors up front when an explicit provider needs a key but has none', () => {
    const s = settings({
      providers: [{ id: 'openrouter', requiresKey: true, hasKey: false, models: [{ id: 'x' }] }]
    } as Partial<AppSettings>)
    const result = resolveHeadlessModel(s, { providerId: 'openrouter', model: 'x' })
    expect(result).toHaveProperty('error')
    const error = (result as { error: string }).error
    // Actionable: names the env var, not the raw provider failure.
    expect(error).toContain('OPENROUTER_API_KEY')
    expect(error).not.toMatch(/x-api-key/i)
  })

  it('errors when the saved selection points at a keyless provider', () => {
    const s = settings({
      providers: [{ id: 'anthropic', requiresKey: true, hasKey: false, models: [{ id: 'claude' }] }],
      selected: { providerId: 'anthropic', model: 'claude' }
    } as Partial<AppSettings>)
    const result = resolveHeadlessModel(s, {})
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain('ANTHROPIC_API_KEY')
  })

  it('still resolves when a keyless provider does not require a key', () => {
    const s = settings({
      providers: [{ id: 'ollama', requiresKey: false, hasKey: false, models: [{ id: 'llama' }] }],
      selected: { providerId: 'ollama', model: 'llama' }
    } as Partial<AppSettings>)
    expect(resolveHeadlessModel(s, {})).toEqual({ providerId: 'ollama', model: 'llama' })
  })
})

/** Build deps with a scripted startRun that emits the given events. */
function deps(events: AgentEvent[], extra: Partial<HeadlessDeps> = {}) {
  const out: string[] = []
  const err: string[] = []
  const approvals: Array<[string, string, string]> = []
  const questions: Array<[string, string, string]> = []
  // Default profile has already accepted the current terms, so existing-behavior
  // tests aren't about the gate. Gate tests override getSettings.
  let accepted = 0
  const d: HeadlessDeps = {
    getSettings: () =>
      settings({
        selected: { providerId: 'anthropic', model: 'claude' },
        legalAcceptedVersion: LEGAL_VERSION
      }),
    recordLegalAcceptance: () => {
      accepted++
    },
    startRun: async (_req, send) => {
      for (const e of events) send(e)
    },
    resolveApproval: (r, c, dec) => approvals.push([r, c, dec]),
    resolveQuestion: (r, c, ans) => questions.push([r, c, ans]),
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    newId: () => 'run-1',
    ...extra
  }
  return { d, out, err, approvals, questions, accepted: () => accepted }
}

const baseOpts = {
  prompt: 'hi',
  cwd: '/proj',
  approvalPolicy: 'plan' as const,
  json: false,
  acceptTerms: false,
  continueSession: false
}

describe('runHeadless', () => {
  it('streams assistant text to stdout and returns 0', async () => {
    const { d, out } = deps([
      { runId: 'run-1', type: 'text', delta: 'Hello ' },
      { runId: 'run-1', type: 'text', delta: 'world' },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    const code = await runHeadless(baseOpts, d)
    expect(code).toBe(0)
    expect(out.join('')).toBe('Hello world\n')
  })

  it('returns 1 on an error event', async () => {
    const { d, err } = deps([{ runId: 'run-1', type: 'error', message: 'boom' }])
    expect(await runHeadless(baseOpts, d)).toBe(1)
    expect(err.join('')).toContain('boom')
  })

  it('auto-answers an ask_user question so a headless run cannot hang', async () => {
    // Mirror the real loop: emit a question and BLOCK until it is answered. If
    // headless failed to answer, this run (and the test) would hang forever.
    let resolveAnswered: (a: string) => void = () => {}
    const answered = new Promise<string>((r) => (resolveAnswered = r))
    const startRun: HeadlessDeps['startRun'] = async (req, send) => {
      send({ runId: req.runId, type: 'tool_question', callId: 'q1', question: 'which?', options: [] })
      const answer = await answered
      send({ runId: req.runId, type: 'text', delta: `picked: ${answer}` })
      send({ runId: req.runId, type: 'done', stopReason: 'end_turn' })
    }
    const { d, out } = deps([], {
      startRun,
      resolveQuestion: (_r, _c, ans) => resolveAnswered(ans)
    })
    const code = await runHeadless(baseOpts, d)
    expect(code).toBe(0)
    // The run completing (not timing out) + the auto-answer reaching the agent
    // proves headless answered the question rather than hanging on it.
    expect(out.join('')).toContain('picked: [No interactive user is available in headless mode')
  })

  it('auto-approves tool approval prompts', async () => {
    const { d, approvals } = deps([
      { runId: 'run-1', type: 'tool_approval', callId: 'c1', name: 'write_file', summary: 'x', kind: 'write' },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    await runHeadless({ ...baseOpts, approvalPolicy: 'auto-edit' }, d)
    expect(approvals).toEqual([['run-1', 'c1', 'allow']])
  })

  it('emits one JSON line per event in --json mode', async () => {
    const { d, out } = deps([
      { runId: 'run-1', type: 'text', delta: 'hi' },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    await runHeadless({ ...baseOpts, json: true }, d)
    const lines = out.join('').trim().split('\n')
    expect(JSON.parse(lines[0])).toMatchObject({ type: 'text', delta: 'hi' })
    expect(JSON.parse(lines[1])).toMatchObject({ type: 'done' })
  })

  it('returns 1 when no model is configured', async () => {
    const { d } = deps([], {
      getSettings: () =>
        settings({ providers: [], selected: null, legalAcceptedVersion: LEGAL_VERSION })
    })
    expect(await runHeadless(baseOpts, d)).toBe(1)
  })

  it('refuses to run until terms are accepted, pointing to --accept-terms (exit 2)', async () => {
    let ran = false
    const { d, err, accepted } = deps([], {
      // No legalAcceptedVersion → not yet accepted.
      getSettings: () => settings({ selected: { providerId: 'anthropic', model: 'claude' } }),
      startRun: async () => {
        ran = true
      }
    })
    const code = await runHeadless(baseOpts, d)
    expect(code).toBe(2)
    expect(ran).toBe(false)
    expect(accepted()).toBe(0)
    expect(err.join('')).toContain('--accept-terms')
  })

  it('accepts with --accept-terms on an unaccepted profile, records it, and runs', async () => {
    let ran = false
    const { d, accepted, err } = deps([], {
      getSettings: () => settings({ selected: { providerId: 'anthropic', model: 'claude' } }),
      startRun: async (_req, send) => {
        ran = true
        send({ runId: 'run-1', type: 'done', stopReason: 'end_turn' })
      }
    })
    const code = await runHeadless({ ...baseOpts, acceptTerms: true }, d)
    expect(code).toBe(0)
    expect(ran).toBe(true)
    expect(accepted()).toBe(1)
    expect(err.join('')).toContain('terms accepted')
  })

  it('does not require --accept-terms once terms are already accepted', async () => {
    // Default deps profile has already accepted the current terms.
    const { d, accepted } = deps([{ runId: 'run-1', type: 'done', stopReason: 'end_turn' }])
    const code = await runHeadless(baseOpts, d)
    expect(code).toBe(0)
    expect(accepted()).toBe(0)
  })

  /** A session store fake + a startRun that echoes messages to onMessages. */
  function withSession(seed: Array<{ id: string; workspace: string; messages: ChatMessage[] }> = []) {
    const store = new Map(seed.map((s) => [s.id, { ...s }]))
    let seq = 0
    const base = deps([{ runId: 'run-1', type: 'done', stopReason: 'end_turn' }])
    const { d } = base
    const startedWith: { conversationId?: string; messages: ChatMessage[] }[] = []
    d.startRun = async (req, send, onMessages) => {
      startedWith.push({ conversationId: req.conversationId, messages: req.messages.map((m) => ({ ...m })) })
      onMessages?.([...req.messages, { role: 'assistant', content: 'ok' }])
      send({ runId: req.runId, type: 'done', stopReason: 'end_turn' })
    }
    d.session = {
      load: ({ workspace, id }) => {
        if (id) return store.get(id) ?? null
        const recent = [...store.values()].filter((c) => c.workspace === workspace).at(-1)
        return recent ?? null
      },
      create: ({ workspace }) => {
        const id = `conv-${++seq}`
        store.set(id, { id, workspace, messages: [] })
        return { id }
      },
      setMessages: (id, messages) => {
        const c = store.get(id)
        if (c) c.messages = messages
      }
    }
    return { d, store, startedWith, out: base.out, err: base.err }
  }

  it('creates and persists a conversation for a plain run', async () => {
    const { d, store, startedWith } = withSession()
    await runHeadless(baseOpts, d)
    expect(startedWith[0].conversationId).toBe('conv-1')
    expect(startedWith[0].messages).toEqual([{ role: 'user', content: 'hi' }])
    // The run's messages were persisted (so a later --continue can find them).
    expect(store.get('conv-1')?.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok' }
    ])
  })

  it('--continue seeds the most recent session for the cwd', async () => {
    const { d, startedWith } = withSession([
      { id: 'old', workspace: '/proj', messages: [{ role: 'user', content: 'earlier' }] }
    ])
    await runHeadless({ ...baseOpts, continueSession: true }, d)
    expect(startedWith[0].conversationId).toBe('old')
    expect(startedWith[0].messages).toEqual([
      { role: 'user', content: 'earlier' },
      { role: 'user', content: 'hi' }
    ])
  })

  it('--resume <id> seeds a specific session', async () => {
    const { d, startedWith } = withSession([
      { id: 'a', workspace: '/proj', messages: [{ role: 'user', content: 'from-a' }] },
      { id: 'b', workspace: '/proj', messages: [{ role: 'user', content: 'from-b' }] }
    ])
    await runHeadless({ ...baseOpts, resumeId: 'a' }, d)
    expect(startedWith[0].conversationId).toBe('a')
    expect(startedWith[0].messages[0]).toEqual({ role: 'user', content: 'from-a' })
  })

  it('--continue with no prior session starts fresh', async () => {
    const { d, startedWith } = withSession()
    await runHeadless({ ...baseOpts, continueSession: true }, d)
    expect(startedWith[0].conversationId).toBe('conv-1') // a fresh one
    expect(startedWith[0].messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('stays ephemeral (no conversation id) when no session store is wired', async () => {
    const started: (string | undefined)[] = []
    const { d, err } = deps([{ runId: 'run-1', type: 'done', stopReason: 'end_turn' }], {
      startRun: async (req, send) => {
        started.push(req.conversationId)
        send({ runId: req.runId, type: 'done', stopReason: 'end_turn' })
      }
    })
    await runHeadless(baseOpts, d)
    expect(started[0]).toBeUndefined()
    // Nothing to resume → no session marker emitted.
    expect(err.join('')).not.toContain('· session')
  })

  it('emits the session id to stderr in text mode so a script can capture it for --resume', async () => {
    const { d, err, out } = withSession()
    await runHeadless(baseOpts, d)
    expect(err.join('')).toContain('· session conv-1')
    // stdout stays clean (assistant text only) — the id is a stderr marker.
    expect(out.join('')).not.toContain('conv-1')
  })

  it('emits the session id as the first JSON line in --json mode', async () => {
    const { d, out } = withSession()
    await runHeadless({ ...baseOpts, json: true }, d)
    const first = out.join('').trim().split('\n')[0]
    expect(JSON.parse(first)).toEqual({ type: 'session', conversationId: 'conv-1' })
  })

  it('surfaces a max-steps limit in plain mode without failing the exit code', async () => {
    const { d, err } = deps([
      { runId: 'run-1', type: 'limit', reason: 'max-steps' },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    const code = await runHeadless(baseOpts, d)
    expect(code).toBe(0)
    expect(err.join('')).toContain('reached the maximum number of steps')
  })

  it('surfaces a failed tool result in text mode, but not a successful one', async () => {
    const { d, err } = deps([
      { runId: 'run-1', type: 'tool_result', callId: 'c1', name: 'run_shell', ok: false, output: 'nope' },
      { runId: 'run-1', type: 'tool_result', callId: 'c2', name: 'read_file', ok: true, output: 'data' },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    await runHeadless(baseOpts, d)
    const e = err.join('')
    expect(e).toContain('· run_shell failed')
    expect(e).not.toContain('read_file')
  })

  it('prints a token/cost summary on completion in text mode', async () => {
    const { d, err } = deps([
      { runId: 'run-1', type: 'usage', inputTokens: 100, outputTokens: 20, cost: 0.01 },
      { runId: 'run-1', type: 'usage', inputTokens: 50, outputTokens: 5, cost: 0.005 },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    await runHeadless(baseOpts, d)
    expect(err.join('')).toContain('· 150+25 tok · $0.0150')
  })

  it('surfaces a stalled limit in plain mode and returns a non-zero exit code', async () => {
    const { d, err } = deps([
      { runId: 'run-1', type: 'limit', reason: 'stalled' },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    const code = await runHeadless(baseOpts, d)
    expect(code).toBe(1)
    expect(err.join('')).toContain('stalled')
  })

  it('prints a verification event without altering the exit code', async () => {
    const passed = deps([
      { runId: 'run-1', type: 'verification', passed: true },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    expect(await runHeadless(baseOpts, passed.d)).toBe(0)
    expect(passed.err.join('')).toContain('verification passed')

    const failedPass = deps([
      { runId: 'run-1', type: 'verification', passed: false },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    // A failing pass is fed back inside the loop for self-correction, so a clean
    // 'done' after it still exits 0 — the event is informational here.
    expect(await runHeadless(baseOpts, failedPass.d)).toBe(0)
    expect(failedPass.err.join('')).toContain('verification failed')
  })

  it('warns when verifyOnStop is enabled under a read-only plan run', async () => {
    const { d, err } = deps([{ runId: 'run-1', type: 'done', stopReason: 'end_turn' }], {
      getSettings: () =>
        settings({
          selected: { providerId: 'anthropic', model: 'claude' },
          legalAcceptedVersion: LEGAL_VERSION,
          verifyOnStop: true
        })
    })
    await runHeadless(baseOpts, d) // baseOpts is plan mode
    expect(err.join('')).toContain('verifyOnStop is enabled')
    expect(err.join('')).toContain('--full-auto')
  })

  it('does not warn about verifyOnStop under --full-auto', async () => {
    const { d, err } = deps([{ runId: 'run-1', type: 'done', stopReason: 'end_turn' }], {
      getSettings: () =>
        settings({
          selected: { providerId: 'anthropic', model: 'claude' },
          legalAcceptedVersion: LEGAL_VERSION,
          verifyOnStop: true
        })
    })
    await runHeadless({ ...baseOpts, approvalPolicy: 'full-auto' }, d)
    expect(err.join('')).not.toContain('verifyOnStop is enabled')
  })
})
