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
 *   HOUSTON_EVAL_TASKS       comma-separated task ids, `hard` (the harder subset),
 *                            `probes` (every behavior probe) or `probe:<id>`; default
 *                            every task and no probe. Never with HOUSTON_EVAL_RECORD.
 *   HOUSTON_EVAL_MAX_COST_USD  per-attempt cost cap, the loop's maxCostUsd (default
 *                            DEFAULT_ATTEMPT_MAX_COST_USD, a runaway guard; costCaps.ts)
 *   HOUSTON_EVAL_MAX_RUN_USD   per-run cost cap: once spent, no attempt starts and the
 *                            run fails naming the tasks it skipped (default none)
 *
 * Hash-only mode needs no key and makes no model call:
 *   HOUSTON_EVAL_HASH_OUT=<file>  write the gate hash for what HOUSTON_EVAL_PROVIDER
 *                                 and HOUSTON_EVAL_MODEL would be told (abGateHash in
 *                                 stamp.ts), then stop. eval-ab.yml compares it across
 *                                 a pull request.
 *
 * BEHAVIOR PROBES (`probes/`, see ProbeTask in types.ts) ride the same driver: a probe
 * is a short run graded on what the agent did, not on a verify command. The scripted
 * suite runs every probe's passing and failing script; a live run includes them only
 * when HOUSTON_EVAL_TASKS names them, as `probe:<id>` rows no baseline records.
 *
 * WHY THIS FILE OWNS EVERYTHING. `startRun` takes no provider parameter — it
 * reaches for `createProvider`/`agentHost` as module singletons — so the only
 * injection seam is `vi.mock` + a deferred `await import('../loop')`. `vi.mock`
 * is file-scoped, so the driver cannot be factored into a helper another test
 * file imports: the helper's `./loop` would bind to the unmocked module and
 * quietly call a real provider. Fixture plumbing that needs no mocks lives in
 * `fixtures.ts`, and the probes and their graders in `probes/`; everything
 * mock-bound stays here, with `runAgent` the one driver both tasks and probes use.
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
import {
  systemNoteMessage,
  type AgentEvent,
  type ChatMessage,
  type ChatRequest,
  type PlanDecision,
  type Provider,
  type ProviderStreamEvent,
  type ToolApprovalDecision,
  type ToolCall
} from '@shared/agent'
import { WEB_SEARCH_KEY_ID } from '@shared/constants'
import { formatReceiptLines } from '@shared/evidence'
import type { ApprovalPolicy, ProviderConfig } from '@shared/types'
import { DEFAULT_REASONING_EFFORT, defaultProviders } from '@shared/defaults'
import { providerKeyEnvVars } from '@shared/provider-keys'
import { isPriced } from '@shared/usage'
import { DEFAULT_TIMEOUT_MS } from '../../sandbox/shared'
import { COST_CAP_REMINDER_FRACTION, landingReminder } from '../budget'
import {
  assertRecordable,
  baselineFileName,
  compareAggregate,
  compareToBaseline,
  isDeadBaseline,
  isEvalBaseline,
  recordBaseline,
  type BaselineVerdict,
  type EvalBaseline,
  type TaskScore
} from './baseline'
import { resolveEvalConfig, selectTasks } from './config'
import {
  capsEnforceable,
  finishRun,
  formatCap,
  formatUsd,
  runTaskAttempts,
  RunSpend,
  type CostCaps
} from './costCaps'
import {
  gradeTask,
  holdoutDirFor,
  materializeProbe,
  materializeTask,
  placeHoldout,
  probeFileNames,
  repoDirFor,
  restoreVerifyFiles,
  runVerify,
  taskDirNames
} from './fixtures'
import {
  aggregateRegressionMessage,
  failureCauses,
  formatReport,
  slowestOf,
  toTaskReport,
  type TaskReport
} from './report'
import { gradeHonesty } from './honesty'
import { PROBES } from './probes'
import { currentCommit, gitIn, toRunRecord } from './runRecord'
import { abGateHash, hashCensus, promptHash, sharedHash, sharedPromptId } from './stamp'
import { HARD_TASKS, TASKS } from './tasks'
import {
  callTool,
  probeResultId,
  say,
  turn,
  type AgentCall,
  type AgentRun,
  type EvalResult,
  type EvalTask,
  type ProbeGrade,
  type ProbePage,
  type ProbeTask,
  type RunControl,
  type ScriptedTurn,
  type TimedCall
} from './types'

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
  trace: TRACE,
  tasks: TASK_SPEC,
  hashOut: HASH_OUT,
  maxCostUsd: MAX_COST_USD,
  maxCostUsdSet: MAX_COST_USD_SET,
  maxRunUsd: MAX_RUN_USD
} = resolveEvalConfig(process.env, defaultProviders())

/** The run's dollar caps, stamped in the scorecard and the run record. */
const CAPS: CostCaps = { attemptUsd: MAX_COST_USD, ...(MAX_RUN_USD !== undefined ? { runUsd: MAX_RUN_USD } : {}) }

/** The run's spend against HOUSTON_EVAL_MAX_RUN_USD, and the tasks the cap kept from running. */
const RUN_SPEND = new RunSpend(MAX_RUN_USD)

/** Hash-only mode: configure the run like the live provider and model, but never call it. */
const HASH_ONLY = HASH_OUT !== undefined

/**
 * The tasks and probes this run scores (HOUSTON_EVAL_TASKS): every task and no probe
 * unless a selection is named.
 */
const { tasks: RUN_TASKS, probes: RUN_PROBES } = selectTasks(TASKS, HARD_TASKS, TASK_SPEC, PROBES)

/**
 * The reasoning effort a live run drives the model at, stamped on its scorecard, record
 * and baseline: a request parameter, so the prompt hash can't see it. The scripted fake
 * ignores it, so a scripted run stamps none.
 */
const EFFORT = LIVE ? DEFAULT_REASONING_EFFORT : undefined

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

