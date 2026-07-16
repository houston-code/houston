/**
 * Task-level (SWE-bench-style) evals: does the harness carry a unit of real work
 * to a green test?
 *
 * Each task is a fixture repo with a seeded defect and a verify command that
 * exits non-zero until the work is actually done. The suite copies the fixture
 * to a throwaway workspace, drives the REAL agent loop (`startRun`) against it,
 * then grades on the verify command's exit code — not on what the transcript
 * says happened. `golden.test.ts` pins the shape of what the agent *says*; this
 * pins whether the agent *accomplishes* anything.
 *
 * TWO DRIVERS, one set of fixtures (see `types.ts` for the split's rationale):
 *
 *   npm run eval                       scripted — deterministic, offline, gates PRs
 *   HOUSTON_EVAL_LIVE=1 npm run eval   live     — real model, graded vs a baseline
 *   npm run eval:baseline              live     — record a model's baseline
 *
 * The scripted driver grades EXECUTION and the live driver grades QUALITY; the
 * distinction is the point, and neither substitutes for the other. Gut the whole
 * system prompt and the scripted suite still passes every task — the answer was
 * in the script — while the live suite collapses. Conversely a tool that stops
 * applying its edit fails scripted immediately.
 *
 * Live mode reads the key from the standard provider env vars (@shared/provider-keys),
 * and is selected with:
 *   HOUSTON_EVAL_PROVIDER    provider id   (default: anthropic)
 *   HOUSTON_EVAL_MODEL       model id      (default: that provider's default model)
 *   HOUSTON_EVAL_ATTEMPTS    runs per task (default: 3 live, 1 scripted)
 *   HOUSTON_EVAL_RECORD=1    record the baseline instead of grading against it
 *
 * WHY THIS FILE OWNS EVERYTHING. `startRun` takes no provider parameter — it
 * reaches for `createProvider`/`agentHost` as module singletons — so the only
 * injection seam is `vi.mock` + a deferred `await import('../loop')`. `vi.mock`
 * is file-scoped, so the driver cannot be factored into a helper another test
 * file imports: the helper's `./loop` would bind to the unmocked module and
 * quietly call a real provider. Fixture plumbing that needs no mocks lives in
 * `fixtures.ts`; everything mock-bound stays here.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentEvent, ChatRequest, Provider, ProviderStreamEvent } from '@shared/agent'
import type { ProviderConfig } from '@shared/types'
import { defaultProviders } from '@shared/defaults'
import { providerKeyEnvVars } from '@shared/provider-keys'
import {
  baselineFileName,
  compareToBaseline,
  isEvalBaseline,
  recordBaseline,
  type BaselineVerdict,
  type EvalBaseline,
  type TaskScore
} from './baseline'
import { materializeTask, runVerify, taskDirNames } from './fixtures'
import { formatReport, type TaskReport } from './report'
import { TASKS } from './tasks'
import type { EvalResult, EvalTask } from './types'

// ---- driver selection ----

const LIVE = process.env.HOUSTON_EVAL_LIVE === '1'
const PROVIDER_ID = process.env.HOUSTON_EVAL_PROVIDER ?? 'anthropic'

function liveProviderConfig(): ProviderConfig {
  const cfg = defaultProviders().find((p) => p.id === PROVIDER_ID)
  if (!cfg) throw new Error(`HOUSTON_EVAL_PROVIDER=${PROVIDER_ID} is not a known provider id`)
  return cfg
}

/** The key for the live provider, from the same env vars the CLI honors. */
function liveKey(): string | null {
  for (const name of providerKeyEnvVars(PROVIDER_ID)) {
    const v = process.env[name]
    if (v) return v
  }
  return null
}

const MODEL = LIVE
  ? (process.env.HOUSTON_EVAL_MODEL ?? liveProviderConfig().defaultModel ?? '')
  : 'claude-sonnet-5'

