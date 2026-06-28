import { describe, expect, it } from 'vitest'
import type { AppSettings } from '@shared/types'
import type { AgentEvent } from '@shared/agent'
import { parseHeadlessArgs, resolveHeadlessModel, runHeadless, type HeadlessDeps } from './headless'

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
      json: true
    })
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
    expect(resolveHeadlessModel(s, {})).toHaveProperty('error')
  })
})

/** Build deps with a scripted startRun that emits the given events. */
function deps(events: AgentEvent[], extra: Partial<HeadlessDeps> = {}) {
  const out: string[] = []
  const err: string[] = []
  const approvals: Array<[string, string, string]> = []
  const questions: Array<[string, string, string]> = []
  const d: HeadlessDeps = {
    getSettings: () => settings({ selected: { providerId: 'anthropic', model: 'claude' } }),
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
  return { d, out, err, approvals, questions }
}

const baseOpts = { prompt: 'hi', cwd: '/proj', approvalPolicy: 'plan' as const, json: false }

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
    const { d } = deps([], { getSettings: () => settings({ providers: [], selected: null }) })
    expect(await runHeadless(baseOpts, d)).toBe(1)
  })
})
