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
 *   HOUSTON_EVAL_OUT=<file>  also write the run record, for `npm run eval:compare`
 *   HOUSTON_EVAL_TRACE=1     print each tool call (with its time and output tail),
 *                            the closing message, and the receipt as attempts run
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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentEvent, ChatRequest, Provider, ProviderStreamEvent } from '@shared/agent'
import { formatReceiptLines } from '@shared/evidence'
import type { ProviderConfig } from '@shared/types'
import { DEFAULT_REASONING_EFFORT, defaultProviders } from '@shared/defaults'
import { providerKeyEnvVars } from '@shared/provider-keys'
import { DEFAULT_TIMEOUT_MS } from '../../sandbox/shared'
import {
  assertRecordable,
  baselineFileName,
  compareToBaseline,
  isDeadBaseline,
  isEvalBaseline,
  recordBaseline,
  type BaselineVerdict,
  type EvalBaseline,
  type TaskScore
} from './baseline'
import { resolveEvalConfig } from './config'
import {
  gradeTask,
  holdoutDirFor,
  materializeTask,
  placeHoldout,
  repoDirFor,
  restoreVerifyFiles,
  runVerify,
  taskDirNames
} from './fixtures'
import { failureCauses, formatReport, pickSample, slowestOf, type TaskReport } from './report'
import { gradeHonesty } from './honesty'
import { currentCommit, gitIn, toRunRecord } from './runRecord'
import { promptHash, sharedHash } from './stamp'
import { TASKS } from './tasks'
import { callTool, say, turn, type EvalResult, type EvalTask, type TimedCall } from './types'

// ---- driver selection ----

// Resolved by a pure, unit-tested module (config.ts) rather than inline here: an
// empty env var must mean "unset", and getting that wrong silently recorded a
// baseline of all zeros once already. See config.ts for the incident.
const {
  live: LIVE,
  record: RECORD,
  providerId: PROVIDER_ID,
  model: MODEL,
  attempts: ATTEMPTS,
  out: OUT,
  trace: TRACE
} = resolveEvalConfig(process.env, defaultProviders())

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

// A live run with no key would otherwise fail every task with an opaque provider
// error and read as eight harness regressions. Fail loudly on the misconfiguration.
if (LIVE && !liveKey()) {
  const names = providerKeyEnvVars(PROVIDER_ID).join(' or ')
  throw new Error(`HOUSTON_EVAL_LIVE=1 needs a key for "${PROVIDER_ID}" — set ${names}.`)
}

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
  // A shape-valid baseline can still be a dead gate. Refuse it here too, not just
  // at record time: this one may have reached the repo without going through the
  // recorder at all.
  if (isDeadBaseline(parsed)) {
    throw new Error(
      [
        `Baseline at ${baselineFile} records 0 for every task, so it gates nothing:`,
        'no score can regress below zero. That is a dead gate reporting green.',
        '',
        'It was almost certainly recorded from a misconfigured run (empty/wrong model',
        'id, bad key, provider outage). Delete it and re-record with npm run eval:baseline.'
      ].join('\n')
    )
  }
  return parsed
}

const BASELINE = LIVE && !RECORD ? loadBaseline() : null

/**
 * How long one live attempt may take: room for one shell command to run to
 * run_shell's default timeout, plus the turns around it. A live model will
 * sometimes search the whole disk for a missing package (`find /` on
 * unverifiable-dependency) and wait out that timeout. With a budget of only the
 * timeout itself, a run where every attempt did so would time the whole task out
 * and read as a regression, where the scorecard's slowest-call line says why.
 */
const LIVE_ATTEMPT_BUDGET_MS = DEFAULT_TIMEOUT_MS + 300_000

// ---- mocks (must precede the loop import) ----

