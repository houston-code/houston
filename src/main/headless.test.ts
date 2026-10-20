import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppSettings } from '@shared/types'
import type { AgentEvent, AgentRunRequest, ChatMessage, ElicitationResult, PlanDecision } from '@shared/agent'
import { loadProjectConfig } from './agent/projectConfig'
import {
  HEADLESS_EXIT,
  headlessExitCode,
  headlessOverrides,
  parseHeadlessArgs,
  resolveHeadlessModel,
  runHeadless,
  type HeadlessDeps,
  type HeadlessOptions,
  type HeadlessResult,
  type HeadlessStatus
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
      onApproval: 'deny',
      allowShellNetwork: false,
      json: true,
      continueSession: false,
      resumeId: undefined
    })
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

  it('defaults --on-approval to deny for gating policies and allow under full-auto', () => {
    expect(parseHeadlessArgs(['-p', 'x'], '/d')?.onApproval).toBe('deny')
    expect(parseHeadlessArgs(['-p', 'x', '--approval', 'ask'], '/d')?.onApproval).toBe('deny')
    expect(parseHeadlessArgs(['-p', 'x', '--approval', 'auto-edit'], '/d')?.onApproval).toBe('deny')
    expect(parseHeadlessArgs(['-p', 'x', '--full-auto'], '/d')?.onApproval).toBe('allow')
    expect(parseHeadlessArgs(['-p', 'x', '--approval', 'full-auto'], '/d')?.onApproval).toBe('allow')
  })

  it('honors an explicit --on-approval over the policy default, regardless of flag order', () => {
    expect(parseHeadlessArgs(['-p', 'x', '--on-approval', 'allow'], '/d')?.onApproval).toBe('allow')
    expect(parseHeadlessArgs(['-p', 'x', '--on-approval=fail'], '/d')?.onApproval).toBe('fail')
    // Explicit deny survives a later --full-auto (and vice versa) — the flag is
    // resolved after parsing, not positionally.
    expect(parseHeadlessArgs(['-p', 'x', '--on-approval', 'deny', '--full-auto'], '/d')?.onApproval).toBe('deny')
    expect(parseHeadlessArgs(['-p', 'x', '--full-auto', '--on-approval', 'deny'], '/d')?.onApproval).toBe('deny')
  })

  it('fails closed (deny) on an unrecognized --on-approval value, even under full-auto', () => {
    // Falling back to the policy default would make a typo fail OPEN under
    // --full-auto (silently allow); an explicit-but-bogus value must deny.
    expect(parseHeadlessArgs(['-p', 'x', '--full-auto', '--on-approval', 'bogus'], '/d')?.onApproval).toBe('deny')
  })

  it('sets none of the run overrides when their flags are absent', () => {
    const o = parseHeadlessArgs(['-p', 'x'], '/d')!
    expect(o).not.toHaveProperty('effort')
    expect(o).not.toHaveProperty('maxTurns')
    expect(o).not.toHaveProperty('maxCostUsd')
    expect(o).not.toHaveProperty('verifyCommand')
    expect(o).not.toHaveProperty('usageError')
    expect(o).not.toHaveProperty('promptFromStdin')
    expect(headlessOverrides(o)).toBeUndefined()
  })

  describe('--effort', () => {
    it('accepts every reasoning effort, in both flag forms', () => {
      for (const effort of ['off', 'low', 'medium', 'high', 'xhigh']) {
        expect(parseHeadlessArgs(['-p', 'x', '--effort', effort], '/d')?.effort).toBe(effort)
        expect(parseHeadlessArgs(['-p', 'x', `--effort=${effort}`], '/d')?.effort).toBe(effort)
      }
    })

    it('reports an unknown or missing effort as a usage error', () => {
      const bogus = parseHeadlessArgs(['-p', 'x', '--effort', 'max'], '/d')!
      expect(bogus.effort).toBeUndefined()
      expect(bogus.usageError).toBe('--effort must be one of off, low, medium, high, xhigh (got "max")')
      expect(parseHeadlessArgs(['-p', 'x', '--effort=HIGH'], '/d')?.usageError).toMatch(/^--effort must be/)
      expect(parseHeadlessArgs(['-p', 'x', '--effort'], '/d')?.usageError).toContain('(got nothing)')
    })
  })

  describe('--max-turns', () => {
    it('accepts a whole number of at least 1', () => {
      expect(parseHeadlessArgs(['-p', 'x', '--max-turns', '1'], '/d')?.maxTurns).toBe(1)
      expect(parseHeadlessArgs(['-p', 'x', '--max-turns=250'], '/d')?.maxTurns).toBe(250)
    })

    it('reports zero, negatives, fractions, words, and a missing value as usage errors', () => {
      for (const v of ['0', '000', '-3', '1.5', '1e3', 'ten', '', ' 5', '99999999999999999999']) {
        const o = parseHeadlessArgs(['-p', 'x', `--max-turns=${v}`], '/d')!
        expect(o.maxTurns, v).toBeUndefined()
        expect(o.usageError, v).toMatch(/^--max-turns must be a whole number of at least 1/)
      }
      expect(parseHeadlessArgs(['-p', 'x', '--max-turns'], '/d')?.usageError).toContain('(got nothing)')
    })
  })

  describe('--max-cost', () => {
    it('accepts a positive dollar amount', () => {
      expect(parseHeadlessArgs(['-p', 'x', '--max-cost', '2'], '/d')?.maxCostUsd).toBe(2)
      expect(parseHeadlessArgs(['-p', 'x', '--max-cost=0.25'], '/d')?.maxCostUsd).toBe(0.25)
    })

    it('reports zero, negatives, non-numbers, and a missing value as usage errors', () => {
      for (const v of ['0', '-1', 'abc', '', '   ', '$5', 'Infinity', 'NaN']) {
        const o = parseHeadlessArgs(['-p', 'x', `--max-cost=${v}`], '/d')!
        expect(o.maxCostUsd, v).toBeUndefined()
        expect(o.usageError, v).toMatch(/^--max-cost must be a positive amount in US dollars/)
      }
      expect(parseHeadlessArgs(['-p', 'x', '--max-cost'], '/d')?.usageError).toContain('(got nothing)')
    })
  })

  describe('--verify', () => {
    it('takes the command verbatim', () => {
      expect(parseHeadlessArgs(['-p', 'x', '--verify', 'npm test -- --run'], '/d')?.verifyCommand).toBe(
        'npm test -- --run'
      )
      expect(parseHeadlessArgs(['-p', 'x', '--verify=make check'], '/d')?.verifyCommand).toBe('make check')
    })

    it('reports an empty or missing command as a usage error', () => {
      for (const argv of [['--verify'], ['--verify', ''], ['--verify=  ']]) {
        const o = parseHeadlessArgs(['-p', 'x', ...argv], '/d')!
        expect(o.verifyCommand).toBeUndefined()
        expect(o.usageError).toBe('--verify needs a command to run, like --verify "npm test"')
      }
    })
  })

  it('keeps the first bad flag value when several are wrong', () => {
    const o = parseHeadlessArgs(['-p', 'x', '--max-turns', 'lots', '--effort', 'max'], '/d')!
    expect(o.usageError).toMatch(/^--max-turns/)
  })

  it('maps the flags onto run overrides', () => {
    const o = parseHeadlessArgs(
      ['-p', 'x', '--effort', 'high', '--max-turns', '12', '--max-cost', '1.5', '--verify', 'npm test'],
      '/d'
    )!
    expect(headlessOverrides(o)).toEqual({
      reasoningEffort: 'high',
      maxIterations: 12,
      costCeilingUsd: 1.5,
      verifyCommand: 'npm test'
    })
    expect(headlessOverrides(parseHeadlessArgs(['-p', 'x', '--effort', 'off'], '/d')!)).toEqual({
      reasoningEffort: 'off'
    })
  })

  describe('prompt from stdin', () => {
    it('reads stdin for `-p -`, piped or not', () => {
      for (const stdinPiped of [true, false]) {
        const o = parseHeadlessArgs(['-p', '-', '--json'], '/d', { stdinPiped })
        expect(o).toMatchObject({ prompt: '', promptFromStdin: true, json: true })
      }
      expect(parseHeadlessArgs(['--prompt=-'], '/d')?.promptFromStdin).toBe(true)
    })

    it('reads a piped stdin for a -p with no value', () => {
      expect(parseHeadlessArgs(['-p'], '/d', { stdinPiped: true })).toMatchObject({ prompt: '', promptFromStdin: true })
      expect(parseHeadlessArgs(['-p', ''], '/d', { stdinPiped: true })?.promptFromStdin).toBe(true)
      // Nothing piped: still no prompt, so no headless run.
      expect(parseHeadlessArgs(['-p'], '/d', { stdinPiped: false })).toBeNull()
    })

    it('does not swallow the next flag as the prompt', () => {
      const o = parseHeadlessArgs(['-p', '--json', '--full-auto'], '/d', { stdinPiped: true })
      expect(o).toMatchObject({ prompt: '', promptFromStdin: true, json: true, approvalPolicy: 'full-auto' })
      expect(parseHeadlessArgs(['-p', '--max-turns', '3'], '/d', { stdinPiped: true })?.maxTurns).toBe(3)
      // A prompt that is not one of the flags is still a prompt.
      expect(parseHeadlessArgs(['-p', '-v is broken', '--json'], '/d')?.prompt).toBe('-v is broken')
    })

    it('prefers a prompt on the command line over a piped stdin', () => {
      const o = parseHeadlessArgs(['-p', 'fix it'], '/d', { stdinPiped: true, bareStdinPrompt: true })!
      expect(o.prompt).toBe('fix it')
      expect(o.promptFromStdin).toBeUndefined()
    })

    it('reads a piped stdin with no -p only when the host opts in', () => {
      // Desktop binary: a bare launch is the window, whatever stdin holds.
      expect(parseHeadlessArgs(['--json'], '/d', { stdinPiped: true })).toBeNull()
      // Standalone CLI: a bare `houston` in a pipe is a one-shot run.
      expect(parseHeadlessArgs(['--json'], '/d', { stdinPiped: true, bareStdinPrompt: true })).toMatchObject({
        promptFromStdin: true,
        json: true
      })
      expect(parseHeadlessArgs([], '/d', { stdinPiped: false, bareStdinPrompt: true })).toBeNull()
    })
  })

  it('grants shell network only on an explicit --allow-shell-network', () => {
    expect(parseHeadlessArgs(['-p', 'x'], '/d')?.allowShellNetwork).toBe(false)
    expect(
      parseHeadlessArgs(['-p', 'x', '--approval', 'auto-edit', '--allow-shell-network'], '/d')?.allowShellNetwork
    ).toBe(true)
    // Approving calls is not the grant: plain "Allow" runs shell offline interactively too.
    expect(
      parseHeadlessArgs(['-p', 'x', '--approval', 'ask', '--on-approval', 'allow'], '/d')?.allowShellNetwork
    ).toBe(false)
    // A stdin prompt still sees the flag rather than taking it as the prompt text.
    expect(parseHeadlessArgs(['-p', '--allow-shell-network'], '/d', { stdinPiped: true })).toMatchObject({
      promptFromStdin: true,
      allowShellNetwork: true
    })
  })

  it('reports a value on --allow-shell-network as a usage error, never a grant', () => {
    for (const v of ['false', 'true', '']) {
      const o = parseHeadlessArgs(['-p', 'x', `--allow-shell-network=${v}`], '/d')!
      expect(o.allowShellNetwork, v).toBe(false)
      expect(o.usageError, v).toBe('--allow-shell-network takes no value; pass it on its own')
    }
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

  // `recoverable` tells the TUI whether to open /login (missing key / nothing set up)
  // or just report a usage error (bad flag). Headless prints either way.
  it('marks a missing key and an unconfigured profile as recoverable', () => {
    const noKey = resolveHeadlessModel(
      settings({
        providers: [{ id: 'anthropic', requiresKey: true, hasKey: false, models: [{ id: 'claude' }] }],
        selected: { providerId: 'anthropic', model: 'claude' }
      } as Partial<AppSettings>),
      {}
    )
    expect(noKey).toMatchObject({ recoverable: true })
    const empty = resolveHeadlessModel(settings({ providers: [], selected: null }), {})
    expect(empty).toMatchObject({ recoverable: true })
  })

  it('marks a bad --provider and a no-model provider as non-recoverable usage errors', () => {
    expect(resolveHeadlessModel(settings(), { providerId: 'nope' })).toMatchObject({
      recoverable: false
    })
    const noModel = settings({
      providers: [{ id: 'custom-x', requiresKey: false, hasKey: false, models: [] as { id: string }[] }],
      selected: null
    } as Partial<AppSettings>)
    expect(resolveHeadlessModel(noModel, { providerId: 'custom-x' })).toMatchObject({
      error: expect.stringContaining('Pass --model'),
      recoverable: false
    })
  })
})