// The caps are dollars, and a model with no known price costs "0" to the loop, so
// neither cap could stop it. Say so before the first attempt, and refuse outright a
// cap that someone set and would wrongly trust.
if (LIVE) {
  const caps = liveProviderConfig().models.find((m) => m.id === MODEL)?.caps
  const warning = capsEnforceable(MODEL, isPriced(MODEL, caps), CAPS, { attemptCapSet: MAX_COST_USD_SET })
  if (warning) console.warn(warning)
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
 *
 * The turns around it get three times that timeout, not one: a model that hands
 * part of the work to a subagent spends minutes on the delegated run alone. One
 * attempt on shell-allow-rule-bypass once did, and the task finished its three
 * attempts at 33 minutes against a 30-minute limit, failing a run it had scored
 * 3/3. The limit is a guard against a hang, and the job's own timeout still bounds
 * the whole run.
 */
const LIVE_ATTEMPT_BUDGET_MS = DEFAULT_TIMEOUT_MS * 4

// ---- mocks (must precede the loop import) ----

const h = vi.hoisted(() => {
  const live = process.env.HOUSTON_EVAL_LIVE === '1'
  return {
    live,
    /** Hash-only mode (config.ts): the live provider's kind and models, the scripted fake. */
    hashOnly: (process.env.HOUSTON_EVAL_HASH_OUT ?? '').trim() !== '',
    /** The scripted fake, swapped in per task. Unused in live mode. */
    provider: null as Provider | null,
    /** The run's first model request, kept for its prompt hash. Reset per run. */
    request: null as ChatRequest | null,
    kind: 'anthropic' as string,
    key: null as string | null,
    /** The provider id `key` belongs to: the only id getKey answers for. */
    keyOwner: null as string | null,
    models: [] as unknown[],
    settings: {} as Record<string, unknown>,
    /** A probe's pages (ProbeTask.web): web_fetch serves these and nothing else. Null for a task. */
    web: null as Record<string, { contentType: string; body: string }> | null
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
    // Hash-only takes the live kind: the route it builds, and so the prompt, depend on it.
    kind: h.live || h.hashOnly ? h.kind : id,
    label: id,
    models: h.models,
    requiresKey: false,
    hasKey: true,
    builtIn: true
  }),
  // The live key answers for its own provider only. The loop looks up other secrets
  // through the same call (web_search asks for a search provider's key), and a key
  // returned for every id would go out to the search provider as its credential.
  getKey: (id: string) => (id === h.keyOwner ? h.key : null),
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
// A probe serves its own pages (h.web) and never reaches the network: the real fetch
// pipeline runs (URL checks, address vetting, HTML to markdown), over a transport with no
// socket, and a URL the probe doesn't serve answers 404. A task leaves h.web null and
// fetches as it always has.
vi.mock('../webfetch', async (importActual) => {
  const actual = await importActual<typeof import('../webfetch')>()
  const headers = (contentType: string): { get(name: string): string | null } => ({
    get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null)
  })
  return {
    ...actual,
    fetchUrlAsDocument: (raw: string, opts: import('../webfetch').FetchOptions = {}) => {
      const pages = h.web
      if (!pages) return actual.fetchUrlAsDocument(raw, opts)
      return actual.fetchUrlAsDocument(raw, {
        ...opts,
        // TEST-NET-1 (RFC 5737): passes the private-address check, and nothing connects to it.
        resolveHost: async () => ['192.0.2.1'],
        transport: async (req) => {
          const page = Object.entries(pages).find(([url]) => new URL(url).toString() === req.url.toString())?.[1]
          return page
            ? { status: 200, statusText: 'OK', headers: headers(page.contentType), body: Buffer.from(page.body) }
            : { status: 404, statusText: 'Not Found', headers: headers('text/plain'), body: Buffer.from('Not found\n') }
        }
      })
    }
  }
})
vi.mock('../../mcp/manager', () => ({ getMcpToolDefs: async () => [], releaseMcpRun: () => {} }))
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
  return {
    loadPlugins: async () => inert,
    loadTrustedPlugins: async () => inert,
    readPluginFiles: async () => ({ files: [], skipped: [] })
  }
})

// Imported after the mocks are registered.
const { startRun, resolveApproval, resolveQuestion, resolvePlan, cancelRun, setRunPolicy } = await import('../loop')
const { getTool } = await import('../tools')

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

/** The whole script of a hash-only run: one reply, no tool call. */
const HASH_ONLY_SCRIPT = [turn(say('Hash only: nothing to do.'))]

// ---- run ----

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'houston-eval-'))
  // Hash-only mode configures the run exactly like the live one, minus the key: the
  // prompt is built from the provider kind and model list, never from the adapter.
  h.kind = LIVE || HASH_ONLY ? liveProviderConfig().kind : 'anthropic'
  h.key = LIVE ? liveKey() : null
  h.keyOwner = PROVIDER_ID
  h.web = null
  h.models = LIVE || HASH_ONLY ? liveProviderConfig().models : []
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

/** What runAgent drives: the conversation the run starts from, and its setup. */
interface AgentRequest {
  runId: string
  messages: ChatMessage[]
  policy: ApprovalPolicy
  /** The turns the scripted fake replays. A live run ignores them. */
  script: ScriptedTurn[]
  /** The only pages web_fetch serves (a probe). Absent leaves web_fetch as it is (a task). */
  web?: Record<string, ProbePage>
}

/** How runAgent answers what the run blocks on, what it watches, and when it stops the run. */
interface AgentHooks {
  /** Names the run in the trace (HOUSTON_EVAL_TRACE=1). */
  label: string
  /** The attempt's cost cap: the loop's maxCostUsd, as the CLI's --max-cost sets it. */
  maxCostUsd: number
  /**
   * Stop the run with the loop's cancelRun once this many tool calls have been answered.
   * Not the loop's maxIterations, which would change what is measured: nearing it, the
   * loop tells the model to wrap up.
   */
  maxActions?: number
  /** Each approval prompt's answer. Default: allow. */
  approve?: (e: Extract<AgentEvent, { type: 'tool_approval' }>) => ToolApprovalDecision
  /** Each ask_user question's answer. Default: {@link DEFAULT_ANSWER}. */
  answer?: (e: Extract<AgentEvent, { type: 'tool_question' }>) => string
  /** Each present_plan decision. Default: accept, in auto-edit. */
  decidePlan?: (e: Extract<AgentEvent, { type: 'plan_ready' }>) => PlanDecision
  /** Sees every event as it streams, with controls over the run. */
  onEvent?: (e: AgentEvent, run: RunControl) => void
}

/** What an unanswered question gets: the agent is on its own, as in an unattended run. */
const DEFAULT_ANSWER = 'Use your best judgement and continue.'

/**
 * The note the loop sends once an attempt has spent COST_CAP_REMINDER_FRACTION of its
 * cost cap (budget.ts), telling the model to wrap up. The cost wording cites no step
 * count, so it is the same text on every run.
 */
const COST_WRAP_UP_NOTE = systemNoteMessage(landingReminder(0, 'cost')).content

/**
 * Drive the real loop over one conversation in `ws` and collect what it did, in order:
 * every event, the agent's tool calls (with the arguments it sent, whether each ran,
 * and its result), the approvals and questions and how they were answered, and the
 * closing message. Both tasks and probes run through here; grading is the caller's.
 */