// A live run with no key would otherwise fail every task with an opaque provider
// error and read as eight harness regressions. Fail loudly on the misconfiguration.
if (LIVE && !liveKey()) {
  const names = providerKeyEnvVars(PROVIDER_ID).join(' or ')
  throw new Error(`HOUSTON_EVAL_LIVE=1 needs a key for "${PROVIDER_ID}" — set ${names}.`)
}

/** Recording a baseline scores the model without grading it against one. */
const RECORD = process.env.HOUSTON_EVAL_RECORD === '1'

/**
 * Scripted runs are deterministic, so a repeat says nothing. A live model is
 * noisy enough that a single attempt per task is a coin-flip signal, so it is
 * averaged over several by default.
 */
const ATTEMPTS = Number(process.env.HOUSTON_EVAL_ATTEMPTS) || (LIVE ? 3 : 1)

const BASELINES_DIR = fileURLToPath(new URL('./baselines', import.meta.url))
const baselineFile = join(BASELINES_DIR, baselineFileName(PROVIDER_ID, MODEL))

/**
 * Load the recorded baseline for the live model, or explain how to make one.
 *
 * Live mode REQUIRES a baseline rather than degrading to "just print a scorecard":
 * an ungated live run is a log line, not a regression test, and a model added
 * without a baseline would silently opt itself out of the only quality gate there
 * is. That is the same false-green this suite exists to prevent, so a missing
 * baseline reds the job with the command that fixes it.
 */
function loadBaseline(): EvalBaseline {
  if (!existsSync(baselineFile)) {
    throw new Error(
      [
        `No quality baseline recorded for "${PROVIDER_ID}/${MODEL}".`,
        `Expected: ${baselineFile}`,
        '',
        'A live run without a baseline can only print a scorecard, which gates nothing.',
        'Record one (this makes real, billed model calls), review the scores, and commit it:',
        '',
        `  HOUSTON_EVAL_PROVIDER=${PROVIDER_ID} HOUSTON_EVAL_MODEL=${MODEL} npm run eval:baseline`
      ].join('\n')
    )
  }
  const parsed: unknown = JSON.parse(readFileSync(baselineFile, 'utf8'))
  if (!isEvalBaseline(parsed)) {
    throw new Error(`Baseline at ${baselineFile} is malformed — re-record it with npm run eval:baseline.`)
  }
  return parsed
}

const BASELINE = LIVE && !RECORD ? loadBaseline() : null

// ---- mocks (must precede the loop import) ----

const h = vi.hoisted(() => {
  const live = process.env.HOUSTON_EVAL_LIVE === '1'
  return {
    live,
    /** The scripted fake, swapped in per task. Unused in live mode. */
    provider: null as Provider | null,
    kind: 'anthropic' as string,
    key: null as string | null,
    models: [] as unknown[],
    settings: {} as Record<string, unknown>
  }
})

vi.mock('../../agentHost', () => ({
  getSettings: () => h.settings,
  addPermissionRule: () => {},
  getProvider: (id: string) => ({
    id,
    // Scripted mode never reaches a real adapter, so the id doubles as the kind.
    kind: h.live ? h.kind : id,
    label: id,
    models: h.models,
    requiresKey: false,
    hasKey: true,
    builtIn: true
  }),
  getKey: () => h.key,
  collectSecrets: () => []
}))
// The one seam that differs by driver: scripted gets the fake, live gets the real
// adapter. Everything downstream of this line is identical between the two.
vi.mock('../../providers', async (importActual) => {
  const actual = await importActual<typeof import('../../providers')>()
  return {
    ...actual,
    createProvider: (cfg: ProviderConfig): Provider => (h.live ? actual.createProvider(cfg) : h.provider!)
  }
})
vi.mock('../../mcp/manager', () => ({ getMcpToolDefs: async () => [] }))
vi.mock('../managedPolicy', () => ({ loadManagedPolicy: async () => ({ permissionRules: [] }) }))
// The real loader reads the developer's global CLAUDE.md — machine state that
// would make an eval pass or fail based on whose laptop it ran on.
vi.mock('../rules', async (importActual) => ({
  ...(await importActual<typeof import('../rules')>()),
  loadProjectRules: async () => ({ text: '', files: [] })
}))
// Fixtures are not git repos, and a real `git`/`gh` probe would put the *host*
// repo's branch into the prompt when the fixture has no repo of its own.
vi.mock('../git', () => ({ gitContext: async () => '' }))
vi.mock('../github', async (importActual) => ({
  ...(await importActual<typeof import('../github')>()),
  githubContext: () => ''
}))
vi.mock('../plugins', () => {
  const inert = { has: () => false, size: 0, emit: async () => {} }
  return { loadPlugins: async () => inert, loadPluginsIfEnabled: async () => inert }
})