/** Build deps with a scripted startRun that emits the given events. */
function deps(events: AgentEvent[], extra: Partial<HeadlessDeps> = {}) {
  const out: string[] = []
  const err: string[] = []
  const approvals: Array<[string, string, string]> = []
  const questions: Array<[string, string, string]> = []
  const plans: Array<[string, string, PlanDecision]> = []
  const elicitations: Array<[string, string, ElicitationResult]> = []
  const d: HeadlessDeps = {
    getSettings: () => settings({ selected: { providerId: 'anthropic', model: 'claude' } }),
    startRun: async (_req, send) => {
      for (const e of events) send(e)
    },
    resolveApproval: (r, c, dec) => approvals.push([r, c, dec]),
    resolveQuestion: (r, c, ans) => questions.push([r, c, ans]),
    resolvePlan: (r, c, dec) => plans.push([r, c, dec]),
    resolveElicitation: (r, e, res) => elicitations.push([r, e, res]),
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    newId: () => 'run-1',
    ...extra
  }
  return { d, out, err, approvals, questions, plans, elicitations }
}

const baseOpts: HeadlessOptions = {
  prompt: 'hi',
  cwd: '/proj',
  approvalPolicy: 'plan',
  onApproval: 'deny', // the non-full-auto parse default
  allowShellNetwork: false,
  json: false,
  continueSession: false
}