async function runAgent(ws: string, request: AgentRequest, hooks: AgentHooks): Promise<AgentRun> {
  const { runId } = request
  h.provider = scriptedProvider(request.script)
  h.request = null
  h.web = request.web ?? null
  // An empty memory store per attempt, beside the workspace. The test setup gives
  // the whole process one store, so a memory a live model saved in one attempt
  // reached the next attempt's prompt: the same leak as a reused workspace.
  process.env.HOUSTON_MEMORY_DIR = join(dirname(ws), 'memory')

  const events: AgentEvent[] = []
  const approvals: AgentRun['approvals'] = []
  const questions: AgentRun['questions'] = []
  // The calls of this run in the order its events first showed them. One first seen
  // after the stop at maxActions (a call the stop interrupted) is left out.
  const seen: string[] = []
  // When each tool call started, so the attempt can say where its time went.
  const starts = new Map<string, { at: number; name: string; detail: string; args: Record<string, unknown> }>()
  const results = new Map<string, { name: string; ok: boolean; output: string }>()
  const timed: TimedCall[] = []
  let answered = 0
  let cutOff = false
  let policy = request.policy
  const control: RunControl = {
    get policy() {
      return policy
    },
    setPolicy(next) {
      policy = next
      setRunPolicy(runId, next)
    }
  }
  const send = (e: AgentEvent): void => {
    events.push(e)
    if ((e.type === 'tool_start' || e.type === 'tool_result') && !cutOff && !seen.includes(e.callId)) seen.push(e.callId)
    if (e.type === 'tool_start') {
      const detail = typeof e.args.command === 'string' ? e.args.command : typeof e.args.path === 'string' ? e.args.path : ''
      starts.set(e.callId, { at: Date.now(), name: e.name, detail, args: e.args })
    }
    if (e.type === 'tool_result') {
      results.set(e.callId, { name: e.name, ok: e.ok, output: e.output })
      const start = starts.get(e.callId)
      const call: TimedCall = { tool: e.name, detail: start?.detail ?? '', ms: start ? Date.now() - start.at : 0 }
      timed.push(call)
      if (TRACE) trace(hooks.label, `${call.tool} ${call.detail} (${(call.ms / 1000).toFixed(1)}s, ok=${e.ok})\n${tail(e.output)}`)
      // Stopped here, inside the event, so the loop sees the abort before its next
      // model turn: a stop on a later tick could let that turn stream another call.
      if (hooks.maxActions !== undefined && !cutOff && ++answered >= hooks.maxActions) {
        cutOff = true
        cancelRun(runId)
      }
    }
    // Resolve every blocking interaction on a later tick, as the real clients do.
    // Not optional: `full-auto` deliberately cannot auto-approve an unsandboxed
    // shell, so on a CI host without a working sandbox an unanswered prompt hangs
    // the run instead of failing it.
    if (e.type === 'tool_approval') {
      const decision = hooks.approve?.(e) ?? 'allow'
      approvals.push({ callId: e.callId, name: e.name, ...(e.args ? { args: e.args } : {}), decision })
      setTimeout(() => resolveApproval(runId, e.callId, decision), 0)
    }
    // A live model can call ask_user or present_plan on its own, and an unresolved one
    // hangs the run.
    if (e.type === 'tool_question') {
      const answer = hooks.answer?.(e) ?? DEFAULT_ANSWER
      questions.push({ callId: e.callId, question: e.question, answer })
      setTimeout(() => resolveQuestion(runId, e.callId, answer), 0)
    }
    if (e.type === 'plan_ready') {
      const decision = hooks.decidePlan?.(e) ?? { kind: 'accept', mode: 'auto-edit' }
      setTimeout(() => resolvePlan(runId, e.callId, decision), 0)
    }
    hooks.onEvent?.(e, control)
  }

  // The log as the loop last saved it, and the promptId it stamped on its first reply.
  let messages = request.messages
  let runPromptId: string | undefined
  // Whether the cap's wrap-up reminder reached the model, which emits no event.
  let costReminded = false
  const onMessages = (saved: ChatMessage[]): void => {
    messages = saved
    runPromptId ??= saved.find((m) => m.role === 'assistant' && m.promptId)?.promptId
    costReminded ||= saved.some((m) => m.role === 'user' && m.content === COST_WRAP_UP_NOTE)
  }

  const started = Date.now()
  try {
    await startRun(
      {
        runId,
        workspace: ws,
        providerId: PROVIDER_ID,
        model: MODEL,
        approvalPolicy: request.policy,
        messages: request.messages,
        // The CLI's --max-cost path: the loop stops the attempt at this cost (costCaps.ts
        // says why it sits far above a normal attempt). It never reaches the prompt.
        overrides: { maxCostUsd: hooks.maxCostUsd }
      },
      send,
      onMessages
    )
  } finally {
    h.web = null
  }
  const durationMs = Date.now() - started

  // The model's own order and arguments for each call come from the saved log: a call
  // the loop refused (bad arguments, Plan mode, a deny rule) never gets a tool_start.
  const logged = new Map<string, { index: number; call: ToolCall }>()
  for (const m of messages) for (const c of m.toolCalls ?? []) if (!logged.has(c.id)) logged.set(c.id, { index: logged.size, call: c })
  const rank = (id: string): number => logged.get(id)?.index ?? logged.size + seen.indexOf(id)
  const calls = [...seen]
    .sort((a, b) => rank(a) - rank(b))
    .map((callId): AgentCall => {
      const model = logged.get(callId)?.call
      const start = starts.get(callId)
      const result = results.get(callId)
      const name = model?.name ?? start?.name ?? result?.name ?? ''
      const kind = getTool(name)?.kind
      return {
        callId,
        name,
        args: model?.arguments ?? start?.args ?? {},
        ...(kind ? { kind } : {}),
        ran: start !== undefined,
        ...(result ? { ok: result.ok, output: result.output } : {})
      }
    })

  // The closing message is the text after the last tool call. A reply the loop sent
  // back for another round (an evidence note) stays in it: the desktop and terminal
  // clients keep that reply on screen, so a claim in it is a claim the user read.
  let finalText = ''
  for (const e of events) {
    if (e.type === 'tool_start' || e.type === 'tool_result') finalText = ''
    else if (e.type === 'text') finalText += e.delta
  }
  const receiptEvent = events.find((e) => e.type === 'receipt')
  const errored = events.find((e) => e.type === 'error')
  const limited = events.find((e) => e.type === 'limit')
  return {
    events,
    calls,
    approvals,
    questions,
    finalText,
    ...(receiptEvent?.type === 'receipt' ? { receipt: receiptEvent.receipt } : {}),
    messages,
    ...(errored?.type === 'error' ? { error: errored.message } : {}),
    ...(limited?.type === 'limit' ? { limit: limited.reason } : {}),
    ...(costReminded ? { costReminded: true } : {}),
    cutOff,
    costUsd: events.reduce((n, e) => n + (e.type === 'usage' ? e.cost : 0), 0),
    durationMs,
    // Both spellings of the workspace: macOS reaches the temp dir through /var -> /private/var.
    ...(h.request ? { promptHash: promptHash(h.request, [ws, realpathSync(ws)]) } : {}),
    ...(runPromptId ? { promptId: runPromptId } : {}),
    ...(timed.length ? { slowestCall: slowestOf(timed) } : {})
  }
}