// Imported after the mocks are registered.
const { startRun, resolveApproval, resolveQuestion, resolvePlan } = await import('../loop')

// ---- scripted provider ----

/** Replays one scripted turn per model round-trip; ends the run when it runs dry. */
function scriptedProvider(turns: ProviderStreamEvent[][]): Provider {
  let i = 0
  return {
    async *streamChat(_req: ChatRequest) {
      const turn = turns[i++] ?? [{ type: 'done', stopReason: 'end_turn' as const }]
      for (const ev of turn) yield ev
    }
  }
}

// ---- run ----

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'houston-eval-'))
  h.kind = LIVE ? liveProviderConfig().kind : 'anthropic'
  h.key = LIVE ? liveKey() : null
  h.models = LIVE ? liveProviderConfig().models : []
  h.settings = {
    // 0 disables compaction — a fixture task never fills a window, and a
    // mid-eval compaction would grade the summarizer, not the task.
    compactionThreshold: 0,
    reasoningEffort: 'off',
    permissionRules: [],
    hooks: [],
    mcpServers: [],
    additionalRoots: [],
    projectPlugins: false
  }
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** Drive one task end to end and grade it. */
async function runTask(task: EvalTask): Promise<EvalResult> {
  const ws = materializeTask(task, tmpRoot)
  h.provider = scriptedProvider(task.script)

  const runId = `eval-${task.id}`
  const events: AgentEvent[] = []
  const send = (e: AgentEvent): void => {
    events.push(e)
    // Resolve every blocking interaction on a later tick, as the real clients do.
    // Not optional: `full-auto` deliberately cannot auto-approve an unsandboxed
    // shell, so on a CI host without a working sandbox an unanswered prompt hangs
    // the run instead of failing it.
    if (e.type === 'tool_approval') {
      setTimeout(() => resolveApproval(runId, e.callId, 'allow'), 0)
    }
    // Neither is reachable from the scripted fixtures, but a live model can call
    // ask_user or present_plan on its own, and an unresolved one hangs the run.
    if (e.type === 'tool_question') {
      setTimeout(() => resolveQuestion(runId, e.callId, 'Use your best judgement and continue.'), 0)
    }
    if (e.type === 'plan_ready') {
      setTimeout(() => resolvePlan(runId, e.callId, { kind: 'accept', mode: 'auto-edit' }), 0)
    }
  }

  const started = Date.now()
  await startRun(
    {
      runId,
      workspace: ws,
      providerId: PROVIDER_ID,
      model: MODEL,
      approvalPolicy: task.policy ?? 'full-auto',
      messages: [{ role: 'user', content: task.prompt }]
    },
    send
  )
  const durationMs = Date.now() - started

  const verdict = runVerify(task.verify, ws)
  const errored = events.find((e) => e.type === 'error')
  const limited = events.find((e) => e.type === 'limit')
  return {
    taskId: task.id,
    passed: verdict.ok,
    exitCode: verdict.exitCode,
    verifyOutput: verdict.output,
    toolsUsed: events.filter((e) => e.type === 'tool_start').map((e) => e.name),
    durationMs,
    error: errored?.message ?? (limited ? `run hit a limit: ${limited.reason}` : undefined),
    costUsd: events.reduce((n, e) => n + (e.type === 'usage' ? e.cost : 0), 0)
  }
}

// ---- suites ----