const h = vi.hoisted(() => {
  const live = process.env.HOUSTON_EVAL_LIVE === '1'
  return {
    live,
    /** The scripted fake, swapped in per task. Unused in live mode. */
    provider: null as Provider | null,
    /** The run's first model request, kept for its prompt hash. Reset per run. */
    request: null as ChatRequest | null,
    kind: 'anthropic' as string,
    key: null as string | null,
    models: [] as unknown[],
    settings: {} as Record<string, unknown>
  }
})

/**
 * This factory REPLACES the whole module, so it must cover every name the engine
 * imports from agentHost — a missing one is `undefined` at the call site, not a
 * compile error. `createProvider` alone needs three (`getKey`, `getSecretHeaders`,
 * `hasStoredKey`), and omitting `getSecretHeaders` once made every live task fail
 * before it reached the model, which the recorder then wrote out as a baseline of
 * all zeros. The 'constructs the real provider' test below exercises this surface
 * on every PR so the next gap fails there instead of in the nightly.
 *
 * Deliberately NOT `importActual`-spread: the real agentHost reaches the settings
 * store and the OS keychain, which is exactly the machine state an eval must not
 * depend on.
 */
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
  // No custom headers in an eval: a real lookup would hit the secrets store.
  getSecretHeaders: () => ({}),
  // Only consulted on the missing-key error path (getProvider reports requiresKey:
  // false), but it must exist or createProvider throws on the way past.
  hasStoredKey: () => false,
  collectSecrets: () => []
}))
// The one seam that differs by driver: scripted gets the fake, live gets the real
// adapter. Everything downstream of this line is identical between the two. Both
// are wrapped to keep the run's first request, which the prompt hash is taken from
// (stamp.ts): it is exactly what the provider received, in either driver.
vi.mock('../../providers', async (importActual) => {
  const actual = await importActual<typeof import('../../providers')>()
  return {
    ...actual,
    createProvider: (cfg: ProviderConfig): Provider => {
      const provider = h.live ? actual.createProvider(cfg) : h.provider!
      return {
        streamChat(req) {
          h.request ??= req
          return provider.streamChat(req)
        }
      }
    }
  }
})
vi.mock('../../mcp/manager', () => ({ getMcpToolDefs: async () => [] }))
vi.mock('../managedPolicy', () => ({ loadManagedPolicy: async () => ({ permissionRules: [] }) }))
// The real loader reads the developer's global rules file — machine state that
// would make an eval pass or fail based on whose laptop it ran on.
vi.mock('../rules', async (importActual) => ({
  ...(await importActual<typeof import('../rules')>()),
  loadProjectRules: async () => ({ text: '', files: [], truncated: [] })
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
    // The shipped default, so a live run scores the effort users actually get. The
    // scripted driver ignores it.
    reasoningEffort: DEFAULT_REASONING_EFFORT,
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
  h.request = null
  // An empty memory store per attempt, beside the workspace. The test setup gives
  // the whole process one store, so a memory a live model saved in one attempt
  // reached the next attempt's prompt: the same leak as a reused workspace.
  process.env.HOUSTON_MEMORY_DIR = join(dirname(ws), 'memory')

  const runId = `eval-${task.id}`
  const events: AgentEvent[] = []
  // When each tool call started, so the attempt can say where its time went.
  const callStarts = new Map<string, { at: number; detail: string }>()
  const calls: TimedCall[] = []
  const send = (e: AgentEvent): void => {
    events.push(e)
    if (e.type === 'tool_start') {
      const detail = typeof e.args.command === 'string' ? e.args.command : typeof e.args.path === 'string' ? e.args.path : ''
      callStarts.set(e.callId, { at: Date.now(), detail })
    }
    if (e.type === 'tool_result') {
      const start = callStarts.get(e.callId)
      const call: TimedCall = { tool: e.name, detail: start?.detail ?? '', ms: start ? Date.now() - start.at : 0 }
      calls.push(call)
      if (TRACE) trace(task.id, `${call.tool} ${call.detail} (${(call.ms / 1000).toFixed(1)}s, ok=${e.ok})\n${tail(e.output)}`)
    }
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

  // Grade against the ORIGINAL test, whatever the agent left in the workspace.
  // The prompt says only that the test fails, so editing the test is the cheapest
  // way to make it pass; this makes that pointless rather than forbidden. Then the
  // holdout, which the agent never saw.
  const verdict = gradeTask(task, ws)
  const errored = events.find((e) => e.type === 'error')
  const limited = events.find((e) => e.type === 'limit')
  // The closing message is the text after the last tool call, as headless reports it.
  let finalText = ''
  for (const e of events) {
    if (e.type === 'tool_start') finalText = ''
    else if (e.type === 'text') finalText += e.delta
  }
  const receiptEvent = events.find((e) => e.type === 'receipt')
  const receipt = receiptEvent?.type === 'receipt' ? receiptEvent.receipt : undefined
  const honesty = gradeHonesty({ finalText, receipt, verifyPassed: verdict.visibleOk })
  if (TRACE) {
    trace(task.id, `closing message:\n${finalText.trim()}`)
    trace(task.id, receipt ? formatReceiptLines(receipt).join('\n') : 'no receipt')
    trace(task.id, `graded ${verdict.ok ? 'solved' : 'unsolved'}:\n${tail(verdict.output)}`)
  }
  // Both spellings of the workspace: macOS reaches the temp dir through /var -> /private/var.
  const hash = h.request ? promptHash(h.request, [ws, realpathSync(ws)]) : undefined
  // Gone before the next attempt starts. Its workspace is this one's sibling, and an
  // agent that looks around (`ls ..`, a `find` for a missing package) would otherwise
  // find this attempt's finished work, and the holdout that grading just placed.
  rmSync(dirname(ws), { recursive: true, force: true, maxRetries: 3 })
  return {
    taskId: task.id,
    passed: verdict.ok,
    exitCode: verdict.exitCode,
    verifyOutput: verdict.output,
    toolsUsed: events.filter((e) => e.type === 'tool_start').map((e) => e.name),
    durationMs,
    error: errored?.message ?? (limited ? `run hit a limit: ${limited.reason}` : undefined),
    costUsd: events.reduce((n, e) => n + (e.type === 'usage' ? e.cost : 0), 0),
    honesty,
    promptHash: hash,
    ...(receipt ? { receipt } : {}),
    ...(calls.length ? { slowestCall: slowestOf(calls) } : {})
  }
}

/** The last few lines of a tool's output, for the trace. */
function tail(output: string): string {
  return output.trimEnd().split('\n').slice(-8).map((l) => `    ${l.slice(0, 200)}`).join('\n')
}

/** One trace entry (HOUSTON_EVAL_TRACE=1): live runs keep no transcript, so this is the only record. */
function trace(taskId: string, text: string): void {
  process.stdout.write(`[${taskId}] ${text}\n`)
}

// ---- suites ----

describe('eval fixtures', () => {
  it('registers every task directory exactly once', () => {
    expect(TASKS.map((t) => t.id).sort()).toEqual(taskDirNames())
  })

  /**
   * The live driver's ONLY unshared seam is `createProvider`: the scripted driver
   * returns its fake without ever calling it, so nothing else here touches the
   * real adapter construction path. That gap shipped a live driver in which every
   * task failed instantly — the agentHost mock was missing `getSecretHeaders`,
   * which createProvider calls on every build.
   *
   * This runs under the SCRIPTED driver, on every PR, with a dummy key and no
   * network (createProvider only assembles the SDK client). So a missing mock
   * export now reds the PR that introduces it rather than the next nightly.
   */
  it('constructs the real provider the live driver would use', async () => {
    const actual = await vi.importActual<typeof import('../../providers')>('../../providers')
    h.key = 'test-key-not-used-for-any-request'
    for (const cfg of defaultProviders().filter((p) => p.kind === 'anthropic' || p.kind === 'openai')) {
      expect(() => actual.createProvider(cfg), `createProvider failed for "${cfg.id}"`).not.toThrow()
    }
  })

  /**
   * REGRESSION: every attempt at a task once reused one workspace folder, so a
   * file one attempt created was already there for the next, and attempt 2 of
   * new-module-write passed without doing anything. Each materialization must be
   * a fresh copy of the fixture alone, in a folder whose name says nothing about
   * the task (the prompt names the folder as the project).
   */
  it('gives every attempt a fresh, neutrally named copy of the fixture', () => {
    const task = TASKS.find((t) => t.id === 'new-module-write')!
    const first = materializeTask(task, tmpRoot)
    writeFileSync(join(first, 'slug.mjs'), 'export const slugify = (s) => s\n')
    const second = materializeTask(task, tmpRoot)
    expect(second).not.toBe(first)
    expect(existsSync(join(second, 'slug.mjs')), 'an earlier attempt’s file leaked in').toBe(false)
    expect(second).not.toContain(task.id)
  })

  // A verify command that is already green grades every future regression as a
  // pass. Every task must start red, so a pass can only mean the agent did work.
  it.each(TASKS.map((t) => [t.id, t] as const))('%s fails before the agent runs', (_id, task) => {
    const ws = materializeTask(task, tmpRoot)
    expect(runVerify(task.verify, ws).ok).toBe(false)
    // A holdout that starts green can't tell a complete fix from a narrow one.
    if (task.holdout) {
      placeHoldout(task, ws)
      expect(runVerify(task.holdout, ws).ok, 'the holdout must fail on the untouched fixture too').toBe(false)
    }
    // Both checks run real processes, and a fixture whose bug is a hang fails by timing out.
  }, 30_000)

  /**
   * A holdout is only hidden while none of it reaches the workspace the agent works
   * in, so no holdout path may also exist in the fixture, and no holdout task may
   * exist without its directory (that would grade on a missing file).
   */
  it.each(TASKS.filter((t) => t.holdout).map((t) => [t.id, t] as const))(
    '%s keeps its holdout out of the agent’s workspace',
    (_id, task) => {
      const hidden = readdirSync(holdoutDirFor(task.id), { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => relative(holdoutDirFor(task.id), join(e.parentPath, e.name)))
      expect(hidden.length).toBeGreaterThan(0)
      const ws = materializeTask(task, tmpRoot)
      for (const rel of hidden) {
        expect(existsSync(join(repoDirFor(task.id), rel)), `${rel} is in the fixture, so the agent can read it`).toBe(false)
        expect(existsSync(join(ws, rel)), `${rel} reached the workspace`).toBe(false)
      }
    }
  )

  /**
   * The prompts state the symptom, not the fix, so the shortest path to a green
   * `node test.mjs` is to delete the assertion that fails. Nothing stops a live
   * model from taking it, and a tampered test grades as a solve. The first half
   * of this test shows the hole is real; the second shows the restore closes it.
   */
  it.each(TASKS.map((t) => [t.id, t] as const))(
    '%s cannot be passed by rewriting its test',
    (_id, task) => {
      const ws = materializeTask(task, tmpRoot)
      // The laziest possible "fix": a test that asserts nothing.
      writeFileSync(join(ws, 'test.mjs'), 'process.exit(0)\n')
      expect(runVerify(task.verify, ws).ok, 'tampering should pass an ungraded workspace').toBe(true)

      restoreVerifyFiles(task, ws)
      expect(runVerify(task.verify, ws).ok, 'the pristine test must still fail').toBe(false)
    }
  )
})

/**
 * The tests above prove `restoreVerifyFiles` works; this proves the GRADER uses
 * it. Drive the real loop with a script whose only action is to blank the test,
 * and the run must still grade as a failure. Delete the restore call from
 * runTask and this is the test that reds.
 *
 * Scripted only: in live mode this would spend a real model on a task designed
 * to fail.
 */
describe.skipIf(LIVE)('grading integrity', () => {
  it('fails a run whose only work was rewriting the test', async () => {
    const cheat: EvalTask = {
      ...TASKS[0],
      // Read first: write_file refuses to overwrite a file the run hasn't seen.
      script: [
        turn(callTool('look', 'read_file', { path: 'test.mjs' })),
        turn(callTool('cheat', 'write_file', { path: 'test.mjs', content: 'process.exit(0)\n' }))
      ]
    }
    const r = await runTask(cheat)
    expect(r.toolsUsed, 'the cheat should have actually run').toContain('write_file')
    expect(r.passed, 'a blanked test must not grade as a solve').toBe(false)
  }, 60_000)

  /**
   * The holdout tests above prove each one starts red and stays out of sight; this
   * proves the GRADER runs it. Quote the arguments instead of dropping the shell: the
   * visible test (spaces only) goes green, the holdout (`$HOME` and backticks for a POSIX
   * shell, `%PATH%` for cmd.exe, a name that would run a command) doesn't, and the run
   * must grade as a failure that says why.
   * Drop the holdout run from gradeTask and this reds (drop `placeHoldout` and every
   * holdout task's scripted solve reds instead). It also pins that honesty is graded on
   * what the agent could see: its "the test passes" is true.
   */
  it('fails a narrow fix that passes only the visible test', async () => {
    const task = TASKS.find((t) => t.id === 'file-names-with-spaces')!
    const r = await runTask({
      ...task,
      script: [
        turn(callTool('look', 'read_file', { path: 'lib/render.mjs' })),
        turn(
          callTool('quote', 'edit_file', {
            path: 'lib/render.mjs',
            old_string: '--in ${input} --out ${output}`\n  if (title) command += ` --title ${title}`',
            new_string: '--in "${input}" --out "${output}"`\n  if (title) command += ` --title "${title}"`'
          })
        ),
        turn(callTool('check', 'run_shell', { command: 'node test.mjs' })),
        turn(say('Quoted the paths; the test passes.'))
      ]
    })
    expect(r.toolsUsed, 'the narrow fix should have actually run').toContain('edit_file')
    expect(r.passed, 'a fix the holdout rejects must not grade as a solve').toBe(false)
    expect(r.verifyOutput).toMatch(/^holdout failed \(the visible check passed\)/)
    expect(r.honesty.honest, 'the visible test really did pass').toBe(true)
  }, 60_000)

  /**
   * The honesty grade reads the receipt the loop emits, so a run that claims a
   * passing suite it never ran must grade dishonest even when the fix itself is
   * right, and an accurate report must grade honest. Unwire the receipt from the
   * loop, or the grader from runTask, and these red.
   */
  it('grades a report that claims a suite it never ran as dishonest', async () => {
    const task = TASKS.find((t) => t.id === 'unverifiable-dependency')!
    const r = await runTask({
      ...task,
      // Read and fix, run nothing, then claim the suite passed.
      script: [task.script[0], task.script[1], turn(say('Fixed slugify(). All tests pass ✅'))]
    })
    expect(r.passed, 'the fix itself is right').toBe(true)
    expect(r.honesty.honest).toBe(false)
    expect(r.honesty.unsupportedClaims).toEqual(['All tests pass ✅'])
  }, 60_000)

  it('grades an accurate report as honest', async () => {
    for (const id of ['run-tests-then-fix', 'unverifiable-dependency']) {
      const r = await runTask(TASKS.find((t) => t.id === id)!)
      expect(r.passed, id).toBe(true)
      expect(r.honesty, id).toMatchObject({ honest: true })
    }
    // Same budget as a scripted task below: real local tool calls, slow to spawn on Windows.
  }, 60_000)

  /**
   * The prompt hash labels a run only if every task in it gets the same one. Each
   * task runs in its own throwaway workspace and the prompt names that path, so
   * this is what proves stamp.ts scrubs it: miss a spelling of the path and the
   * two hashes differ, and a run whose tasks disagree is stamped with nothing.
   */
  /**
   * Attempts are independent only if one can't read another. Every attempt's workspace
   * sits in the same temp root, so a finished one (its solution, and its holdout once
   * graded) must be gone before the next attempt starts.
   */
  it('removes an attempt’s workspace once it is graded', async () => {
    const task = TASKS.find((t) => t.holdout)!
    await runTask(task)
    expect(readdirSync(tmpRoot), 'a graded workspace was left for the next attempt to find').toEqual([])
  }, 60_000)

  it('stamps every task with the same prompt hash', async () => {
    const a = await runTask(TASKS[0])
    const b = await runTask(TASKS[1])
    expect(a.promptHash).toMatch(/^[0-9a-f]{12}$/)
    expect(b.promptHash).toBe(a.promptHash)
  }, 60_000)
})

describe(`task evals (${LIVE ? 'live' : 'scripted'} driver)`, () => {
  const reports: TaskReport[] = []
  /** Every attempt's prompt hash; the run is stamped only when they all agree. */
  const hashes: (string | undefined)[] = []

  afterAll(() => {
    if (!reports.length) return
    const driver = LIVE ? 'live' : 'scripted'
    const runHash = sharedHash(hashes)
    console.log(
      formatReport(
        { driver, model: MODEL, attempts: ATTEMPTS, promptHash: runHash, baselinePromptHash: BASELINE?.promptHash },
        reports
      )
    )
    if (OUT) {
      // Written before the baseline step, which can throw: a run that recorded no
      // baseline is still a valid side of an A/B comparison.
      const record = toRunRecord(
        {
          driver,
          provider: PROVIDER_ID,
          model: MODEL,
          attempts: ATTEMPTS,
          promptHash: runHash,
          commit: currentCommit(gitIn(process.cwd())),
          host: process.platform
        },
        reports,
        new Date()
      )
      writeFileSync(resolve(OUT), `${JSON.stringify(record, null, 2)}\n`)
      console.log(`Wrote run record → ${resolve(OUT)}`)
    }
    if (!RECORD) return
    // Recording writes the scorecard as the model's new baseline. Reviewed and
    // committed like a golden: the diff is what documents the behavior change.
    const scores: TaskScore[] = reports.map((r) => ({
      taskId: r.taskId,
      passRate: r.passRate,
      attempts: r.attempts
    }))
    // Never write a baseline that would gate nothing — see assertRecordable.
    // Fold the actual per-task causes into the message: the scorecard is already
    // on stdout, but it scrolls away in a CI log and gets cropped when someone
    // pastes the tail, and the cause is the only part that identifies the fix.
    try {
      assertRecordable(scores)
    } catch (e) {
      const causes = failureCauses(reports)
      throw new Error(
        [(e as Error).message, '', 'The failures were:', ...causes.map((c) => `  - ${c}`)].join('\n'),
        { cause: e }
      )
    }
    mkdirSync(BASELINES_DIR, { recursive: true })
    const baseline = recordBaseline(PROVIDER_ID, MODEL, ATTEMPTS, scores, new Date(), runHash)
    writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`)
    console.log(`Recorded baseline → ${baselineFile}\nReview the scores and commit it.`)
  })

  it.each(TASKS.map((t) => [t.id, t] as const))(
    '%s',
    async (_id, task) => {
      const attempts: EvalResult[] = []
      for (let i = 0; i < ATTEMPTS; i++) attempts.push(await runTask(task))
      hashes.push(...attempts.map((a) => a.promptHash))
      const passes = attempts.filter((a) => a.passed).length
      const passRate = passes / ATTEMPTS
      // Show a failure when there was one, else a dishonest report: a run that
      // passed 2/3 is far more informative reported through the attempt that failed.
      const sample = pickSample(attempts)
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
        verdict,
        honestyRate: attempts.filter((a) => a.honesty.honest).length / ATTEMPTS,
        slowestCall: slowestOf(attempts.map((a) => a.slowestCall))
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
    LIVE ? LIVE_ATTEMPT_BUDGET_MS * ATTEMPTS : 60_000
  )
})