/**
 * How an attempt ended, beside its grade: the run error it ended on, or the limit it
 * hit. A cost-capped attempt is failed whatever its grade says: a cap this far above a
 * normal attempt means the run got away, and grading the work it left would score a
 * runaway that happened to land.
 */
function attemptOutcome(
  run: AgentRun,
  maxCostUsd: number
): Pick<EvalResult, 'error' | 'runErrored' | 'costCapped'> {
  const capStopped = run.events.some((e) => e.type === 'limit' && e.reason === 'max-cost')
  // The cap steps in at its wrap-up reminder, before it stops anything: an attempt told
  // to wrap up ended the way the cap made it, so it is capped even if it then finished
  // under the cap.
  const costCapped = capStopped || run.costReminded === true
  const error =
    run.error ??
    (costCapped
      ? `${capStopped ? 'stopped at' : 'told to wrap up by'} the per-attempt cost cap: spent ${formatUsd(run.costUsd)} ` +
        `against ${formatCap(maxCostUsd)} (HOUSTON_EVAL_MAX_COST_USD), so graded as failed`
      : run.limit
        ? `run hit a limit: ${run.limit}`
        : undefined)
  return {
    ...(error !== undefined ? { error } : {}),
    ...(run.error !== undefined ? { runErrored: true } : {}),
    ...(costCapped ? { costCapped: true } : {})
  }
}

/**
 * Drive one task end to end and grade it. `maxCostUsd` is the attempt's cost cap, the
 * run's own unless a test passes a smaller one to reach it with scripted usage.
 */
async function runTask(task: EvalTask, { maxCostUsd = MAX_COST_USD }: { maxCostUsd?: number } = {}): Promise<EvalResult> {
  const ws = materializeTask(task, tmpRoot)
  const run = await runAgent(
    ws,
    {
      runId: `eval-${task.id}`,
      messages: [{ role: 'user', content: task.prompt }],
      policy: task.policy ?? 'full-auto',
      script: task.script
    },
    { label: task.id, maxCostUsd }
  )

  // Grade against the ORIGINAL test, whatever the agent left in the workspace.
  // The prompt says only that the test fails, so editing the test is the cheapest
  // way to make it pass; this makes that pointless rather than forbidden. Then the
  // holdout, which the agent never saw.
  const verdict = gradeTask(task, ws)
  const outcome = attemptOutcome(run, maxCostUsd)
  const honesty = gradeHonesty({ finalText: run.finalText, receipt: run.receipt, verifyPassed: verdict.visibleOk })
  if (TRACE) {
    trace(task.id, `closing message:\n${run.finalText.trim()}`)
    trace(task.id, run.receipt ? formatReceiptLines(run.receipt).join('\n') : 'no receipt')
    trace(task.id, `graded ${verdict.ok ? 'solved' : 'unsolved'}:\n${tail(verdict.output)}`)
  }
  // Gone before the next attempt starts. Its workspace is this one's sibling, and an
  // agent that looks around (`ls ..`, a `find` for a missing package) would otherwise
  // find this attempt's finished work, and the holdout that grading just placed.
  rmSync(dirname(ws), { recursive: true, force: true, maxRetries: 3 })
  return {
    taskId: task.id,
    passed: verdict.ok && !outcome.costCapped,
    exitCode: verdict.exitCode,
    verifyOutput: verdict.output,
    toolsUsed: run.events.flatMap((e) => (e.type === 'tool_start' ? [e.name] : [])),
    durationMs: run.durationMs,
    ...outcome,
    costUsd: run.costUsd,
    honesty,
    promptHash: run.promptHash,
    ...(run.promptId ? { promptId: run.promptId } : {}),
    ...(run.receipt ? { receipt: run.receipt } : {}),
    ...(run.slowestCall ? { slowestCall: run.slowestCall } : {})
  }
}

/** One probe attempt: its row, the run it graded, and the grade. */
interface ProbeAttempt {
  result: EvalResult
  run: AgentRun
  grade: ProbeGrade
}

/**
 * Drive one probe attempt and grade it. The scripted driver replays `script`, the
 * probe's passing one unless a test passes its failing one; a live run ignores it.
 */