/** The parsed `--json` lines a run printed. */
function jsonLines(out: string[]): Record<string, unknown>[] {
  return out
    .join('')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

/** The `--json` result line, which must be the last line printed. */
function resultLine(out: string[]): HeadlessResult {
  const lines = jsonLines(out)
  expect(lines.filter((l) => l.type === 'result')).toHaveLength(1)
  expect(lines.at(-1)?.type).toBe('result')
  return lines.at(-1) as unknown as HeadlessResult
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

  it('declines an MCP elicitation so a headless run cannot hang (even under --on-approval allow)', async () => {
    // Mirror the real loop: emit an elicitation and BLOCK until it is resolved.
    let resolveAnswered: (r: ElicitationResult) => void = () => {}
    const answered = new Promise<ElicitationResult>((r) => (resolveAnswered = r))
    const startRun: HeadlessDeps['startRun'] = async (req, send) => {
      send({
        runId: req.runId,
        type: 'elicitation',
        callId: 'm1',
        elicitId: 'm1:e1',
        serverId: 'srv',
        message: 'token?',
        fields: [{ name: 'token', kind: 'string', required: true }]
      })
      const result = await answered
      send({ runId: req.runId, type: 'text', delta: `resolved: ${result.action}` })
      send({ runId: req.runId, type: 'done', stopReason: 'end_turn' })
    }
    const { d, out, err } = deps([], {
      startRun,
      resolveElicitation: (_r, _e, res) => resolveAnswered(res)
    })
    // --on-approval allow approves Houston's own tool calls; it must NOT fabricate
    // field values for an external server's question.
    const code = await runHeadless({ ...baseOpts, onApproval: 'allow' }, d)
    expect(code).toBe(0)
    expect(out.join('')).toContain('resolved: decline')
    expect(err.join('')).toContain('declining input request from MCP server "srv"')
  })

  it('notes ignored project elevating config (untrusted folder) and honors a trusted one silently', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'houston-hl-trust-'))
    try {
      mkdirSync(join(ws, '.houston'), { recursive: true })
      writeFileSync(
        join(ws, '.houston/settings.json'),
        JSON.stringify({ hooks: [{ event: 'Stop', matcher: '*', command: 'echo done' }] })
      )
      const done: AgentEvent[] = [{ runId: 'run-1', type: 'done', stopReason: 'end_turn' }]

      const untrusted = deps(done)
      await runHeadless({ ...baseOpts, cwd: ws }, untrusted.d)
      expect(untrusted.err.join('')).toContain('ignoring this project')

      // Trust the folder under the CURRENT fingerprint: the note disappears.
      const cfg = await loadProjectConfig(ws)
      const trusted = deps(done, {
        getSettings: () =>
          settings({
            selected: { providerId: 'anthropic', model: 'claude' },
            trustedFolders: [
              { path: realpathSync(ws), decision: 'trusted', hash: cfg.elevatedHash, decidedAt: 1 }
            ]
          })
      })
      await runHeadless({ ...baseOpts, cwd: ws }, trusted.d)
      expect(trusted.err.join('')).not.toContain('ignoring this project')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('auto-approves tool approval prompts under --on-approval allow', async () => {
    const { d, err, approvals } = deps([
      { runId: 'run-1', type: 'tool_approval', callId: 'c1', name: 'write_file', summary: 'x', kind: 'write' },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    const code = await runHeadless({ ...baseOpts, approvalPolicy: 'auto-edit', onApproval: 'allow' }, d)
    expect(code).toBe(0)
    expect(approvals).toEqual([['run-1', 'c1', 'allow']])
    expect(err.join('')).toContain('auto-approving write_file')
  })

  it('denies tool approval prompts under --on-approval deny without failing the run', async () => {
    const { d, err, approvals } = deps([
      { runId: 'run-1', type: 'tool_approval', callId: 'c1', name: 'run_shell', summary: 'x', kind: 'shell' },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    const code = await runHeadless({ ...baseOpts, approvalPolicy: 'auto-edit', onApproval: 'deny' }, d)
    // The gated call is refused (the agent adapts), but the run itself is fine.
    expect(code).toBe(0)
    expect(approvals).toEqual([['run-1', 'c1', 'deny']])
    expect(err.join('')).toContain('denying run_shell')
    expect(err.join('')).toContain('--on-approval allow')
  })

  it('denies AND exits non-zero under --on-approval fail so a script sees the permission wall', async () => {
    const { d, approvals } = deps([
      { runId: 'run-1', type: 'tool_approval', callId: 'c1', name: 'run_shell', summary: 'x', kind: 'shell' },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    const code = await runHeadless({ ...baseOpts, approvalPolicy: 'auto-edit', onApproval: 'fail' }, d)
    expect(code).toBe(1)
    expect(approvals).toEqual([['run-1', 'c1', 'deny']])
  })

  it('always resolves an approval prompt (never leaves the loop blocked), whatever the mode', async () => {
    // Mirror the real loop: emit the prompt and BLOCK until it is resolved. If
    // headless dropped the event in any mode, this test would hang.
    for (const onApproval of ['allow', 'deny', 'fail'] as const) {
      let resolveDecision: (d: string) => void = () => {}
      const decided = new Promise<string>((r) => (resolveDecision = r))
      const startRun: HeadlessDeps['startRun'] = async (req, send) => {
        send({ runId: req.runId, type: 'tool_approval', callId: 'c1', name: 'run_shell', summary: 'x', kind: 'shell' })
        await decided
        send({ runId: req.runId, type: 'done', stopReason: 'end_turn' })
      }
      const { d } = deps([], { startRun, resolveApproval: (_r, _c, dec) => resolveDecision(dec) })
      const code = await runHeadless({ ...baseOpts, onApproval }, d)
      expect(code).toBe(onApproval === 'fail' ? 1 : 0)
      expect(await decided).toBe(onApproval === 'allow' ? 'allow' : 'deny')
    }
  })

  describe('shell network', () => {
    /** A startRun that records the request and emits `events`. */
    const capturing = (events: AgentEvent[]) => {
      const reqs: AgentRunRequest[] = []
      const startRun: HeadlessDeps['startRun'] = async (req, send) => {
        reqs.push(req)
        for (const e of events) send(e)
      }
      return { reqs, startRun }
    }
    const shellPrompt = (callId: string, offline: boolean): AgentEvent => ({
      runId: 'run-1',
      type: 'tool_approval',
      callId,
      name: 'run_shell',
      summary: 'npm install',
      kind: 'shell',
      ...(offline ? { shellOffline: true } : {})
    })
    const offlineShellPrompt = (callId: string): AgentEvent => shellPrompt(callId, true)
    const done: AgentEvent = { runId: 'run-1', type: 'done', stopReason: 'end_turn' }

    it('with --allow-shell-network, hands the loop the grant and says so once', async () => {
      // With the grant seeded, the loop's shell prompts carry no shellOffline flag.
      const { reqs, startRun } = capturing([shellPrompt('c1', false), done])
      const { d, err, approvals } = deps([], { startRun })
      const code = await runHeadless(
        { ...baseOpts, approvalPolicy: 'auto-edit', onApproval: 'allow', allowShellNetwork: true },
        d
      )
      expect(code).toBe(0)
      expect(reqs[0]).toMatchObject({ unattended: true, allowShellNetwork: true })
      // The command is still approved like any gated call; the network came from the flag.
      expect(approvals).toEqual([['run-1', 'c1', 'allow']])
      const text = err.join('')
      expect(text.split('may reach the network').length - 1).toBe(1)
      expect(text).not.toContain('without network')
    })

    it('without the flag, sends no grant and notes once that shell runs offline', async () => {
      const { reqs, startRun } = capturing([offlineShellPrompt('c1'), offlineShellPrompt('c2'), done])
      const { d, err, approvals } = deps([], { startRun })
      const code = await runHeadless({ ...baseOpts, approvalPolicy: 'auto-edit', onApproval: 'allow' }, d)
      expect(code).toBe(0)
      expect(reqs[0].unattended).toBe(true)
      expect(reqs[0]).not.toHaveProperty('allowShellNetwork')
      // Plain 'allow', never 'always': --on-approval allow approves calls, it doesn't grant network.
      expect(approvals).toEqual([
        ['run-1', 'c1', 'allow'],
        ['run-1', 'c2', 'allow']
      ])
      const text = err.join('')
      expect(text.split('shell commands run without network').length - 1).toBe(1)
      expect(text).toContain('--allow-shell-network')
      expect(text).not.toContain('may reach the network')
    })

    it('says nothing about network in plan mode (no shell runs) or in --json mode', async () => {
      const plan = deps([done])
      await runHeadless({ ...baseOpts, allowShellNetwork: true }, plan.d)
      expect(plan.err.join('')).not.toContain('network')

      const json = deps([offlineShellPrompt('c1'), done])
      await runHeadless(
        { ...baseOpts, approvalPolicy: 'auto-edit', onApproval: 'allow', allowShellNetwork: true, json: true },
        json.d
      )
      expect(json.err.join('')).toBe('')
    })

    it('resolves the full-auto network consent per --on-approval and names the flag when declining', async () => {
      const consent: AgentEvent = {
        runId: 'run-1',
        type: 'tool_approval',
        callId: 'n1',
        name: 'run_shell',
        summary: 'npm install',
        kind: 'shell',
        shellNetwork: true
      }
      for (const onApproval of ['allow', 'deny', 'fail'] as const) {
        const { d, err, approvals } = deps([consent, done])
        const code = await runHeadless({ ...baseOpts, approvalPolicy: 'full-auto', onApproval }, d)
        // The consent decides only the network (the command runs either way), so even
        // 'fail' doesn't make it a permission wall.
        expect(code).toBe(0)
        expect(approvals).toEqual([['run-1', 'n1', onApproval === 'allow' ? 'allow' : 'deny']])
        expect(err.join('')).toContain(
          onApproval === 'allow' ? 'allowing shell network access' : 'pass --allow-shell-network'
        )
      }
    })
  })

  it('resolves a plan_ready (reject) and prints the plan so present_plan cannot hang', async () => {
    const { d, out, plans } = deps([
      { runId: 'run-1', type: 'plan_ready', callId: 'p1', plan: { title: 'My Plan', body: 'Do it.' } },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    await runHeadless(baseOpts, d)
    // Non-interactive: the plan is printed as the deliverable and rejected (no edits).
    expect(out.join('')).toContain('My Plan')
    expect(plans).toEqual([['run-1', 'p1', { kind: 'reject' }]])
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
      getSettings: () => settings({ providers: [], selected: null })
    })
    expect(await runHeadless(baseOpts, d)).toBe(1)
  })

  /** A session store fake + a startRun that echoes messages to onMessages. */
  type StoredConv = { id: string; workspace: string; messages: ChatMessage[]; providerId?: string; model?: string }
  function withSession(seed: Array<StoredConv> = []) {
    const store = new Map<string, StoredConv>(seed.map((s) => [s.id, { ...s }]))
    let seq = 0
    const base = deps([{ runId: 'run-1', type: 'done', stopReason: 'end_turn' }])
    const { d } = base
    const startedWith: { conversationId?: string; messages: ChatMessage[] }[] = []
    const setModelCalls: Array<[string, string, string]> = []
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
      create: ({ workspace, providerId, model }) => {
        const id = `conv-${++seq}`
        store.set(id, { id, workspace, messages: [], providerId, model })
        return { id }
      },
      setMessages: (id, messages) => {
        const c = store.get(id)
        if (c) c.messages = messages
      },
      setModel: (id, providerId, model) => {
        setModelCalls.push([id, providerId, model])
        const c = store.get(id)
        if (c) {
          c.providerId = providerId
          c.model = model
        }
      }
    }
    return { d, store, startedWith, setModelCalls, out: base.out, err: base.err }
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

  it('rewrites a resumed session stored under a different model to the resolved model', async () => {
    // Prior session was created under a different provider+model than this run resolves to.
    const { d, store, setModelCalls } = withSession([
      { id: 'a', workspace: '/proj', messages: [{ role: 'user', content: 'earlier' }], providerId: 'openai', model: 'gpt' }
    ])
    // Default deps resolve to anthropic/claude (via settings.selected).
    await runHeadless({ ...baseOpts, resumeId: 'a' }, d)
    expect(setModelCalls).toEqual([['a', 'anthropic', 'claude']])
    // Stored meta now tracks the model that actually ran (not the create-time one).
    expect(store.get('a')).toMatchObject({ providerId: 'anthropic', model: 'claude' })
  })

  it('does not call setModel on the fresh-create path (create already stores the model)', async () => {
    const { d, setModelCalls } = withSession()
    await runHeadless(baseOpts, d)
    expect(setModelCalls).toEqual([])
  })

  it('does not crash the run when setModel throws (best-effort persistence)', async () => {
    const { d } = withSession([
      { id: 'a', workspace: '/proj', messages: [{ role: 'user', content: 'earlier' }], providerId: 'openai', model: 'gpt' }
    ])
    d.session!.setModel = () => {
      throw new Error('store write failed')
    }
    const code = await runHeadless({ ...baseOpts, resumeId: 'a' }, d)
    expect(code).toBe(0)
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

  it('surfaces a max-steps limit in plain mode and exits with the limit code', async () => {
    const { d, err } = deps([
      { runId: 'run-1', type: 'limit', reason: 'max-steps' },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    const code = await runHeadless(baseOpts, d)
    // Not 0 (the task isn't finished) and not 1 (nothing broke): its own code.
    expect(code).toBe(HEADLESS_EXIT.limit)
    expect(code).toBe(3)
    expect(err.join('')).toContain('reached the maximum number of steps')
  })

  it('exits with the limit code when the model hits its output limit', async () => {
    const { d, err } = deps([
      { runId: 'run-1', type: 'limit', reason: 'max-output' },
      { runId: 'run-1', type: 'done', stopReason: 'max_tokens' }
    ])
    expect(await runHeadless(baseOpts, d)).toBe(HEADLESS_EXIT.limit)
    expect(err.join('')).toContain('hit its output limit')
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

  it('prints the receipt to stderr and puts it on the result line, without altering the exit code', async () => {
    const receipt = {
      v: 1 as const,
      checks: [
        { kind: 'install' as const, label: 'pip install -r requirements.txt', ok: false, exitCode: 1, blocked: 'network' as const, runs: 1 },
        // A model-written command carrying a terminal escape (OSC 52 clipboard write).
        { kind: 'test' as const, label: 'pytest\u001b]52;c;aGk=\u0007', ok: null, unknown: 'exit-not-attributable' as const, exitCode: 0, runs: 1 }
      ],
      otherCommands: 0,
      filesChanged: ['app.py'],
      filesChangedCount: 1
    }
    const events: AgentEvent[] = [
      { runId: 'run-1', type: 'text', delta: 'All tests pass.' },
      { runId: 'run-1', type: 'receipt', receipt },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ]
    const text = deps(events)
    expect(await runHeadless(baseOpts, text.d)).toBe(0)
    const err = text.err.join('')
    expect(err).toContain('· Recorded by Houston: Test result unknown · install failed (no network) · 1 file changed\n')
    expect(err).toContain('✗ install: pip install -r requirements.txt (exit 1, no network)')
    expect(err).not.toContain('\u001b')
    expect(text.out.join('')).not.toContain('Recorded by Houston')

    const json = deps(events)
    expect(await runHeadless({ ...baseOpts, json: true }, json.d)).toBe(0)
    expect(resultLine(json.out)).toMatchObject({ finalText: 'All tests pass.', receipt })
  })

  it('leaves the receipt off the result line when the run had none', async () => {
    const { d, out } = deps([
      { runId: 'run-1', type: 'text', delta: 'It is a linked list.' },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    await runHeadless({ ...baseOpts, json: true }, d)
    expect(resultLine(out)).not.toHaveProperty('receipt')
  })

  it('prints a notice event (hook systemMessage) to stderr, keeping stdout clean', async () => {
    const { d, out, err } = deps([
      { runId: 'run-1', type: 'notice', message: 'coverage report written to /tmp/cov' },
      { runId: 'run-1', type: 'text', delta: 'answer' },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    expect(await runHeadless(baseOpts, d)).toBe(0)
    expect(err.join('')).toContain('coverage report written to /tmp/cov')
    // stdout stays the model's answer — the note must not pollute a piped result.
    expect(out.join('')).not.toContain('coverage report')
  })

  it('prints a missing runtime with its install command to stderr', async () => {
    const { d, out, err } = deps([
      {
        runId: 'run-1',
        type: 'runtime_missing',
        runtime: 'node',
        label: 'Node.js',
        installCommand: 'brew install node',
        url: 'https://nodejs.org/en/download'
      },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    expect(await runHeadless(baseOpts, d)).toBe(0)
    expect(err.join('')).toContain("Node.js isn't installed")
    expect(err.join('')).toContain('brew install node')
    expect(out.join('')).not.toContain('Node.js')
  })

  it('emits the notice event as raw JSON in --json mode without duplicating to stderr', async () => {
    const { d, out, err } = deps([
      { runId: 'run-1', type: 'notice', message: 'note for the user' },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    expect(await runHeadless({ ...baseOpts, json: true }, d)).toBe(0)
    const lines = out.join('').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toContainEqual({ runId: 'run-1', type: 'notice', message: 'note for the user' })
    expect(err.join('')).not.toContain('note for the user')
  })

  it('warns when verifyOnStop is enabled under a read-only plan run', async () => {
    const { d, err } = deps([{ runId: 'run-1', type: 'done', stopReason: 'end_turn' }], {
      getSettings: () =>
        settings({
          selected: { providerId: 'anthropic', model: 'claude' },
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
          verifyOnStop: true
        })
    })
    await runHeadless({ ...baseOpts, approvalPolicy: 'full-auto' }, d)
    expect(err.join('')).not.toContain('verifyOnStop is enabled')
  })
  it('warns that --verify does nothing in a read-only plan run', async () => {
    const plan = deps([{ runId: 'run-1', type: 'done', stopReason: 'end_turn' }])
    await runHeadless({ ...baseOpts, verifyCommand: 'npm test' }, plan.d)
    expect(plan.err.join('')).toContain('--verify has no effect in a read-only (plan mode) run')
    expect(plan.err.join('')).toContain('--full-auto')

    const auto = deps([{ runId: 'run-1', type: 'done', stopReason: 'end_turn' }])
    await runHeadless({ ...baseOpts, approvalPolicy: 'full-auto', verifyCommand: 'npm test' }, auto.d)
    expect(auto.err.join('')).not.toContain('--verify')
  })
})

describe('runHeadless run request', () => {
  /** Run once and return the request startRun received. */
  async function requestFor(opts: Partial<HeadlessOptions>): Promise<AgentRunRequest> {
    let seen: AgentRunRequest | undefined
    const { d } = deps([], {
      startRun: async (req, send) => {
        seen = req
        send({ runId: req.runId, type: 'done', stopReason: 'end_turn' })
      }
    })
    expect(await runHeadless({ ...baseOpts, ...opts }, d)).toBe(0)
    return seen!
  }

  it('marks every headless run unattended, so the loop withholds ask_user', async () => {
    expect((await requestFor({})).unattended).toBe(true)
    expect((await requestFor({ approvalPolicy: 'full-auto' })).unattended).toBe(true)
  })

  it('sends no overrides when no override flag was given', async () => {
    expect((await requestFor({})).overrides).toBeUndefined()
  })

  it('passes --effort, --max-turns, --max-cost, and --verify as run-only overrides', async () => {
    const req = await requestFor({
      approvalPolicy: 'full-auto',
      effort: 'xhigh',
      maxTurns: 25,
      maxCostUsd: 3,
      verifyCommand: 'npm test'
    })
    expect(req.overrides).toEqual({
      reasoningEffort: 'xhigh',
      maxIterations: 25,
      costCeilingUsd: 3,
      verifyCommand: 'npm test'
    })
  })

  it('never writes an override into the saved settings', async () => {
    const saved = settings({ selected: { providerId: 'anthropic', model: 'claude' }, reasoningEffort: 'low' })
    const before = JSON.stringify(saved)
    const { d } = deps([{ runId: 'run-1', type: 'done', stopReason: 'end_turn' }], { getSettings: () => saved })
    await runHeadless({ ...baseOpts, effort: 'high', maxTurns: 3, maxCostUsd: 1, verifyCommand: 'make' }, d)
    expect(JSON.stringify(saved)).toBe(before)
  })
})

describe('runHeadless usage errors', () => {
  it('reports a bad flag value and exits 2 without starting a run', async () => {
    let started = false
    const { d, out, err } = deps([], {
      startRun: async () => {
        started = true
      }
    })
    const code = await runHeadless({ ...baseOpts, json: true, usageError: '--max-turns must be a whole number' }, d)
    expect(code).toBe(HEADLESS_EXIT.usage)
    expect(code).toBe(2)
    expect(started).toBe(false)
    expect(err.join('')).toBe('--max-turns must be a whole number\n')
    // A malformed invocation prints nothing on stdout, not even a result line.
    expect(out).toEqual([])
  })

  it('reports each bad flag value from the command line the same way', async () => {
    for (const argv of [
      ['--effort', 'max'],
      ['--max-turns', '0'],
      ['--max-cost', 'free'],
      ['--verify', '']
    ]) {
      const opts = parseHeadlessArgs(['-p', 'x', ...argv], '/proj')!
      const { d, err } = deps([{ runId: 'run-1', type: 'done', stopReason: 'end_turn' }])
      expect(await runHeadless(opts, d), argv.join(' ')).toBe(HEADLESS_EXIT.usage)
      expect(err.join(''), argv.join(' ')).toContain(argv[0])
    }
  })
})

describe('runHeadless prompt from stdin', () => {
  it('runs the prompt read from stdin, trimmed', async () => {
    let seen: AgentRunRequest | undefined
    const { d } = deps([], {
      readStdin: async () => '  fix the failing test\n\n',
      startRun: async (req, send) => {
        seen = req
        send({ runId: req.runId, type: 'done', stopReason: 'end_turn' })
      }
    })
    expect(await runHeadless({ ...baseOpts, prompt: '', promptFromStdin: true }, d)).toBe(0)
    expect(seen?.messages).toEqual([{ role: 'user', content: 'fix the failing test' }])
  })

  it('exits 2 without starting a run when stdin is empty', async () => {
    let started = false
    const { d, err } = deps([], {
      readStdin: async () => ' \n',
      startRun: async () => {
        started = true
      }
    })
    expect(await runHeadless({ ...baseOpts, prompt: '', promptFromStdin: true }, d)).toBe(HEADLESS_EXIT.usage)
    expect(started).toBe(false)
    expect(err.join('')).toContain('No prompt: stdin was empty')
  })

  it('exits 2 when the host wired no stdin reader', async () => {
    const { d } = deps([{ runId: 'run-1', type: 'done', stopReason: 'end_turn' }])
    expect(await runHeadless({ ...baseOpts, prompt: '', promptFromStdin: true }, d)).toBe(HEADLESS_EXIT.usage)
  })

  it('does not touch stdin when the prompt came on the command line', async () => {
    let read = false
    const { d } = deps([{ runId: 'run-1', type: 'done', stopReason: 'end_turn' }], {
      readStdin: async () => {
        read = true
        return 'other'
      }
    })
    expect(await runHeadless(baseOpts, d)).toBe(0)
    expect(read).toBe(false)
  })
})

describe('runHeadless --json result line', () => {
  /** A clock that advances 1500ms between the run's start and end. */
  function clock(): () => number {
    let t = 10_000
    return () => {
      const now = t
      t += 1500
      return now
    }
  }

  it('ends a finished run with one result line carrying the totals', async () => {
    const { d, out } = deps(
      [
        { runId: 'run-1', type: 'text', delta: 'Let me look.' },
        { runId: 'run-1', type: 'usage', inputTokens: 1000, outputTokens: 50, cost: 0.01 },
        { runId: 'run-1', type: 'tool_start', callId: 'c1', name: 'read_file', args: {} },
        { runId: 'run-1', type: 'tool_result', callId: 'c1', name: 'read_file', ok: true, output: 'x' },
        // A subagent's rounds roll up into one usage with inputTokens 0: cost, not a turn.
        { runId: 'run-1', type: 'usage', inputTokens: 0, outputTokens: 30, cost: 0.002 },
        { runId: 'run-1', type: 'text', delta: 'Fixed the ' },
        { runId: 'run-1', type: 'text', delta: 'bug.' },
        { runId: 'run-1', type: 'usage', inputTokens: 1200, outputTokens: 20, cost: 0.012 },
        { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
      ],
      { now: clock() }
    )
    expect(await runHeadless({ ...baseOpts, json: true }, d)).toBe(0)
    const r = resultLine(out)
    expect(r).toEqual({
      type: 'result',
      status: 'success',
      stopReason: 'end_turn',
      turns: 2,
      costUsd: 0.024,
      inputTokens: 2200,
      outputTokens: 100,
      durationMs: 1500,
      finalText: 'Fixed the bug.'
    })
    expect(r).not.toHaveProperty('limitReason')
  })

  it('keeps a reply continued past the output limit whole, and drops text answered by a failed verification', async () => {
    const continued = deps([
      { runId: 'run-1', type: 'text', delta: 'part one, ' },
      { runId: 'run-1', type: 'notice', message: 'continuing' },
      { runId: 'run-1', type: 'text', delta: 'part two' },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    await runHeadless({ ...baseOpts, json: true }, continued.d)
    expect(resultLine(continued.out).finalText).toBe('part one, part two')

    const reverified = deps([
      { runId: 'run-1', type: 'text', delta: 'All done.' },
      { runId: 'run-1', type: 'verification', passed: false },
      { runId: 'run-1', type: 'text', delta: 'Fixed the type error.' },
      { runId: 'run-1', type: 'verification', passed: true },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    await runHeadless({ ...baseOpts, json: true }, reverified.d)
    expect(resultLine(reverified.out).finalText).toBe('Fixed the type error.')
  })

  it('reports an empty final text when the run ended on a tool call', async () => {
    const { d, out } = deps([
      { runId: 'run-1', type: 'text', delta: 'Running it.' },
      { runId: 'run-1', type: 'tool_start', callId: 'c1', name: 'run_shell', args: {} },
      { runId: 'run-1', type: 'error', message: 'provider down' }
    ])
    await runHeadless({ ...baseOpts, json: true }, d)
    expect(resultLine(out).finalText).toBe('')
  })

  it('maps every way a run ends to its status, result fields, and exit code', async () => {
    const cases: {
      name: string
      events: AgentEvent[]
      onApproval?: HeadlessOptions['onApproval']
      status: HeadlessStatus
      code: number
      stopReason: string | null
      limitReason?: string
    }[] = [
      {
        name: 'natural finish',
        events: [{ runId: 'run-1', type: 'done', stopReason: 'end_turn' }],
        status: 'success',
        code: 0,
        stopReason: 'end_turn'
      },
      {
        name: 'step cap',
        events: [
          { runId: 'run-1', type: 'limit', reason: 'max-steps' },
          { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
        ],
        status: 'limit',
        code: 3,
        stopReason: 'end_turn',
        limitReason: 'max-steps'
      },
      {
        name: 'output limit',
        events: [
          { runId: 'run-1', type: 'limit', reason: 'max-output' },
          { runId: 'run-1', type: 'done', stopReason: 'max_tokens' }
        ],
        status: 'limit',
        code: 3,
        stopReason: 'max_tokens',
        limitReason: 'max-output'
      },
      {
        name: 'stall',
        events: [
          { runId: 'run-1', type: 'limit', reason: 'stalled' },
          { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
        ],
        status: 'stalled',
        code: 1,
        stopReason: 'end_turn',
        limitReason: 'stalled'
      },
      {
        name: 'error event with no done',
        events: [{ runId: 'run-1', type: 'error', message: 'boom' }],
        status: 'error',
        code: 1,
        stopReason: null
      },
      {
        name: 'done with an error stop',
        events: [{ runId: 'run-1', type: 'done', stopReason: 'error' }],
        status: 'error',
        code: 1,
        stopReason: 'error'
      },
      {
        name: 'aborted',
        events: [{ runId: 'run-1', type: 'done', stopReason: 'aborted' }],
        status: 'error',
        code: 1,
        stopReason: 'aborted'
      },
      {
        name: 'approval refused under --on-approval fail',
        events: [
          { runId: 'run-1', type: 'tool_approval', callId: 'c1', name: 'run_shell', summary: 'x', kind: 'shell' },
          { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
        ],
        onApproval: 'fail',
        status: 'approval_denied',
        code: 1,
        stopReason: 'end_turn'
      },
      {
        name: 'approval refused under --on-approval deny',
        events: [
          { runId: 'run-1', type: 'tool_approval', callId: 'c1', name: 'run_shell', summary: 'x', kind: 'shell' },
          { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
        ],
        onApproval: 'deny',
        status: 'success',
        code: 0,
        stopReason: 'end_turn'
      },
      {
        // A failure outranks a budget stop: the run didn't merely run out of room.
        name: 'refused approval, then the step cap',
        events: [
          { runId: 'run-1', type: 'tool_approval', callId: 'c1', name: 'run_shell', summary: 'x', kind: 'shell' },
          { runId: 'run-1', type: 'limit', reason: 'max-steps' },
          { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
        ],
        onApproval: 'fail',
        status: 'approval_denied',
        code: 1,
        stopReason: 'end_turn',
        limitReason: 'max-steps'
      },
      {
        name: 'error after the step cap',
        events: [
          { runId: 'run-1', type: 'limit', reason: 'max-steps' },
          { runId: 'run-1', type: 'error', message: 'boom' }
        ],
        status: 'error',
        code: 1,
        stopReason: null,
        limitReason: 'max-steps'
      }
    ]
    for (const c of cases) {
      for (const json of [true, false]) {
        const { d, out } = deps(c.events)
        const code = await runHeadless({ ...baseOpts, json, onApproval: c.onApproval ?? 'deny' }, d)
        expect(code, `${c.name} (json=${json})`).toBe(c.code)
        if (!json) continue
        const r = resultLine(out)
        expect(r.status, c.name).toBe(c.status)
        expect(r.stopReason, c.name).toBe(c.stopReason)
        expect(r.limitReason, c.name).toBe(c.limitReason)
        expect(headlessExitCode(r.status), c.name).toBe(c.code)
      }
    }
  })

  it('writes a result line when the run cannot start for want of a model', async () => {
    const { d, out } = deps([], { getSettings: () => settings({ providers: [], selected: null }) })
    expect(await runHeadless({ ...baseOpts, json: true }, d)).toBe(HEADLESS_EXIT.failed)
    expect(resultLine(out)).toMatchObject({ type: 'result', status: 'error', stopReason: null, turns: 0 })
  })

  it('prints no result line in text mode', async () => {
    const { d, out, err } = deps([
      { runId: 'run-1', type: 'text', delta: 'answer' },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    await runHeadless(baseOpts, d)
    expect(out.join('')).toBe('answer\n')
    expect(err.join('') + out.join('')).not.toContain('"result"')
  })

  it('puts the result after the session line and every event', async () => {
    const { d, out } = deps([
      { runId: 'run-1', type: 'text', delta: 'hi' },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    d.session = {
      load: () => null,
      create: () => ({ id: 'conv-1' }),
      setMessages: () => {},
      setModel: () => {}
    }
    await runHeadless({ ...baseOpts, json: true }, d)
    expect(jsonLines(out).map((l) => l.type)).toEqual(['session', 'text', 'done', 'result'])
  })
})

describe('headlessExitCode', () => {
  it('gives success 0, a budget stop 3, and every failure 1', () => {
    expect(headlessExitCode('success')).toBe(0)
    expect(headlessExitCode('limit')).toBe(3)
    expect(headlessExitCode('stalled')).toBe(1)
    expect(headlessExitCode('approval_denied')).toBe(1)
    expect(headlessExitCode('error')).toBe(1)
    expect(HEADLESS_EXIT).toEqual({ ok: 0, failed: 1, usage: 2, limit: 3 })
  })
})

describe('live tool progress (text mode)', () => {
  it('prints tool_progress and subagent lines to stderr so a long dispatch is not silent', async () => {
    const { d, err } = deps([
      { runId: 'run-1', type: 'tool_start', callId: 'c1', name: 'dispatch_agent', args: {} },
      { runId: 'run-1', type: 'tool_progress', callId: 'c1', message: 'turn 3/16 · Read note.txt' },
      { runId: 'run-1', type: 'subagent', parentCallId: 'c1', id: 'sec', label: 'Security', status: 'running' },
      { runId: 'run-1', type: 'subagent', parentCallId: 'c1', id: 'sec', label: 'Security', status: 'done' },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    await runHeadless(baseOpts, d)
    const stderr = err.join('')
    expect(stderr).toContain('turn 3/16 · Read note.txt')
    expect(stderr).toContain('▷ Security')
    expect(stderr).toContain('✓ Security')
  })

  it('prints each review finding and its verdict to stderr once per status change', async () => {
    const finding = (status: 'candidate' | 'verifying' | 'confirmed', cast: number): AgentEvent => ({
      runId: 'run-1',
      type: 'review_finding',
      parentCallId: 'c1',
      finding: {
        id: 'security:0',
        dimension: 'security',
        severity: 'high',
        location: 'a.ts:1',
        title: 'hole',
        status,
        votes: { confirmed: cast, cast, total: 3 }
      }
    })
    const { d, err, out } = deps([
      { runId: 'run-1', type: 'tool_start', callId: 'c1', name: 'review_changes', args: {} },
      finding('candidate', 0),
      finding('verifying', 1),
      finding('confirmed', 2),
      finding('confirmed', 3),
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ])
    await runHeadless(baseOpts, d)
    const stderr = err.join('')
    expect(stderr).toContain('◇ HIGH      a.ts:1  hole')
    expect(stderr.match(/✓ HIGH/g)).toHaveLength(1)
    expect(out.join('')).not.toContain('hole')
  })

  it('keeps progress off stdout, and out of --json mode text output', async () => {
    const events: AgentEvent[] = [
      { runId: 'run-1', type: 'tool_progress', callId: 'c1', message: 'working' },
      { runId: 'run-1', type: 'done', stopReason: 'end_turn' }
    ]
    const { d, out } = deps(events)
    await runHeadless(baseOpts, d)
    expect(out.join('')).toBe('\n') // just the final newline — stdout stays clean
    const { d: dj, err: errJson } = deps(events)
    await runHeadless({ ...baseOpts, json: true }, dj)
    // JSON mode already carries the raw event on stdout; no duplicate stderr line.
    expect(errJson.join('')).not.toContain('working')
  })
})

// Parity with the GUI reducer (items.test.ts) and the TUI (tui.test.ts): a turn the loop
// throws away mid-stream and redoes must leave one copy of the reply. stdout can't be
// taken back, so text mode holds each round's text until the round is over.
describe('a turn the loop discarded and redid', () => {
  const text = (delta: string): AgentEvent => ({ runId: 'run-1', type: 'text', delta })
  const discarded: AgentEvent = {
    runId: 'run-1',
    type: 'turn_discarded',
    attempt: 1,
    reason: 'Overloaded',
    textChars: 'The answer is forty'.length,
    reasoningChars: 0
  }
  const retry: AgentEvent = { runId: 'run-1', type: 'retry', attempt: 1, max: 6, message: 'Overloaded' }
  const done: AgentEvent = { runId: 'run-1', type: 'done', stopReason: 'end_turn' }

  it('writes only the redo to stdout', async () => {
    const { d, out, err } = deps([
      text('The answer is '),
      text('forty'),
      discarded,
      retry,
      text('The answer is 42.'),
      done
    ])
    expect(await runHeadless(baseOpts, d)).toBe(0)
    expect(out.join('')).toBe('The answer is 42.\n')
    expect(err.join('')).toContain('discarded a reply cut off mid-stream')
    expect(err.join('')).toContain('retrying (1/6)')
  })

  it("releases each round's text when the round ends, ahead of what follows it", async () => {
    const log: string[] = []
    const { d } = deps(
      [
        text('Reading it.'),
        { runId: 'run-1', type: 'tool_start', callId: 'c1', name: 'read_file', args: {} },
        text('Half'),
        { ...discarded, textChars: 4 },
        retry,
        text('Done.'),
        done
      ],
      { out: (s) => log.push(`out:${s}`), err: (s) => log.push(`err:${s}`) }
    )
    await runHeadless(baseOpts, d)
    expect(log[0]).toBe('out:Reading it.')
    expect(log[1]).toBe('err:· read_file\n')
    expect(log.filter((l) => l.startsWith('out:')).join('')).toBe('out:Reading it.out:Done.out:\n')
  })

  it('keeps a partial reply on stdout when the run ends on the failure', async () => {
    // Not retried, so not discarded: the partial is all there is, ahead of the error.
    const { d, out, err } = deps([text('Partial'), { runId: 'run-1', type: 'error', message: 'invalid request' }])
    expect(await runHeadless(baseOpts, d)).toBe(1)
    expect(out.join('')).toBe('Partial')
    expect(err.join('')).toContain('invalid request')
  })

  it('passes the event through in --json mode, and keeps the partial out of the result', async () => {
    const { d, out } = deps([
      text('Reading. '),
      { runId: 'run-1', type: 'tool_start', callId: 'c1', name: 'read_file', args: {} },
      text('So: '),
      text('The answer is forty'),
      { ...discarded, textChars: 'So: The answer is forty'.length },
      retry,
      text('So: The answer is 42.'),
      done
    ])
    await runHeadless({ ...baseOpts, json: true }, d)
    const lines = out.map((l) => JSON.parse(l) as { type: string } & Record<string, unknown>)
    expect(lines.map((e) => e.type)).toEqual([
      'text',
      'tool_start',
      'text',
      'text',
      'turn_discarded',
      'retry',
      'text',
      'done',
      'result'
    ])
    expect(lines[4]).toMatchObject({ textChars: 23, reasoningChars: 0, attempt: 1 })
    // The closing answer holds the redo once: the dropped round's text is taken back.
    expect(lines.at(-1)).toMatchObject({ status: 'success', finalText: 'So: The answer is 42.' })
  })
})