describe('eval fixtures', () => {
  it('registers every task directory exactly once', () => {
    expect(TASKS.map((t) => t.id).sort()).toEqual(taskDirNames())
  })

  // A verify command that is already green grades every future regression as a
  // pass. Every task must start red, so a pass can only mean the agent did work.
  it.each(TASKS.map((t) => [t.id, t] as const))('%s fails before the agent runs', (_id, task) => {
    const ws = materializeTask(task, tmpRoot)
    expect(runVerify(task.verify, ws).ok).toBe(false)
  })
})

describe(`task evals (${LIVE ? 'live' : 'scripted'} driver)`, () => {
  const reports: TaskReport[] = []

  afterAll(() => {
    if (!reports.length) return
    console.log(formatReport({ driver: LIVE ? 'live' : 'scripted', model: MODEL, attempts: ATTEMPTS }, reports))
    if (!RECORD) return
    // Recording writes the scorecard as the model's new baseline. Reviewed and
    // committed like a golden: the diff is what documents the behavior change.
    const scores: TaskScore[] = reports.map((r) => ({
      taskId: r.taskId,
      passRate: r.passRate,
      attempts: r.attempts
    }))
    mkdirSync(BASELINES_DIR, { recursive: true })
    const baseline = recordBaseline(PROVIDER_ID, MODEL, ATTEMPTS, scores, new Date())
    writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`)
    console.log(`Recorded baseline → ${baselineFile}\nReview the scores and commit it.`)
  })

  it.each(TASKS.map((t) => [t.id, t] as const))(
    '%s',
    async (_id, task) => {
      const attempts: EvalResult[] = []
      for (let i = 0; i < ATTEMPTS; i++) attempts.push(await runTask(task))
      const passes = attempts.filter((a) => a.passed).length
      const passRate = passes / ATTEMPTS
      // Show a failure when there was one: a run that passed 2/3 is far more
      // informative reported through the attempt that failed.
      const sample = attempts.find((a) => !a.passed) ?? attempts[attempts.length - 1]
      const verdict: BaselineVerdict | undefined = BASELINE
        ? compareToBaseline(BASELINE, [{ taskId: task.id, passRate, attempts: ATTEMPTS }])[0]
        : undefined
      reports.push({
        taskId: task.id,
        attempts: ATTEMPTS,
        passRate,
        sample,
        costUsd: attempts.reduce((n, a) => n + a.costUsd, 0),
        durationMs: attempts.reduce((n, a) => n + a.durationMs, 0),
        verdict
      })

      // The transcript matters on failure: "verify exited 1" alone can't
      // distinguish a bad edit from a tool that never dispatched at all.
      const detail = [
        `  tools: ${sample.toolsUsed.join(' > ') || '(none dispatched)'}`,
        sample.error ? `  run error: ${sample.error}` : '',
        `  verify output:\n${sample.verifyOutput}`
      ]
        .filter(Boolean)
        .join('\n')

      // SCRIPTED grades execution: the plan was handed to the agent, so anything
      // short of every attempt green is a harness regression.
      if (!LIVE) {
        expect(
          passRate,
          `Task "${task.id}" did not reach a green verify (exit ${sample.exitCode}).\n${detail}`
        ).toBe(1)
        return
      }

      // RECORDING: score, don't grade. The whole point is to capture what the
      // model does today, including the tasks it can't do.
      if (RECORD) return

      // LIVE grades quality against the recorded baseline, with a tolerance that
      // absorbs one flaked attempt (see DEFAULT_TOLERANCE).
      expect(
        verdict?.kind,
        [
          `Task "${task.id}" scored ${passes}/${ATTEMPTS} against a baseline of ` +
            `${(BASELINE?.tasks[task.id] ?? NaN).toFixed(2)} (recorded ${BASELINE?.recordedAt}).`,
          'A drop this size is a QUALITY regression, not model noise.',
          detail
        ].join('\n')
      ).not.toBe('regressed')
    },
    // A scripted task is a handful of local tool calls; a live one is real model
    // latency over several turns, repeated for every attempt.
    LIVE ? 300_000 * ATTEMPTS : 60_000
  )
})