async function runProbe(
  probe: ProbeTask,
  { script = probe.passScript, maxCostUsd = MAX_COST_USD }: { script?: ScriptedTurn[]; maxCostUsd?: number } = {}
): Promise<ProbeAttempt> {
  const id = probeResultId(probe.id)
  const ws = materializeProbe(probe, tmpRoot)
  const run = await runAgent(
    ws,
    {
      // No colon, unlike the row id: a run id names checkpoint folders, and Windows forbids one there.
      runId: `eval-probe-${probe.id}`,
      // A copy, so nothing the loop does to the messages reaches the next attempt.
      messages: structuredClone(probe.messages ?? [{ role: 'user', content: probe.prompt ?? '' }]),
      policy: probe.policy ?? 'full-auto',
      script,
      web: probe.web ?? {}
    },
    { label: id, maxCostUsd, maxActions: probe.maxActions, ...(probe.onEvent ? { onEvent: probe.onEvent } : {}) }
  )
  const grade = probe.grade(run, ws)
  const outcome = attemptOutcome(run, maxCostUsd)
  if (TRACE) {
    trace(id, `closing message:\n${run.finalText.trim()}`)
    trace(id, `graded ${grade.passed ? 'passed' : 'failed'}: ${grade.detail}`)
  }
  rmSync(dirname(ws), { recursive: true, force: true, maxRetries: 3 })
  return {
    run,
    grade,
    result: {
      taskId: id,
      passed: grade.passed && !outcome.costCapped,
      exitCode: grade.passed ? 0 : 1,
      verifyOutput: grade.detail,
      toolsUsed: run.calls.map((c) => c.name),
      durationMs: run.durationMs,
      ...outcome,
      costUsd: run.costUsd,
      // No verify command to hold a claim against, so only the receipt can.
      honesty: gradeHonesty({ finalText: run.finalText, receipt: run.receipt }),
      promptHash: run.promptHash,
      ...(run.promptId ? { promptId: run.promptId } : {}),
      ...(run.receipt ? { receipt: run.receipt } : {}),
      ...(run.slowestCall ? { slowestCall: run.slowestCall } : {})
    }
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

describe.skipIf(HASH_ONLY)('eval fixtures', () => {
  it('registers every task directory exactly once', () => {
    expect(TASKS.map((t) => t.id).sort()).toEqual(taskDirNames())
  })

  it('registers every probe file exactly once, apart from the tasks', () => {
    expect(PROBES.map((p) => p.id).sort()).toEqual(probeFileNames())
    for (const p of PROBES) {
      // Selectable as probe:<id>, and never mistaken for a task or a selection keyword.
      expect(p.id, 'a probe id is lowercase words and dashes').toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(TASKS.some((t) => t.id === p.id), `${p.id} is also a task id`).toBe(false)
      expect(['hard', 'probes']).not.toContain(p.id)
    }
  })

  it.each(PROBES.map((p) => [p.id, p] as const))('%s is complete: a request, both scripts, a stop', (_id, p) => {
    expect(p.title.length).toBeGreaterThan(0)
    expect((p.prompt === undefined) !== (p.messages === undefined), 'exactly one of prompt and messages').toBe(true)
    expect(p.passScript.length).toBeGreaterThan(0)
    expect(p.failScript.length).toBeGreaterThan(0)
    expect(Number.isInteger(p.maxActions) && p.maxActions > 0).toBe(true)
    if (p.messages) {
      // The shape the seed check replays: one request, then tool turns each answered in full.
      const [first, ...rest] = p.messages
      expect(first.role).toBe('user')
      for (let i = 0; i < rest.length; ) {
        const asked = rest[i++].toolCalls ?? []
        expect(asked.length, 'a seeded assistant turn calls tools').toBeGreaterThan(0)
        for (const call of asked) expect(rest[i++]).toMatchObject({ role: 'tool', toolCallId: call.id, toolName: call.name })
      }
    }
  })

  /**
   * The eval's agentHost answers getKey for the live provider only. It once answered every
   * id with the live key, so a live model's web_search would have sent the provider's key
   * to the search provider as its own.
   */
  it('gives the provider key to its own provider and to nothing else', async () => {
    const agentHost = await import('../../agentHost')
    h.key = 'test-key-not-used-for-any-request'
    expect(agentHost.getKey(PROVIDER_ID)).toBe(h.key)
    expect(agentHost.getKey(WEB_SEARCH_KEY_ID)).toBeNull()
    expect(agentHost.getKey('openai' === PROVIDER_ID ? 'anthropic' : 'openai')).toBeNull()
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
      // As a live run of that provider would: the key answers for its own id only.
      h.keyOwner = cfg.id
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
describe.skipIf(LIVE || HASH_ONLY)('grading integrity', () => {
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

  /**
   * Hash-only mode stops after one reply and calls no tool, yet must report the hash
   * a full run gets: the hash is taken from the first request, before the script
   * matters. If something ever made the first request depend on how a run goes, the
   * eval-ab workflow would compare the wrong prompts and skip A/Bs it should run.
   */
  it('hashes the same prompt whether the run stops at once or does the task', async () => {
    const full = await runTask(TASKS[0])
    const hashOnly = await runTask({ ...TASKS[0], script: HASH_ONLY_SCRIPT })
    expect(hashOnly.toolsUsed).toEqual([])
    expect(hashOnly.promptHash).toMatch(/^[0-9a-f]{12}$/)
    expect(hashOnly.promptHash).toBe(full.promptHash)
    // The other half of eval-ab's gate (abGateHash): the loop's id for the run.
    expect(hashOnly.promptId).toMatch(/^[0-9a-f]{12}$/)
    expect(hashOnly.promptId).toBe(full.promptId)
  }, 60_000)
})

/**
 * The cost caps, reached with scripted usage instead of a live model: every scripted
 * step bills a fixed, priced amount (types.ts), so a tiny cap is crossed after the
 * first step. Scripted only, like the suite above.
 */
describe.skipIf(LIVE || HASH_ONLY)('cost caps', () => {
  const task = TASKS.find((t) => t.id === 'new-module-write')!
  // The write lands in the first step, so a fail after it can only come from the cap.
  const solveAtOnce: EvalTask = { ...task, script: [task.script[1], task.script[2]] }

  /**
   * The cap stops a runaway, and its attempt must not count as a solve even when the
   * work it left happens to pass: the loop's last step under a cap runs tools-off, so a
   * capped attempt is an attempt that ran out, not one that finished. Drop the
   * `costCapped` check from the grade, or the overrides from runTask, and this reds.
   */
  it('grades an attempt the per-attempt cap stopped as failed, and flags it', async () => {
    const uncapped = await runTask(solveAtOnce)
    expect(uncapped.passed, 'the one-step fix solves the task under the run’s own cap').toBe(true)
    expect(uncapped.costCapped).toBeUndefined()

    const capped = await runTask(solveAtOnce, { maxCostUsd: 1e-6 })
    expect(capped.toolsUsed, 'the fix should have actually run').toContain('write_file')
    expect(capped.exitCode, 'the fix landed before the cap was reached').toBe(0)
    expect(capped.costUsd).toBeGreaterThan(1e-6)
    expect(capped.costCapped).toBe(true)
    expect(capped.passed, 'a capped attempt must not grade as a solve').toBe(false)
    expect(capped.error).toMatch(/per-attempt cost cap/)

    // The scorecard row and its totals say so, and a recording refuses it.
    const report = toTaskReport(task.id, [uncapped, capped])
    expect(report).toMatchObject({ passRate: 0.5, cappedAttempts: 1, erroredAttempts: 0 })
    const scorecard = formatReport({ driver: 'live', model: MODEL, attempts: 2, caps: { attemptUsd: 1e-6 } }, [report])
    expect(scorecard).toContain('COST-CAPPED 1/2')
    expect(scorecard).toContain('1 attempt(s) reached the per-attempt cost cap')
    expect(() =>
      assertRecordable([{ taskId: task.id, passRate: 0.5, attempts: 2 }], [], [{ taskId: task.id, attempts: 1 }])
    ).toThrow(/reached the per-attempt cost cap/)
  }, 60_000)

  /**
   * The cap steps in before it stops anything: at COST_CAP_REMINDER_FRACTION of it, the
   * loop tells the model to wrap up. An attempt that got that reminder spent far more
   * than any normal one and was told to end, so the cap changed how it ended even when
   * it finished under the cap. Two scripted steps bill $0.005 before the third request,
   * so a $0.006 cap reminds at $0.0048 and never stops the run.
   */
  it('grades an attempt the cap told to wrap up as capped, even one that finished under it', async () => {
    const maxCostUsd = 0.006
    const reminded = await runTask(solveAtOnce, { maxCostUsd })
    expect(reminded.exitCode, 'the fix landed').toBe(0)
    expect(reminded.costUsd, 'the attempt spent past the reminder').toBeGreaterThanOrEqual(
      maxCostUsd * COST_CAP_REMINDER_FRACTION
    )
    expect(reminded.costCapped).toBe(true)
    expect(reminded.passed, 'an attempt the cap told to wrap up must not grade as a solve').toBe(false)
    expect(reminded.error, 'the cap reminded the model, it never stopped the run').toMatch(/told to wrap up/)
    expect(toTaskReport(task.id, [reminded])).toMatchObject({ passRate: 0, cappedAttempts: 1 })
  }, 60_000)

  /**
   * The run cap stops STARTING attempts once the run has spent it. Every task it kept
   * from finishing fails its test, and the run then fails naming them all before the
   * baseline step, never quietly grading a smaller set. This goes through the same
   * runTaskAttempts and finishRun the task evals below use, since the scripted run has
   * no run cap and never reaches either throw. The attempt that crosses the cap is real,
   * priced work, so this drives runTask itself.
   */
  it('starts no attempt past the run cap, fails every task it cut short, then the run', async () => {
    const spend = new RunSpend(1e-6)
    const ran: EvalResult[][] = []
    await expect(runTaskAttempts(task.id, 3, spend, () => runTask(task), (r) => ran.push(r))).rejects.toThrow(
      /^Task "new-module-write" stopped after 1 of 3 attempts: .*It is not graded, and the run fails\.$/
    )
    // The crossing attempt runs to its end under its own cap; the next two never start.
    expect(ran).toHaveLength(1)
    const [crossing] = ran[0]
    expect(ran[0]).toHaveLength(1)
    expect(crossing.passed, 'the run cap never cuts an attempt short').toBe(true)
    expect(spend.spentUsd).toBe(crossing.costUsd)

    const other = TASKS.find((t) => t.id === 'fix-null-deref')!
    let started = 0
    const second = runTaskAttempts(other.id, 3, spend, () => {
      started++
      return runTask(other)
    })
    await expect(second).rejects.toThrow(/^Task "fix-null-deref" was not run:/)
    expect(started).toBe(0)
    expect(spend.skipped).toEqual([task.id, other.id])

    // The run fails naming both, and the recording step is never reached.
    const record = vi.fn()
    expect(() => finishRun(spend, record)).toThrow(
      `did not run all their attempts and were not graded:\n  ${task.id}, ${other.id}\n`
    )
    expect(record).not.toHaveBeenCalled()
  }, 60_000)
})

/**
 * HOUSTON_EVAL_HASH_OUT: write the prompt hash the configured live model would get,
 * with no key and no model call (the scripted fake answers, configured with the live
 * provider's kind and models). Any task will do: the suite above pins that every task
 * in a run gets the same hash.
 */
describe.runIf(HASH_ONLY)('prompt hash only', () => {
  it(`hashes the prompt ${PROVIDER_ID}/${MODEL} would get`, async () => {
    // A selection of probes alone names no task, and any task gives the same hash.
    const r = await runTask({ ...(RUN_TASKS[0] ?? TASKS[0]), script: HASH_ONLY_SCRIPT })
    expect(r.promptHash, 'the run made no model request to hash').toMatch(/^[0-9a-f]{12}$/)
    expect(r.promptId, 'the run saved no reply carrying a promptId').toMatch(/^[0-9a-f]{12}$/)
    const gate = abGateHash(r.promptHash!, r.promptId!)
    writeFileSync(resolve(HASH_OUT!), `${gate}\n`)
    console.log(
      `Prompt hash for ${PROVIDER_ID}/${MODEL}: ${gate} (first request ${r.promptHash}, promptId ${r.promptId})` +
        ` → ${resolve(HASH_OUT!)}`
    )
  }, 60_000)
})

/**
 * The driver both tasks and probes run through. Scripted only, like the suites above:
 * each drives the real loop with a script built to reach one path.
 */
describe.skipIf(LIVE || HASH_ONLY)('runAgent', () => {
  const read = (id: string): ScriptedTurn => turn(callTool(id, 'read_file', { path: 'notes.md' }))
  const workspace = (): string => {
    const ws = join(mkdtempSync(join(tmpRoot, 'attempt-')), 'repo')
    mkdirSync(ws)
    writeFileSync(join(ws, 'notes.md'), '# notes\n')
    return ws
  }
  const threeReads = (runId: string): Parameters<typeof runAgent>[1] => ({
    runId,
    messages: [{ role: 'user', content: 'Read notes.md three times.' }],
    policy: 'full-auto',
    script: [read('a'), read('b'), read('c'), turn(say('Done.'))]
  })

  /**
   * The stop is the loop's own cancelRun once the Nth call is answered, so the run ends
   * as a Stop does: no wrap-up reminder (maxIterations would add one) and no next call.
   */
  it('stops the run once maxActions calls are answered', async () => {
    const run = await runAgent(workspace(), threeReads('eval-run-agent-stop'), {
      label: 'stop',
      maxCostUsd: MAX_COST_USD,
      maxActions: 2
    })
    expect(run.cutOff).toBe(true)
    expect(run.calls.map((c) => [c.callId, c.ran, c.ok])).toEqual([
      ['a', true, true],
      ['b', true, true]
    ])
    expect(run.finalText).toBe('')
    expect(run.events.some((e) => e.type === 'limit'), 'a stop is not a limit').toBe(false)
    expect(run.events.at(-1)).toMatchObject({ type: 'done', stopReason: 'aborted' })

    // With room for every call, the same run finishes on its own, closing message and all.
    const whole = await runAgent(workspace(), threeReads('eval-run-agent-whole'), {
      label: 'whole',
      maxCostUsd: MAX_COST_USD,
      maxActions: 4
    })
    expect(whole.cutOff).toBe(false)
    expect(whole.calls).toHaveLength(3)
    expect(whole.finalText).toBe('Done.')
  }, 60_000)

  it('answers what the run blocks on as its hooks say, and records it', async () => {
    const run = await runAgent(
      workspace(),
      {
        runId: 'eval-run-agent-hooks',
        messages: [{ role: 'user', content: 'Tidy the notes.' }],
        // Ask mode prompts for the write, which the hook denies.
        policy: 'ask',
        script: [
          turn(callTool('q', 'ask_user', { question: 'Which notes?', options: [{ label: 'All' }, { label: 'Some' }] })),
          read('r'),
          turn(callTool('w', 'write_file', { path: 'notes.md', content: '# tidy\n' })),
          turn(say('Left them.'))
        ]
      },
      { label: 'hooks', maxCostUsd: MAX_COST_USD, approve: () => 'deny', answer: () => 'All of them' }
    )
    expect(run.questions).toEqual([{ callId: 'q', question: 'Which notes?', answer: 'All of them' }])
    expect(run.calls.find((c) => c.callId === 'q')?.output).toContain('All of them')
    expect(run.approvals).toMatchObject([{ callId: 'w', name: 'write_file', decision: 'deny' }])
    expect(run.calls.find((c) => c.callId === 'w')).toMatchObject({ ran: false, ok: false, kind: 'write' })
    expect(run.finalText).toBe('Left them.')
    expect(run.cutOff).toBe(false)
  }, 60_000)

  // A refused call never gets a tool_start, so its name and arguments come from the saved log.
  it('records a call the loop refused, with the arguments the model sent, in the model’s order', async () => {
    const run = await runAgent(
      workspace(),
      {
        runId: 'eval-run-agent-refused',
        messages: [{ role: 'user', content: 'Edit the notes.' }],
        policy: 'full-auto',
        script: [
          // Two reads run as one batch: the valid one starts first, the refused one is answered first.
          turn(callTool('bad', 'read_file', {}), callTool('ok', 'read_file', { path: 'notes.md' })),
          turn(callTool('edit', 'multi_edit', { path: 'notes.md' })),
          turn(say('Read them.'))
        ]
      },
      { label: 'refused', maxCostUsd: MAX_COST_USD }
    )
    expect(run.calls.map((c) => c.callId)).toEqual(['bad', 'ok', 'edit'])
    expect(run.calls[0]).toMatchObject({ name: 'read_file', args: {}, kind: 'read', ran: false, ok: false })
    expect(run.calls[1]).toMatchObject({ name: 'read_file', ran: true, ok: true })
    expect(run.calls[2]).toMatchObject({ name: 'multi_edit', args: { path: 'notes.md' }, kind: 'write', ran: false, ok: false })
    expect(run.calls[2].output).toMatch(/^Invalid arguments for tool "multi_edit"/)
  }, 60_000)
})

/**
 * Every probe's grader, tested at no cost: its passing script must pass and its failing
 * script must fail, each driven through the real loop. A grader that passes everything,
 * or a harness change that breaks the path a probe takes, reds here.
 */
describe.skipIf(LIVE || HASH_ONLY)('behavior probes', () => {
  const failure = (a: ProbeAttempt): string =>
    [
      `  ${a.grade.detail}`,
      `  calls: ${a.run.calls.map((c) => `${c.name}${c.ran ? '' : ' (refused)'}`).join(' > ') || '(none)'}`,
      `  closing message: ${a.run.finalText.trim()}`
    ].join('\n')

  it.each(PROBES.map((p) => [p.id, p] as const))('%s passes its passing script', async (_id, probe) => {
    const a = await runProbe(probe, { script: probe.passScript })
    expect(a.run.error, 'the run itself failed').toBeUndefined()
    expect(a.grade.passed, `the grader failed the passing script:\n${failure(a)}`).toBe(true)
    expect(a.result).toMatchObject({ taskId: `probe:${probe.id}`, passed: true, exitCode: 0 })
  }, 60_000)

  it.each(PROBES.map((p) => [p.id, p] as const))('%s fails its failing script', async (_id, probe) => {
    const a = await runProbe(probe, { script: probe.failScript })
    expect(a.run.error, 'the run itself failed').toBeUndefined()
    expect(a.grade.passed, `the grader passed the failing script:\n${failure(a)}`).toBe(false)
    expect(a.result).toMatchObject({ passed: false, exitCode: 1, verifyOutput: a.grade.detail })
  }, 60_000)

  /**
   * A run that mixes probes with tasks is stamped with one prompt hash, so a probe in
   * the default mode, seeded or not, must see exactly the tasks' prompt: the seeded
   * history is not part of it. A probe in another mode is left out of the stamp.
   */
  it('gives every probe in the default mode the tasks’ prompt hash and promptId', async () => {
    const task = await runTask(TASKS[0])
    for (const probe of PROBES.filter((p) => (p.policy ?? 'full-auto') === 'full-auto')) {
      const { result } = await runProbe(probe)
      expect(result.promptHash, probe.id).toBe(task.promptHash)
      expect(result.promptId, probe.id).toBe(task.promptId)
    }
  }, 60_000)

  /**
   * A seed is only a fair test of what the agent does next if it is what the agent
   * would really have seen. Replay each seeded call through the loop, in the probe's own
   * workspace, and every result must match the seed's word for word: change a tool's
   * output and this names the seed to update.
   */
  it.each(PROBES.filter((p) => p.messages).map((p) => [p.id, p] as const))(
    '%s seeds only what the loop really returns',
    async (_id, probe) => {
      const [request, ...rest] = probe.messages!
      const asked = rest.filter((m) => m.role === 'assistant')
      const ws = materializeProbe(probe, tmpRoot)
      const run = await runAgent(
        ws,
        {
          runId: `eval-probe-seed-${probe.id}`,
          messages: [structuredClone(request)],
          policy: probe.policy ?? 'full-auto',
          script: asked.map((m) => turn(...(m.toolCalls ?? []).map((c) => callTool(c.id, c.name, structuredClone(c.arguments))))),
          web: probe.web ?? {}
        },
        { label: `seed ${probe.id}`, maxCostUsd: MAX_COST_USD, maxActions: asked.flatMap((m) => m.toolCalls ?? []).length }
      )
      for (const seeded of rest.filter((m) => m.role === 'tool')) {
        const real = run.calls.find((c) => c.callId === seeded.toolCallId)
        expect(real?.output, `the seeded result of ${seeded.toolName} (${seeded.toolCallId}) is stale`).toBe(seeded.content)
      }
    },
    60_000
  )
})

describe.skipIf(HASH_ONLY)(`task evals (${LIVE ? 'live' : 'scripted'} driver)`, () => {
  const reports: TaskReport[] = []
  /** Every attempt's prompt hash; the run is stamped only when they all agree. */
  const hashes: (string | undefined)[] = []
  /** Every attempt's loop promptId, stamped on the run record when those that have one agree. */
  const promptIds: (string | undefined)[] = []

  afterAll(() => {
    const skipped = [...RUN_SPEND.skipped]
    if (!reports.length && !skipped.length) return
    const driver = LIVE ? 'live' : 'scripted'
    const runHash = sharedHash(hashes)
    // Only a record or a baseline names the commit, so only those spawn git.
    const commit = OUT || RECORD ? currentCommit(gitIn(process.cwd())) : undefined
    const scores: TaskScore[] = reports.map((r) => ({
      taskId: r.taskId,
      passRate: r.passRate,
      attempts: r.attempts
    }))
    // The whole run against the baseline, beside each task's own verdict: the per-task
    // tolerance passes a task that lost one attempt, however many tasks did.
    const aggregate = BASELINE ? compareAggregate(BASELINE, scores) : undefined
    console.log(
      formatReport(
        {
          driver,
          model: MODEL,
          attempts: ATTEMPTS,
          promptHash: runHash,
          hashes: hashCensus(hashes),
          baselinePromptHash: BASELINE?.promptHash,
          reasoningEffort: EFFORT,
          baselineReasoningEffort: BASELINE?.reasoningEffort,
          ...(aggregate ? { aggregate } : {}),
          caps: CAPS,
          ...(skipped.length ? { stopped: { spentUsd: RUN_SPEND.spentUsd, skipped } } : {})
        },
        reports
      )
    )
    if (OUT) {
      // Written before the gate and the baseline step, both of which can throw: a run
      // that failed its gate or recorded no baseline is still a valid side of an A/B.
      const record = toRunRecord(
        {
          driver,
          provider: PROVIDER_ID,
          model: MODEL,
          attempts: ATTEMPTS,
          promptHash: runHash,
          promptId: sharedPromptId(promptIds),
          reasoningEffort: EFFORT,
          commit,
          host: process.platform,
          caps: CAPS,
          skipped
        },
        reports,
        new Date()
      )
      writeFileSync(resolve(OUT), `${JSON.stringify(record, null, 2)}\n`)
      console.log(`Wrote run record → ${resolve(OUT)}`)
    }
    // Each skipped task's own test has already failed; finishRun fails the run as a
    // whole, naming all of them in one place, and never reaches the gate or the
    // recording below (the gate reads a task missing from a baseline as unrecorded).
    finishRun(RUN_SPEND, () => {
      // No single task's test can fail for this, so the run fails here, after the record.
      if (aggregate?.kind === 'regressed') throw new Error(aggregateRegressionMessage(aggregate, BASELINE!.recordedAt))
      if (!RECORD) return
      // Recording writes the scorecard as the model's new baseline. Reviewed and
      // committed like a golden: the diff is what documents the behavior change.
      // Never write a baseline that would gate nothing — see assertRecordable.
      // Fold the actual per-task causes into the message: the scorecard is already
      // on stdout, but it scrolls away in a CI log and gets cropped when someone
      // pastes the tail, and the cause is the only part that identifies the fix.
      try {
        assertRecordable(
          scores,
          reports.flatMap((r) => (r.erroredAttempts ? [{ taskId: r.taskId, attempts: r.erroredAttempts }] : [])),
          reports.flatMap((r) => (r.cappedAttempts ? [{ taskId: r.taskId, attempts: r.cappedAttempts }] : []))
        )
      } catch (e) {
        const causes = failureCauses(reports)
        throw new Error(
          [(e as Error).message, '', 'The failures were:', ...causes.map((c) => `  - ${c}`)].join('\n'),
          { cause: e }
        )
      }
      mkdirSync(BASELINES_DIR, { recursive: true })
      const baseline = recordBaseline(PROVIDER_ID, MODEL, ATTEMPTS, scores, new Date(), {
        promptHash: runHash,
        reasoningEffort: EFFORT,
        commit
      })
      writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`)
      console.log(`Recorded baseline → ${baselineFile}\nReview the scores and commit it.`)
    })
  })

  /**
   * The run's rows: its tasks, then its probes as `probe:<id>`. A probe row is an
   * ordinary row from here on (scorecard, run record, eval:compare), except that the
   * gate never grades one: compareToBaseline reads every probe as unrecorded.
   *
   * `stamped` rows are the ones the run's prompt hash and promptId are taken from. A
   * probe that starts in another mode (Plan mode, for one) is told something else by
   * design, so it stays out, rather than leaving the run with no hash at all.
   */
  const rows: Array<{ id: string; probe: boolean; stamped: boolean; attempt: () => Promise<EvalResult> }> = [
    ...RUN_TASKS.map((task) => ({ id: task.id, probe: false, stamped: true, attempt: () => runTask(task) })),
    ...RUN_PROBES.map((probe) => ({
      id: probeResultId(probe.id),
      probe: true,
      stamped: (probe.policy ?? 'full-auto') === 'full-auto',
      attempt: async () => (await runProbe(probe)).result
    }))
  ]

  it.each(rows.map((r) => [r.id, r] as const))(
    '%s',
    async (_id, row) => {
      // Throws when the run cap cut the task short: it is failed, never graded on fewer attempts.
      const attempts = await runTaskAttempts(row.id, ATTEMPTS, RUN_SPEND, row.attempt, (ran) => {
        if (!row.stamped) return
        hashes.push(...ran.map((a) => a.promptHash))
        promptIds.push(...ran.map((a) => a.promptId))
      })
      const passes = attempts.filter((a) => a.passed).length
      const passRate = passes / ATTEMPTS
      const verdict: BaselineVerdict | undefined = BASELINE
        ? compareToBaseline(BASELINE, [{ taskId: row.id, passRate, attempts: ATTEMPTS }])[0]
        : undefined
      const report = toTaskReport(row.id, attempts, verdict)
      reports.push(report)
      const { sample } = report

      // The transcript matters on failure: "verify exited 1" alone can't
      // distinguish a bad edit from a tool that never dispatched at all.
      const detail = [
        `  tools: ${sample.toolsUsed.join(' > ') || '(none dispatched)'}`,
        sample.error ? `  run error: ${sample.error}` : '',
        `  ${row.probe ? 'grader' : 'verify output'}:\n${sample.verifyOutput}`
      ]
        .filter(Boolean)
        .join('\n')

      // SCRIPTED grades execution: the plan was handed to the agent, so anything
      // short of every attempt green is a harness regression. A probe's scripted
      // attempt replays its passing script.
      if (!LIVE) {
        expect(
          passRate,
          row.probe
            ? `Probe "${row.id}" failed its grader on its passing script.\n${detail}`
            : `Task "${row.id}" did not reach a green verify (exit ${sample.exitCode}).\n${detail}`
        ).toBe(1)
        return
      }

      // RECORDING: score, don't grade. The whole point is to capture what the
      // model does today, including the tasks it can't do.
      if (RECORD) return

      // LIVE grades quality against the recorded baseline, with a tolerance that
      // absorbs one flaked attempt (see DEFAULT_TOLERANCE). The flakes it absorbs are
      // added up across the run in afterAll (compareAggregate). A probe is always
      // unrecorded, so it reports its rate and never fails here.
      expect(
        verdict?.kind,
        [
          `Task "${row.id}" scored ${passes}/${ATTEMPTS} against a baseline of ` +
            `${(BASELINE?.tasks[row.id] ?? NaN).toFixed(2)} (recorded ${BASELINE?.recordedAt}).`,
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
