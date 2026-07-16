import { realpathSync } from 'node:fs'
import type {
  AgentEvent,
  AgentRunRequest,
  ChatMessage,
  DocumentAttachment,
  ElicitationField,
  ElicitationResult,
  PlanDecision,
  PlanPayload,
  Provider,
  QuestionOption,
  ReasoningBlock,
  StopReason,
  ToolApprovalDecision,
  ToolCall,
  ToolSchema
} from '@shared/agent'
import { SYSTEM_NOTE_PREFIX } from '@shared/agent'
import { folderTrustState, isApprovalPolicy, type ApprovalPolicy, type PermissionRule } from '@shared/types'
import type { ImageAttachment } from '@shared/images'
import { resolveShellOutputBudget } from '@shared/defaults'
import { resolveContextWindow, turnCostUsd } from '@shared/usage'
import { addPermissionRule, collectSecrets, getKey, getProvider, getSettings } from '../agentHost'
import { createSecretRedactor } from './redact'
import { createProvider } from '../providers'
import { needsExplicitCacheControl } from '../providers/caching'
import { buildSystemPrompt } from './prompt'
import { loadProjectRules } from './rules'
import { loadProjectConfig, mergeProjectMcpServers } from './projectConfig'
import { loadManagedPolicy } from './managedPolicy'
import {
  ASK_USER_NAME,
  PRESENT_PLAN_NAME,
  VIEW_LOCALHOST_NAME,
  getTool,
  resolveInRoots,
  toolSchemas,
  type DispatchAgentOptions,
  type ToolDef,
  type ToolContext,
  type ToolKind
} from './tools'
import {
  ReadCache,
  isCacheableRead,
  readDeps,
  statPath,
  writePaths,
  writeTouchesUnknownPaths
} from './readCache'
import { createShellSession } from './shell-session'
import { getMcpToolDefs } from '../mcp/manager'
import { MCP_LAZY_THRESHOLD, makeFindToolsDef } from './lazy-mcp'
import { isParallelizableRead, partitionCalls } from './scheduling'
import { coerceToolArgs, validateToolArgs, validationError } from './argValidation'
import { abortableSleep, backoffDelayMs, isRetryableError, isToolsUnsupportedError } from './retry'
import { isBlockedByPlan, decideApproval } from './approval'
import { repairDanglingToolResults } from './repair'
import {
  alreadyAllowedAsRule,
  matchRule,
  networkDestination,
  permissionSubject,
  shellReferencesExternalPath,
  shellRulePatterns
} from './permissions'
import {
  grantConversationNetworkHost,
  grantConversationOverride,
  grantConversationShellNetwork,
  overrideForConversation
} from './overrides'
import { recordOriginal, recordResult, noteConversationRun, writeTargets } from './checkpoints'
import { runPostEditDiagnostics } from './diagnostics'
import { isSandboxed, type EgressProxyEndpoints } from '../sandbox'
import { egressEndpointsForRun } from './egress'
import { formatFile } from './format'
import { MAX_SUBAGENT_DEPTH, runSubAgent } from './subagent'
import {
  MAX_SUBAGENT_SESSIONS,
  getSubAgent,
  rememberSubAgent,
  updateSubAgentMessages
} from './subagentSessions'
import { reviewWorkspaceChanges } from './review'
import { captureLocalhost, isCaptureBackendConfigured } from './viewlocalhost'
import {
  isSpawnBackendConfigured,
  spawnSession as engineSpawnSession,
  SPAWN_SESSION_NAME
} from './spawn'
import {
  SCHEDULE_TOOL_NAMES,
  isSchedulerConfigured,
  scheduleCancel,
  scheduleCreate,
  scheduleList
} from './scheduler'
import { matchingHooks, runHooks, type HookOutcome } from './hooks'
import { loadAgents, type CustomAgent } from './agents'
import { loadSkills, resolveSkillInstructions, withBuiltinSkills } from './skills'
import { loadPluginsIfEnabled } from './plugins'
import { buildCapabilities } from './capabilities'
import { gitContext } from './git'
import { gitWritableRoots } from './gitDirs'
import { githubContext, resolveGh, runGh } from './github'
import {
  KEEP_RECENT_USER_TURNS,
  SUMMARY_MAX_TOKENS,
  buildSummaryMessages,
  buildSummaryRequestMessages,
  estimateTokens,
  evictStaleToolResults,
  findCompactionCut,
  findForcedCompactionCut,
  isContextOverflowError,
  isValidCompactionState,
  resolveCompactionThreshold,
  summarizationSystemPrompt
} from './compaction'
import { getConversation, setCompaction } from '../conversations'
import { buildPinnedMessages, lastUserTurnIndex } from './workingMemory'
import { StallDetector, resolveStallThresholds } from './stall'
import { resolveBudgetLimits, shouldLand, landingReminder } from './budget'
import {
  shouldVerify,
  runVerification,
  verifyFailureMessage,
  resolveVerifyMaxPasses
} from './verify-gate'

/** Max times a Stop hook may force another turn, so a blocking hook can't spin forever. */
const MAX_STOP_CONTINUATIONS = 3
/** Max transient-failure retries per model turn (so up to MAX_STREAM_RETRIES+1 attempts). */
const MAX_STREAM_RETRIES = 3

/**
 * Ask the provider to summarize a slice of the conversation. Returns the summary
 * text; tools are intentionally omitted so the model can only reply with prose.
 */
async function summarize(
  provider: Provider,
  model: string,
  messages: ChatMessage[],
  signal: AbortSignal
): Promise<string> {
  let text = ''
  for await (const ev of provider.streamChat({
    model,
    system: summarizationSystemPrompt,
    messages,
    maxTokens: SUMMARY_MAX_TOKENS,
    signal
  })) {
    if (ev.type === 'text') text += ev.text
    else if (ev.type === 'error') throw new Error(ev.message)
  }
  return text.trim()
}

interface RunState {
  abort: AbortController
  approvals: Map<string, (d: ToolApprovalDecision) => void>
  /** Pending `ask_user` questions, keyed by callId, resolved with the user's answer. */
  questions: Map<string, (answer: string) => void>
  /**
   * Display payloads for the prompts currently awaiting the user, keyed by callId.
   * The `tool_approval` / `tool_question` events are one-shot, so a renderer that
   * rebuilds its transcript (e.g. when the conversation is re-opened) would lose a
   * prompt that's still blocking the run. These let {@link pendingPromptsForConversation}
   * replay them on re-adopt so the approve/answer UI re-renders. Kept in lockstep
   * with `approvals`/`questions` (set when emitted, deleted when resolved/cancelled).
   */
  pendingApprovals: Map<
    string,
    {
      name: string
      summary: string
      args: Record<string, unknown>
      kind: ToolKind
      sandboxed?: boolean
      shellNetwork?: boolean
    }
  >
  pendingQuestions: Map<string, { question: string; options: QuestionOption[]; multiSelect?: boolean }>
  /**
   * Pending `present_plan` reviews, keyed by callId. `planDecisions` resolves the
   * blocked tool call once the user decides; `pendingPlans` holds the plan payload so
   * {@link pendingPromptsForConversation} can replay the `plan_ready` event (and thus
   * re-open the review panel) if the conversation is re-adopted. Kept in lockstep with
   * `approvals`/`questions`: set when the plan is emitted, deleted when resolved/cancelled.
   */
  planDecisions: Map<string, (d: PlanDecision) => void>
  pendingPlans: Map<string, PlanPayload>
  /**
   * Pending MCP elicitations (a server asking the user for input mid-tool-call),
   * keyed by elicitId — one tool call can elicit repeatedly, so this is NOT the
   * callId. `elicitations` resolves the blocked server request; `pendingElicitations`
   * holds the event payload for replay on re-adopt. Kept in lockstep like
   * approvals/questions; cancelRun resolves the remainder as 'cancel'.
   */
  elicitations: Map<string, (r: ElicitationResult) => void>
  pendingElicitations: Map<
    string,
    { callId: string; serverId: string; message: string; fields: ElicitationField[] }
  >
  /** Monotonic counter minting unique elicitIds within the run. */
  elicitSeq: number
  /**
   * Tool KINDS the user granted "Allow for run" on. A call is auto-approved when its
   * kind is in this set — per-kind, so allowing a write never silently also allows
   * network/MCP. Seeded from the conversation's accumulated grants (so the consent
   * spans the whole chat, not just this turn) and extended as the user approves more.
   * See {@link overrideForConversation}.
   */
  override: Set<ToolKind>
  /**
   * Egress destinations (see {@link networkDestination}) the user granted "Allow for
   * run" on. Network consent is per-DESTINATION, not per-kind: approving a fetch to one
   * host never widens into a blanket pass for every host. Seeded from the conversation's
   * accumulated grants and extended as the user approves more hosts.
   */
  networkHosts: Set<string>
  /**
   * Per-run consent specifically to run UNCONFINED shell commands. On a host with no
   * enforceable sandbox, a generic `override` (granted for an unrelated tool) does NOT
   * substitute for this — the first unconfined shell command still prompts, surfacing
   * that there is no OS sandbox. Only "Allow for run" on such a prompt sets this. Stays
   * false (and unused) on confining hosts like macOS.
   */
  shellUnsandboxedOverride: boolean
  /**
   * Whether shell commands may reach the network this run. Drives the sandbox's network
   * switch — network egress is all-or-nothing at the OS layer, so this is one boolean,
   * not a per-host set. Set by the one-time full-auto shell-network consent, or by
   * "Allow for run" on a shell command (auto-edit/ask). When false, shell runs offline.
   */
  shellNetworkGranted: boolean
  /**
   * Whether the user has answered the one-time full-auto shell-network consent (grant
   * OR decline). Guards the prompt so it fires once per run rather than on every command;
   * a decline is remembered so the run keeps executing shell offline without re-asking.
   */
  shellNetworkDecided: boolean
  /**
   * The live approval policy. Seeded from the run request, but mutable so a
   * change made mid-run (e.g. the user switches the mode dropdown while the
   * agent is working) takes effect on the *next* tool-permission check rather
   * than only on the next turn. Read at call time everywhere policy is gated.
   */
  policy: ApprovalPolicy
  /**
   * The events emitted since the message log was last persisted — the in-flight
   * turn's streamed output (assistant text, running tools, prompts) that isn't on
   * disk yet. A renderer re-opening the conversation rebuilds its transcript from
   * disk, which for a still-streaming turn holds only the user message, so the
   * live output would vanish; {@link liveTranscriptForConversation} hands this
   * buffer back so the renderer can replay it on re-adopt. Cleared at every persist
   * (see the `persist` wrapper in {@link startRun}) so it never double-counts a
   * round already written to disk. reduceEvent upserts by id/callId, so replaying
   * onto the disk-rebuilt transcript is idempotent.
   */
  transcript: AgentEvent[]
  /**
   * The id of the WebContents (renderer window) that started this run, when it was
   * started from the GUI. Recorded so the IPC layer can reject run-control calls
   * (approve / answer / set-policy / cancel) that arrive from any *other* window:
   * every AgentEvent broadcasts its runId to every window, so knowing a runId can't
   * imply the right to control the run. Undefined for TUI/headless runs, which have
   * no WebContents and reach the resolvers directly rather than over IPC.
   */
  owner?: number
}

const runs = new Map<string, RunState>()

/**
 * conversationId -> the runId currently executing on it. A conversation may have
 * at most one live run: a second concurrent run would interleave its persisted
 * `setMessages` writes with the first's and corrupt the message log. Populated in
 * {@link startRun} and cleared when the run ends.
 */
const runsByConversation = new Map<string, string>()

/**
 * The runId of the run currently executing on a conversation, or null if none is
 * active. The renderer uses this to re-adopt a backgrounded run when its
 * conversation is re-opened (show Stop, reconnect events/approvals) instead of
 * starting a second one.
 */
export function activeRunForConversation(conversationId: string): string | null {
  return runsByConversation.get(conversationId) ?? null
}

/**
 * How many conversations currently have a live run. Read at quit time to warn the
 * user before tearing down in-flight work (each conversation has at most one run,
 * so this is the count of "chats still running").
 */
export function activeRunCount(): number {
  return runsByConversation.size
}

/** The ids of every conversation that currently has a live run. */
export function runningConversationIds(): string[] {
  return [...runsByConversation.keys()]
}

/**
 * Listeners notified whenever the set of running conversations changes (a run
 * started or ended). The IPC layer subscribes to broadcast the new set to the
 * renderer so the sidebar can show a "running" dot on each live chat. Kept here,
 * Electron-free, so the loop stays unit-testable.
 */
const runsChangedListeners = new Set<(ids: string[]) => void>()

/** Subscribe to running-set changes; returns an unsubscribe function. */
export function onActiveRunsChanged(fn: (ids: string[]) => void): () => void {
  runsChangedListeners.add(fn)
  return () => runsChangedListeners.delete(fn)
}

function notifyActiveRunsChanged(): void {
  const ids = runningConversationIds()
  for (const fn of runsChangedListeners) fn(ids)
}

export function cancelRun(runId: string): void {
  const run = runs.get(runId)
  if (!run) return
  for (const resolve of run.approvals.values()) resolve('deny')
  run.approvals.clear()
  run.pendingApprovals.clear()
  // Unblock any pending question so its tool call returns instead of hanging.
  for (const resolve of run.questions.values()) resolve('[The user stopped the agent without answering.]')
  run.questions.clear()
  run.pendingQuestions.clear()
  // Unblock any pending plan review (treated as a reject) so present_plan returns.
  for (const resolve of run.planDecisions.values()) resolve({ kind: 'reject' })
  run.planDecisions.clear()
  run.pendingPlans.clear()
  // Unblock any pending MCP elicitation so the server gets its answer (a cancel).
  for (const resolve of run.elicitations.values()) resolve({ action: 'cancel' })
  run.elicitations.clear()
  run.pendingElicitations.clear()
  run.abort.abort()
}

export function resolveApproval(runId: string, callId: string, decision: ToolApprovalDecision): void {
  const run = runs.get(runId)
  const resolve = run?.approvals.get(callId)
  if (run && resolve) {
    run.approvals.delete(callId)
    run.pendingApprovals.delete(callId)
    resolve(decision)
  }
}

/** Deliver the user's answer to a pending `ask_user` question. */
export function resolveQuestion(runId: string, callId: string, answer: string): void {
  const run = runs.get(runId)
  const resolve = run?.questions.get(callId)
  if (run && resolve) {
    run.questions.delete(callId)
    run.pendingQuestions.delete(callId)
    resolve(answer)
  }
}

/** Deliver the user's answer to a pending MCP elicitation. */
export function resolveElicitation(runId: string, elicitId: string, result: ElicitationResult): void {
  const run = runs.get(runId)
  const resolve = run?.elicitations.get(elicitId)
  if (run && resolve) {
    run.elicitations.delete(elicitId)
    run.pendingElicitations.delete(elicitId)
    resolve(result)
  }
}

/** Deliver the user's decision on a pending `present_plan` review. */
export function resolvePlan(runId: string, callId: string, decision: PlanDecision): void {
  const run = runs.get(runId)
  const resolve = run?.planDecisions.get(callId)
  if (run && resolve) {
    run.planDecisions.delete(callId)
    run.pendingPlans.delete(callId)
    resolve(decision)
  }
}

/**
 * The tool-result text returned to the model for a plan decision, plus the side
 * effect of accepting: switching the live run off Plan mode to the chosen edit mode
 * so the very next tool call in this turn is no longer blocked as read-only.
 */
function planDecisionResult(run: RunState, decision: PlanDecision): string {
  if (decision.kind === 'accept') {
    run.policy = decision.mode
    const how =
      decision.mode === 'auto-edit'
        ? 'Edits will be applied automatically as you make them.'
        : 'You will be asked to approve each edit.'
    const edited = decision.editedBody?.trim()
    if (edited) {
      // The user edited the plan by hand; it supersedes what the agent presented.
      return (
        'The user ACCEPTED the plan but EDITED it first, and switched off Plan mode. Carry out ' +
        'EXACTLY the following edited plan — it replaces the plan you presented, so follow it precisely ' +
        `even where it differs from yours:\n\n${edited}\n\n${how}`
      )
    }
    return `The user ACCEPTED the plan and switched off Plan mode. Carry out the plan now, step by step. ${how}`
  }
  if (decision.kind === 'suggest') {
    return (
      'The user wants changes before you proceed:\n\n' +
      `${decision.note}\n\n` +
      'Revise the plan accordingly and call present_plan again with the updated plan. ' +
      'Do not make any changes yet — you are still in Plan mode.'
    )
  }
  return 'The user REJECTED this plan. Do not make any changes. Briefly acknowledge and wait for their next instruction.'
}

/**
 * The prompts (approvals + `ask_user` questions) currently blocking a conversation's
 * live run, rebuilt as the original one-shot events so a renderer re-opening the
 * conversation can replay them and re-render the approve/answer UI. Empty when the
 * conversation has no live run or nothing is awaiting the user.
 */
export function pendingPromptsForConversation(conversationId: string): AgentEvent[] {
  const runId = runsByConversation.get(conversationId)
  if (!runId) return []
  const run = runs.get(runId)
  if (!run) return []
  const events: AgentEvent[] = []
  for (const [callId, a] of run.pendingApprovals) {
    events.push({
      runId,
      type: 'tool_approval',
      callId,
      name: a.name,
      summary: a.summary,
      args: a.args,
      kind: a.kind,
      ...(a.sandboxed === false ? { sandboxed: false } : {}),
      ...(a.shellNetwork ? { shellNetwork: true } : {})
    })
  }
  for (const [callId, q] of run.pendingQuestions) {
    events.push({
      runId,
      type: 'tool_question',
      callId,
      question: q.question,
      options: q.options,
      ...(q.multiSelect ? { multiSelect: true } : {})
    })
  }
  for (const [callId, plan] of run.pendingPlans) {
    events.push({ runId, type: 'plan_ready', callId, plan })
  }
  for (const [elicitId, e] of run.pendingElicitations) {
    events.push({
      runId,
      type: 'elicitation',
      callId: e.callId,
      elicitId,
      serverId: e.serverId,
      message: e.message,
      fields: e.fields
    })
  }
  return events
}

/**
 * The events streamed on a conversation's live run since its message log was last
 * persisted — the in-flight turn's output that isn't on disk yet (assistant text
 * still streaming, tools mid-execution, etc.). A renderer re-opening the
 * conversation replays these onto its disk-rebuilt transcript so the visible output
 * doesn't vanish while the turn is still running (most visible on a freshly spawned
 * session, which the user opens precisely to watch its first turn stream). Empty
 * when the conversation has no live run. See {@link RunState.transcript}.
 */
export function liveTranscriptForConversation(conversationId: string): AgentEvent[] {
  const runId = runsByConversation.get(conversationId)
  if (!runId) return []
  const run = runs.get(runId)
  return run ? [...run.transcript] : []
}

/**
 * The id of the WebContents that started a run, or undefined for a TUI/headless
 * run (no owner) or an unknown/finished run. The IPC layer reads this to authorize
 * run-control calls at the boundary — only the owning window may approve/answer/
 * set-policy/cancel a run, since runIds are broadcast to every window.
 */
export function runOwner(runId: string): number | undefined {
  return runs.get(runId)?.owner
}

/**
 * Update the active approval policy for an in-flight run. Subsequent tool calls
 * in the same run are gated by the new policy immediately; finished or unknown
 * runs are a no-op. A pending approval prompt is intentionally left as-is — the
 * user answers it explicitly — but everything after it follows the new policy.
 */
export function setRunPolicy(runId: string, policy: ApprovalPolicy): void {
  // Validate at the boundary: an unknown policy would fail *open* in needsApproval
  // (a non-'ask' value auto-approves writes), so reject anything off the list.
  if (!isApprovalPolicy(policy)) return
  const run = runs.get(runId)
  if (run) run.policy = policy
}

function waitForApproval(run: RunState, callId: string): Promise<ToolApprovalDecision> {
  return new Promise((resolve) => run.approvals.set(callId, resolve))
}

/**
 * Run the agent loop, streaming events via `send`. Never throws — errors become events.
 * `onMessages` is called whenever the message log grows, so the caller can persist it.
 */
export async function startRun(
  req: AgentRunRequest,
  send: (e: AgentEvent) => void,
  onMessages?: (messages: ChatMessage[]) => void,
  /**
   * The WebContents id of the renderer starting this run, recorded on the RunState
   * so IPC run-control calls can be authorized against it (see {@link runOwner}).
   * Omitted for TUI/headless runs, which drive the resolvers directly.
   */
  owner?: number
): Promise<void> {
  const { runId, conversationId } = req

  // Safety net against concurrent runs on one conversation: their interleaved
  // onMessages writes would corrupt the persisted log. The UI also guards this
  // (it re-adopts a live run on re-open rather than starting a new one), but a
  // second start must fail loudly here regardless of how it was triggered.
  if (conversationId && runsByConversation.has(conversationId)) {
    send({ runId, type: 'error', message: 'A run is already in progress for this conversation.' })
    return
  }

  const abort = new AbortController()
  // Seed "Allow for run" consent from any the user granted earlier in this
  // conversation, so it carries across turns rather than resetting each message.
  const seededOverride = overrideForConversation(conversationId)
  const run: RunState = {
    abort,
    approvals: new Map(),
    questions: new Map(),
    pendingApprovals: new Map(),
    pendingQuestions: new Map(),
    planDecisions: new Map(),
    pendingPlans: new Map(),
    elicitations: new Map(),
    pendingElicitations: new Map(),
    elicitSeq: 0,
    override: seededOverride.kinds,
    networkHosts: seededOverride.networkHosts,
    shellUnsandboxedOverride: seededOverride.unsandboxedShell,
    shellNetworkGranted: seededOverride.shellNetworkGranted,
    shellNetworkDecided: seededOverride.shellNetworkDecided,
    policy: req.approvalPolicy,
    transcript: [],
    ...(owner !== undefined ? { owner } : {})
  }
  runs.set(runId, run)
  if (conversationId) {
    runsByConversation.set(conversationId, runId)
    // Record this as the conversation's latest run so its checkpoint (the
    // revert/redo affordance) can be restored if the conversation is re-opened.
    noteConversationRun(conversationId, runId)
    notifyActiveRunsChanged()
  }

  type DistributiveOmitRunId<T> = T extends unknown ? Omit<T, 'runId'> : never
  const emit = (e: DistributiveOmitRunId<AgentEvent>): void => {
    const full = { ...(e as object), runId } as AgentEvent
    // Buffer what streams this round so a renderer that re-opens the conversation
    // mid-turn can replay it (the disk log lags a streaming round). Cleared at each
    // `persist` below, so the buffer only ever holds events not yet on disk.
    run.transcript.push(full)
    send(full)
  }

  // Persist the message log AND reset the live-transcript buffer: everything up to
  // this point is now on disk, so only what streams *after* it needs replaying on a
  // mid-turn re-open. Wraps the caller's onMessages so every persist site stays in
  // lockstep with the buffer (see {@link RunState.transcript}).
  const persist = (msgs: ChatMessage[]): void => {
    run.transcript = []
    onMessages?.(msgs)
  }

  // Hoisted above the try so the `finally` can backfill results for any tool call
  // left dangling by an interruption (see the repair calls below).
  const messages: ChatMessage[] = [...req.messages]

  try {
    let workspace: string
    try {
      workspace = realpathSync(req.workspace)
    } catch {
      emit({ type: 'error', message: 'The selected project folder does not exist.' })
      return
    }

    const providerConfig = getProvider(req.providerId)
    if (!providerConfig) {
      emit({ type: 'error', message: `Unknown provider: ${req.providerId}` })
      return
    }
    // Host-listed capability metadata for the selected model. `reasoning` overrides
    // the adapter's id-based heuristic so host-routed reasoning models still get a
    // reasoning param; the pricing fields make cost estimates exact for models the
    // name-heuristics don't know. Undefined when the model carries no metadata.
    const selectedModelCaps = providerConfig.models.find((m) => m.id === req.model)?.caps
    const reasoningCapable = selectedModelCaps?.reasoning
    // Opt explicit-caching routes (Claude/Qwen/Gemini via an aggregator host) into
    // prompt caching on the iterative loops. One-shot calls (title, compaction)
    // stay opted out: a cache write is a surcharge that only pays off when the
    // next turn reads it back.
    const explicitCacheControl = needsExplicitCacheControl(req.model, selectedModelCaps)

    let provider
    try {
      provider = createProvider(providerConfig)
    } catch (e) {
      emit({ type: 'error', message: (e as Error).message })
      return
    }

    const settings = getSettings()
    const rules = await loadProjectRules(workspace)
    // Permission-rule precedence, highest first (first match wins):
    //   1. Admin managed policy — org-distributed, root-owned; deny/ask only.
    //   2. Project guardrails    — .houston/settings.json; deny/ask only.
    //   3. The user's own rules  — global Settings; allow/deny/ask.
    //   4. Project allow rules   — ONLY when the user trusted the folder.
    // Tiers 1 and 2 can only *tighten*: neither can add an `allow`, so a managed
    // policy or an untrusted repo can restrict the user but never auto-approve on
    // their behalf. A TRUSTED folder's `allow` rules join at the LOWEST tier: they
    // fill gaps the user hasn't decided, but can never shadow a user (or guardrail)
    // rule for the same target. See managedPolicy.ts / projectConfig.ts.
    const managedPolicy = await loadManagedPolicy()
    const projectConfig = await loadProjectConfig(workspace)
    // Whether this folder's ELEVATING project config (allow rules, hooks, MCP
    // servers) is honored: only after the user's explicit trust consent, and only
    // while the elevating subset still matches the fingerprint they consented to —
    // a drift (e.g. a pull that adds a hook) drops back to untrusted.
    const projectTrusted =
      projectConfig.elevatedHash !== '' &&
      folderTrustState(settings.trustedFolders, workspace, projectConfig.elevatedHash) === 'trusted'
    // The two guardrail tiers that outrank the user. A mid-run "Always allow/deny"
    // is spliced in just BELOW their count so live consent can never shadow an admin
    // or project rule (see the splice near the approval handler). The slice is also
    // kept separately so the approval gate can tell a guardrail-mandated `ask` from
    // a user-tier one — only the latter can be skipped by a hook's `approve`.
    const guardrailRules = [...managedPolicy.permissionRules, ...projectConfig.permissionRules]
    const guardrailRuleCount = guardrailRules.length
    const permissionRules = [
      ...guardrailRules,
      ...(settings.permissionRules ?? []),
      ...(projectTrusted ? projectConfig.elevated.allowRules : [])
    ]
    // Hooks likewise: a trusted folder's project hooks run after the user's own.
    const hooks = projectTrusted
      ? [...(settings.hooks ?? []), ...projectConfig.elevated.hooks]
      : (settings.hooks ?? [])
    // The system prompt is built once and can't change mid-run, so plan-mode
    // *guidance* is a snapshot of the starting policy. The runtime plan-mode
    // *block* below reads `run.policy`, so toggling plan on/off mid-run still
    // gates tool calls live — only the prose the model already saw is fixed.
    const planMode = req.approvalPolicy === 'plan'
    const agents = await loadAgents(workspace)
    // Merge Houston's built-in skills (e.g. houston-guide) with the workspace's
    // own for the agent runtime; `/skills` still lists only the workspace's.
    const skills = withBuiltinSkills(await loadSkills(workspace))
    // Local plugins (.houston/plugins/*.js) register observational lifecycle
    // hooks. They are executable JS run in-process and `vm` is not a security
    // boundary, so they are NEVER auto-run for an opened repo — only when the user
    // has explicitly opted into project plugins for a trusted project. See
    // plugins.ts for the trust boundary.
    const plugins = await loadPluginsIfEnabled(workspace, settings.projectPlugins)
    const agentsByName = new Map(agents.map((a) => [a.name, a]))
    const capabilities = buildCapabilities(
      agents,
      skills,
      providerConfig.models.map((m) => m.id)
    )
    // Git + GitHub awareness folded into the prompt. githubContext is a pure PATH
    // probe (no network), so the run start never triggers unapproved egress.
    const gitStatus = [await gitContext(workspace), githubContext()].filter((s) => s.trim()).join('\n')
    // view_localhost screenshots via an offscreen browser the Electron shell wires
    // at startup. The standalone CLI wires none, so drop the tool from the schema
    // set and the prompt rather than offering one that fails after an approval.
    const localhostCaptureAvailable = isCaptureBackendConfigured()
    // Hosts wire a spawn backend at startup (the desktop shell and the terminal
    // entries both do); a host that didn't gets spawn_session dropped from the
    // toolset and the prompt, mirroring view_localhost.
    const spawnAvailable = isSpawnBackendConfigured()
    // Same seam pattern for scheduled runs: hosts that wire a scheduler backend
    // get the schedule tools; others have them dropped from toolset + prompt.
    const schedulerAvailable = isSchedulerConfigured()
    let system = buildSystemPrompt(
      workspace,
      settings.systemPromptExtra,
      rules.text,
      planMode,
      capabilities,
      gitStatus,
      req.providerId,
      req.model,
      localhostCaptureAvailable,
      spawnAvailable,
      schedulerAvailable
    )
    // Built-in tools plus any tools from connected MCP servers (best effort).
    // When a lot of MCP tools are connected, sending every schema on every turn
    // bloats the context window (and bills BYO-model users) for tools the model
    // may never touch. Above a threshold we defer them: the model gets a compact
    // catalog via a `find_tools` meta-tool and loads only what it needs, which
    // then rides along on later turns. At/below the threshold nothing changes.
    // A trusted folder's project MCP servers join the user's own under a `proj-`
    // id prefix (user servers win collisions); untrusted folders contribute none.
    const mcpToolDefs = await getMcpToolDefs(
      projectTrusted
        ? mergeProjectMcpServers(settings.mcpServers, projectConfig.elevated.mcpServers)
        : settings.mcpServers
    )
    const lazyMcp = mcpToolDefs.length > MCP_LAZY_THRESHOLD
    const revealedMcp = new Set<string>()
    const findTools = lazyMcp ? makeFindToolsDef(mcpToolDefs, revealedMcp) : null
    const lookupTool = (name: string): ToolDef | undefined =>
      getTool(name) ??
      (findTools && name === findTools.schema.name ? findTools : undefined) ??
      mcpToolDefs.find((d) => d.schema.name === name)
    // Whether any Pre/PostToolUse hook matches this tool. A hook implies ordering or
    // an observed side-effect, so the read cache must not short-circuit such a call.
    const hasMatchingHook = (name: string): boolean =>
      matchingHooks(hooks, 'PreToolUse', name).length > 0 ||
      matchingHooks(hooks, 'PostToolUse', name).length > 0
    // The schemas advertised to the model this turn: built-ins, plus either every
    // MCP schema (small setups) or just find_tools + already-revealed MCP tools
    // (lazy). Recomputed each turn so tools revealed via find_tools then appear.
    const buildTools = (): ToolSchema[] => [
      ...toolSchemas().filter(
        (s) =>
          (localhostCaptureAvailable || s.name !== VIEW_LOCALHOST_NAME) &&
          (spawnAvailable || s.name !== SPAWN_SESSION_NAME) &&
          (schedulerAvailable || !(SCHEDULE_TOOL_NAMES as readonly string[]).includes(s.name)) &&
          // present_plan is the "exit Plan mode" tool; only offer it in Plan mode.
          (planMode || s.name !== PRESENT_PLAN_NAME)
      ),
      ...(findTools ? [findTools.schema] : []),
      ...mcpToolDefs
        .filter((d) => !lazyMcp || revealedMcp.has(d.schema.name))
        .map((d) => d.schema)
    ]
    // A prior run interrupted while a tool call was pending (commonly parked on an
    // approval prompt, or a long-blocking present_plan / ask_user, when the app
    // quit/crashed) leaves an assistant `tool_use` with no matching `tool_result` —
    // and if the user then re-sent a message, that user turn now sits between the
    // `tool_use` and where a result should go. Providers reject such history, so
    // normalize it (pair every call with its result, in position) before the first
    // provider call. Persist the repair so the stored log and transcript are valid
    // too, not just the in-flight request.
    const intakeRepaired = repairDanglingToolResults(messages)
    if (intakeRepaired !== messages) {
      messages.splice(0, messages.length, ...intakeRepaired)
      persist(messages)
    }

    // Redact secrets from content that leaves the agent's control boundary — reused
    // for the user's own input (below), tool results, and hook output. Built once from
    // this install's stored secrets (see redact.ts); snapshotted at run start, so a key
    // added mid-run applies next run. The same snapshot backs egress-side masking in the
    // network tools (they refuse to SEND any of these values), so both directions of the
    // secret boundary read from one list.
    const knownSecrets = collectSecrets()
    const redact = createSecretRedactor(knownSecrets)

    // Surface a hook's `systemMessage` directive as a user-facing transcript notice.
    // Emit-only by design: it never lands in `messages`, so the model never sees it
    // (the documented contract of the directive).
    const emitHookNotice = (outcome: HookOutcome): void => {
      if (outcome.systemMessage) emit({ type: 'notice', message: redact(outcome.systemMessage) })
    }

    // Scrub secrets out of the just-submitted user turn before anything downstream —
    // the model, plugins, hooks, and the persisted transcript — sees it, reusing the
    // same engine as tool-result redaction. A pasted API key or a token-shaped string
    // is stripped in place; then we re-persist so the copy the caller already wrote to
    // disk (ipc.ts / the CLI) is overwritten with the redacted text. Ordinary prose —
    // nothing secret-shaped, nothing matching a stored value — is left untouched. Done
    // here in startRun so it covers every client (GUI, TUI, headless) at one seam.
    const latestUser = [...messages].reverse().find((m) => m.role === 'user')
    if (latestUser && typeof latestUser.content === 'string') {
      const scrubbed = redact(latestUser.content)
      if (scrubbed !== latestUser.content) {
        latestUser.content = scrubbed
        persist(messages)
      }
    }

    // Notify plugins of the user turn that started this run (the latest user
    // message). Observational; a plugin error degrades to a warning (see plugins.ts).
    if (plugins.has('onUserMessage')) {
      const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')
      if (lastUser && typeof lastUser.content === 'string') {
        await plugins.emit('onUserMessage', { text: lastUser.content })
      }
    }

    // Allowed roots: the workspace plus any configured additional directories
    // that still resolve (deduped). This is the file-tool + sandbox boundary.
    const roots = [workspace]
    for (const dir of settings.additionalRoots ?? []) {
      try {
        const real = realpathSync(dir)
        if (!roots.includes(real)) roots.push(real)
      } catch {
        // a configured directory that no longer exists — skip it
      }
    }
    // When a root is a linked worktree (or submodule), its git dir lives OUTSIDE
    // the working tree, so a bare `git fetch`/`commit`/`checkout` would otherwise be
    // denied the writes it makes to FETCH_HEAD/index/objects/refs. Widen the writable
    // roots to cover those git dirs — for the workspace and every added root alike.
    // Plain checkouts add nothing. Snapshot first so we don't rescan the git dirs.
    for (const base of [...roots]) {
      for (const dir of gitWritableRoots(base)) {
        if (!roots.includes(dir)) roots.push(dir)
      }
    }

    // Persistent shell state for this run: `cd` and exported env carry between
    // foreground run_shell calls so the agent gets "same terminal" behavior.
    const shellSession = createShellSession(workspace)

    // Egress allowlist: resolve the shared proxy's endpoints once per run.
    // Present → any granted shell network is PROXIED and per-domain filtered
    // (the proxy re-reads settings per request, so allow/deny edits apply
    // mid-run); undefined → the user chose egress mode 'all' (legacy full
    // network). Fails CLOSED: if the proxy cannot start, shell network stays
    // OFF for this run — never fall back to unrestricted egress because the
    // restriction machinery broke.
    let egressProxy: EgressProxyEndpoints | undefined
    let egressUnavailable = false
    try {
      egressProxy = await egressEndpointsForRun()
    } catch {
      egressUnavailable = true
    }

    // Resolve `gh` once for the run; the GitHub tools fall back to their own
    // resolution (and a guiding error) when it isn't installed.
    const ghPath = resolveGh()
    const ghExec = ghPath ? runGh(ghPath) : undefined

    /**
     * Apply the side effects of the user's verdict on an approval prompt — "Allow
     * for run" grants (per-DESTINATION for network calls, per-kind otherwise, plus
     * the conscious unconfined-shell and shell-network consents), and "Always
     * allow/deny" permission-rule persistence — and return whether the call may
     * proceed. Shared by the main tool-call gate and the writable subagent's
     * per-command unconfined-shell gate, so a decision means exactly the same thing
     * whichever prompt it answered.
     */
    const applyApprovalDecision = (
      decision: ToolApprovalDecision,
      toolName: string,
      execArgs: Record<string, unknown>,
      kind: ToolKind,
      unsandboxedShell: boolean
    ): boolean => {
      if (decision === 'always') {
        const netDest = kind === 'network' ? networkDestination(toolName, execArgs) : null
        if (netDest !== null) {
          // "Allow for run" on a network call — grant THIS destination only, not the
          // whole kind, so approving one host never opens egress to another. Remembered
          // on the conversation so later turns inherit the consent.
          run.networkHosts.add(netDest)
          grantConversationNetworkHost(conversationId, netDest)
        } else {
          // "Allow for run" — auto-approve this KIND for the rest of the run, and
          // remember it on the conversation so later turns inherit the consent.
          run.override.add(kind)
          // "Allow for run" on an unconfined-shell prompt is the conscious consent
          // to keep running unsandboxed; a generic override never sets this.
          if (unsandboxedShell) run.shellUnsandboxedOverride = true
          // Granting shell for the run also lets shell reach the network — the
          // pre-existing auto-edit/ask semantics; the sandbox reads this flag.
          if (kind === 'shell') {
            run.shellNetworkGranted = true
            grantConversationShellNetwork(conversationId, true)
          }
          grantConversationOverride(conversationId, kind, unsandboxedShell)
        }
      } else if (decision === 'rule-allow' || decision === 'rule-deny') {
        // "Always allow/deny" — persist a permission rule for this tool + subject
        // so the choice survives restarts, and splice it into this run's rules
        // (after the managed + project guardrail rules, which only tighten, so a
        // user's live consent can never shadow an admin or project rule) now.
        // For an ALLOW on run_shell we store generalized, per-sub-command prefixes
        // (dropping the `cd` prelude) instead of the exact command, and skip any
        // pattern an existing rule already allows — so repeated commands don't pile
        // up one near-identical rule each. Deny stays exact (a broad deny is risky).
        const action = decision === 'rule-allow' ? 'allow' : 'deny'
        const subject = permissionSubject(toolName, execArgs)
        const matches =
          action === 'allow' && toolName === 'run_shell' && subject
            ? shellRulePatterns(subject)
            : [subject || '*']
        for (const match of matches) {
          if (action === 'allow' && alreadyAllowedAsRule(permissionRules, toolName, match)) {
            continue
          }
          const rule: PermissionRule = { action, tool: toolName, match }
          addPermissionRule(rule)
          permissionRules.splice(guardrailRuleCount, 0, rule)
        }
      }
      return decision !== 'deny' && decision !== 'rule-deny'
    }

    // ---- Subagent dispatch ------------------------------------------------
    // One implementation behind dispatch_agent and dispatch_writable_agent (and
    // their nested and resumed forms). Stored transcripts are keyed by the
    // conversation so a subagent id handed out this turn can be resumed in a
    // later turn of the same chat; a conversation-less run keys by runId.
    const subagentKey = conversationId ?? runId

    /**
     * Resolve a dispatch's model: explicit `model` argument > the custom agent's
     * front-matter `model:` > the run's own model. An explicit argument must be
     * one of the provider's configured ids (fail loudly — the model can correct
     * itself from the list); an unknown front-matter id falls back silently (the
     * agent file is checked in and shared across machines whose providers differ,
     * so it must not break the dispatch).
     */
    const resolveDispatchModel = (
      requested: string | undefined,
      agent: CustomAgent | undefined
    ): { model: string; error?: string } => {
      const available = providerConfig.models.map((m) => m.id)
      if (requested) {
        // The run's own model is always acceptable, even when the provider config
        // lists no models (some custom endpoints don't enumerate them).
        if (requested === req.model) return { model: requested }
        if (!available.includes(requested)) {
          return {
            model: req.model,
            error: available.length
              ? `Unknown model "${requested}" for provider ${req.providerId}. Configured models: ${available.join(', ')}. Omit model to use ${req.model}.`
              : `Model overrides aren't available: provider ${req.providerId} lists no models. Omit model to use ${req.model}.`
          }
        }
        return { model: requested }
      }
      if (agent?.model && available.includes(agent.model)) return { model: agent.model }
      return { model: req.model }
    }

    const runDispatch = async (input: {
      /** The dispatch tool call this agent belongs to — progress events attach to it. */
      callId: string
      opts: DispatchAgentOptions
      writable: boolean
      /** Depth of the agent being dispatched: 1 from the main agent, 2 nested. */
      depth: number
    }): Promise<string> => {
      const { callId, opts, writable, depth } = input
      const agent = opts.agent ? agentsByName.get(opts.agent) : undefined
      if (opts.agent && !agent) return `Unknown agent: ${opts.agent}`
      if (writable && agent && agent.write !== true) {
        return `Agent "${opts.agent}" is read-only. Use dispatch_agent for it, or add \`write: true\` to its .houston/agents file to allow changes.`
      }

      // Resume: continue a stored transcript. The stored agent's config (model,
      // system prompt, tool narrowing) wins over the call's arguments so the
      // continued context reads consistently to the model.
      const resumed = opts.resume ? getSubAgent(subagentKey, opts.resume) : undefined
      if (opts.resume && !resumed) {
        return `Unknown subagent id "${opts.resume}" — ids cover the ${MAX_SUBAGENT_SESSIONS} most recent dispatches of this chat and last for the app session. Dispatch a fresh agent instead.`
      }
      if (resumed && resumed.writable !== writable) {
        return resumed.writable
          ? `Subagent ${resumed.id} is writable — resume it with dispatch_writable_agent (its write authority needs that tool's approval).`
          : `Subagent ${resumed.id} is read-only — resume it with dispatch_agent.`
      }

      const modelRes = resolveDispatchModel(opts.model, agent)
      if (modelRes.error) return modelRes.error
      // The dispatch bills at the SUB-model's rates, so cost/caching below use its
      // caps, not the main run's.
      const model = resumed ? resumed.model : modelRes.model
      const modelCaps = providerConfig.models.find((m) => m.id === model)?.caps
      const systemOverride = resumed ? resumed.systemOverride : agent?.systemPrompt
      const allowedTools = resumed ? resumed.tools : agent?.tools

      // Per-command consent for UNCONFINED shell (writable tier on a host with no
      // OS sandbox): the subagent's run_shell would otherwise be refused (it can't
      // prompt from the background), so this gate propagates each such command to
      // the user as a normal tool_approval on a minted callId under the dispatch.
      // Deny rules still win without a prompt, the per-run unconfined-shell
      // consent ("Allow for run") skips further prompts exactly as it does for the
      // main loop, and the command's start/result are emitted so a command running
      // unconfined on this machine is never invisible. Only consulted by
      // runSubAgent when the host lacks an OS sandbox.
      let gateSeq = 0
      const gateUnconfinedShell = async (
        gateArgs: Record<string, unknown>,
        runCommand: () => Promise<string>
      ): Promise<string> => {
        const subject = permissionSubject('run_shell', gateArgs)
        const ruleAction = matchRule(permissionRules, 'run_shell', subject, roots)
        if (ruleAction === 'deny') {
          return 'Denied by a permission rule.'
        }
        const subCallId = `${callId}.shell.${++gateSeq}`
        const summary = `Subagent: ${getTool('run_shell')!.summarize(gateArgs)}`
        // An `ask` rule (any tier) must still prompt even after the per-run
        // unconfined-shell override, mirroring decideApproval: the override is consent
        // to skip the default every-command prompt, not to bypass a rule that mandates
        // one (managed/project `ask` rules are tighten-only and must never be silenced).
        if (ruleAction === 'ask' || !run.shellUnsandboxedOverride) {
          // Track + emit like any approval so re-adopt replay and cancelRun
          // (which resolves pending approvals as deny) cover this prompt too.
          run.pendingApprovals.set(subCallId, {
            name: 'run_shell',
            summary,
            args: gateArgs,
            kind: 'shell',
            sandboxed: false
          })
          emit({
            type: 'tool_approval',
            callId: subCallId,
            name: 'run_shell',
            summary,
            args: gateArgs,
            kind: 'shell',
            sandboxed: false
          })
          const decision = await waitForApproval(run, subCallId)
          run.pendingApprovals.delete(subCallId)
          const approved = applyApprovalDecision(decision, 'run_shell', gateArgs, 'shell', true)
          if (!approved) {
            emit({
              type: 'tool_result',
              callId: subCallId,
              name: 'run_shell',
              ok: false,
              output: 'Denied by the user.'
            })
            return 'Denied by the user. Do not retry this command; work around it or note it in your report.'
          }
        }
        emit({ type: 'tool_start', callId: subCallId, name: 'run_shell', args: gateArgs, kind: 'shell' })
        try {
          const output = redact(await runCommand())
          emit({ type: 'tool_result', callId: subCallId, name: 'run_shell', ok: true, output })
          return output
        } catch (e) {
          const output = redact(`Error: ${(e as Error).message}`)
          emit({ type: 'tool_result', callId: subCallId, name: 'run_shell', ok: false, output })
          return output
        }
      }

      let subInput = 0
      let subOutput = 0
      let subCacheRead = 0
      let subCacheWrite = 0
      // Nested agents' progress shares the parent dispatch's row; the arrow keeps
      // the two narrations distinguishable.
      const progressPrefix = depth > 1 ? '↳ ' : ''
      let storedId: string | undefined
      const result = await runSubAgent({
        provider,
        model,
        workspace,
        prompt: opts.prompt,
        signal: abort.signal,
        systemOverride,
        tools: allowedTools,
        // The writable tier gets the real roots and a FRESH shell session so the
        // subagent's cwd/env changes don't leak into the parent's persistent
        // shell, records its edits in THIS run's checkpoint (so the turn's
        // revert/redo covers delegated changes), and carries the per-command
        // unconfined-shell consent gate.
        ...(writable
          ? {
              writable: true,
              roots,
              checkpointRunId: runId,
              shellSession: createShellSession(workspace),
              shellOutputMaxBytes: resolveShellOutputBudget(settings),
              gateUnconfinedShell
            }
          : {}),
        explicitCacheControl: needsExplicitCacheControl(model, modelCaps),
        // The subagent's tool outputs ship to the provider from ITS transcript,
        // which never passes flushResult — scrub them with the run-scoped redactor.
        redact,
        priorMessages: resumed?.messages,
        // Progress lines carry tool-arg summaries from the subagent's own calls,
        // so they get the same secret scrub as tool results (see the flush below).
        onProgress: (message) =>
          emit({ type: 'tool_progress', callId, message: redact(`${progressPrefix}${message}`) }),
        // Store/refresh the transcript for resumability — top-level dispatches
        // only. A nested agent's report goes to its parent subagent, not to the
        // main model, so an id for it would name something the model never saw.
        ...(depth === 1
          ? {
              onTranscript: (msgs: ChatMessage[]) => {
                if (resumed) {
                  updateSubAgentMessages(subagentKey, resumed.id, msgs)
                  storedId = resumed.id
                } else {
                  storedId = rememberSubAgent(subagentKey, {
                    messages: msgs,
                    writable,
                    ...(opts.agent ? { agentName: opts.agent } : {}),
                    model,
                    ...(systemOverride ? { systemOverride } : {}),
                    ...(allowedTools ? { tools: allowedTools } : {})
                  })
                }
              }
            }
          : {}),
        // One more level of read-only fan-out below this agent, until the depth
        // floor. Nested dispatch never widens write authority.
        ...(depth < MAX_SUBAGENT_DEPTH
          ? {
              dispatchNested: (nestedPrompt: string, nestedAgent?: string, nestedModel?: string) =>
                runDispatch({
                  callId,
                  opts: { prompt: nestedPrompt, agent: nestedAgent, model: nestedModel },
                  writable: false,
                  depth: depth + 1
                })
            }
          : {}),
        onUsage: (u) => {
          subInput += u.inputTokens ?? 0
          subOutput += u.outputTokens ?? 0
          subCacheRead += u.cacheReadTokens ?? 0
          subCacheWrite += u.cacheWriteTokens ?? 0
        }
      }).finally(() => {
        // A subagent bills against its own (possibly cheaper) model; total its
        // tokens and fold them into the conversation's usage when it ends.
        // inputTokens: 0 keeps the context-size meter on the main turn (this is
        // an ephemeral subagent context), while output + cost accumulate.
        if (subInput || subOutput) {
          emit({
            type: 'usage',
            inputTokens: 0,
            outputTokens: subOutput,
            cost: turnCostUsd(
              model,
              subInput,
              subOutput,
              { readTokens: subCacheRead, writeTokens: subCacheWrite },
              modelCaps
            )
          })
        }
      })

      // Tell the model how to follow up. Only when a transcript was stored — an
      // aborted/errored run isn't resumable, and nested dispatches never are.
      if (storedId) {
        const tool = writable ? 'dispatch_writable_agent' : 'dispatch_agent'
        return `${result}\n\n[subagent ${storedId} — pass resume: "${storedId}" to ${tool} to continue this agent with its context intact]`
      }
      return result
    }

    // Shared tool-execution context. `run.policy` and `run.shellNetworkGranted` are
    // read at call time so a mid-run policy change or a network-consent decision earlier
    // in the turn takes effect. `allowNetwork` governs the shell sandbox's network
    // access; it is NO LONGER implied by full-auto — the sandbox reads the whole
    // filesystem, so blanket egress + full-auto is an exfiltration channel. Shell now
    // reaches the network only after a conscious per-run grant (the shell-network
    // consent, or "Allow for run" on a shell command). See needsShellNetworkConsent.
    const makeToolContext = (
      callId: string,
      attachImage: (i: ImageAttachment) => void,
      attachDocument: (d: DocumentAttachment) => void
    ): ToolContext => ({
      workspace,
      roots,
      allowNetwork: run.shellNetworkGranted && !egressUnavailable,
      egressProxy,
      signal: abort.signal,
      ...(conversationId ? { conversationId } : {}),
      shellSession,
      shellOutputMaxBytes: resolveShellOutputBudget(settings),
      ghExec,
      getSecret: getKey,
      collectSecrets: () => knownSecrets,
      searchProvider: settings.searchProvider,
      // Ask the user a structured question and block until they answer. The
      // resolver is registered before the event is emitted so a fast reply can't
      // race ahead of it; cancelRun resolves any still-pending question.
      askUser: (q) =>
        new Promise<string>((resolve) => {
          run.questions.set(callId, resolve)
          run.pendingQuestions.set(callId, {
            question: q.question,
            options: q.options,
            ...(q.multiSelect ? { multiSelect: true } : {})
          })
          emit({
            type: 'tool_question',
            callId,
            question: q.question,
            options: q.options,
            ...(q.multiSelect ? { multiSelect: true } : {})
          })
        }),
      // Route an MCP server's mid-call elicitation to this run's user and block
      // until they answer. Keyed by a fresh elicitId (one call can elicit
      // repeatedly); registered before emitting, like askUser; cancelRun resolves
      // any still-pending elicitation as a cancel so the server gets its reply.
      elicitMcp: (req) =>
        new Promise<ElicitationResult>((resolve) => {
          const elicitId = `${callId}:e${++run.elicitSeq}`
          run.elicitations.set(elicitId, resolve)
          run.pendingElicitations.set(elicitId, { callId, ...req })
          emit({
            type: 'elicitation',
            callId,
            elicitId,
            serverId: req.serverId,
            message: req.message,
            fields: req.fields
          })
        }),
      // Present a finished plan and block until the user decides. Like askUser, the
      // resolver is registered before the event is emitted so a fast decision can't
      // race ahead of it; cancelRun resolves any still-pending plan as a reject.
      // Accepting flips run.policy here so the next tool call this turn isn't blocked.
      presentPlan: (plan) =>
        new Promise<string>((resolve) => {
          run.planDecisions.set(callId, (decision) => resolve(planDecisionResult(run, decision)))
          run.pendingPlans.set(callId, plan)
          emit({ type: 'plan_ready', callId, plan })
        }),
      // Both tiers route through runDispatch (hoisted above), which handles the
      // model override, resume, live progress, nesting, per-model billing, the
      // checkpoint pass-through, and the unconfined-shell consent gate.
      // Reaching the writable path means the dispatch_writable_agent call was
      // already approved (kind:'write'), so the subagent works autonomously
      // within the project sandbox.
      dispatchSubAgent: (opts) => runDispatch({ callId, opts, writable: false, depth: 1 }),
      dispatchWritableSubAgent: (opts) => runDispatch({ callId, opts, writable: true, depth: 1 }),
      dispatchReview: (base, paths, effort, model) => {
        // An explicit model runs the whole review — dimension reviewers and
        // skeptical verifiers alike — on that (usually cheaper) sibling, billed
        // at ITS rates. Validated like a dispatch override: fail loudly with the
        // configured ids so the model can correct itself.
        let reviewModel = req.model
        let reviewCaps = selectedModelCaps
        if (model && model !== req.model) {
          const available = providerConfig.models.map((m) => m.id)
          if (!available.includes(model)) {
            return Promise.resolve(
              available.length
                ? `Unknown model "${model}" for provider ${req.providerId}. Configured models: ${available.join(', ')}. Omit model to use ${req.model}.`
                : `Model overrides aren't available: provider ${req.providerId} lists no models. Omit model to use ${req.model}.`
            )
          }
          reviewModel = model
          reviewCaps = providerConfig.models.find((m2) => m2.id === model)?.caps
        }
        // The review's nested subagent calls bill against the review's model;
        // total their tokens and fold them into the conversation's usage when it
        // ends. inputTokens: 0 keeps the context-size meter on the main turn
        // (these are ephemeral subagent contexts), while output + cost accumulate.
        let reviewInput = 0
        let reviewOutput = 0
        let reviewCacheRead = 0
        let reviewCacheWrite = 0
        return reviewWorkspaceChanges({
          provider,
          model: reviewModel,
          workspace,
          base,
          paths,
          effort,
          explicitCacheControl: needsExplicitCacheControl(reviewModel, reviewCaps),
          // The reviewers are nested subagents whose transcripts (and diff-bearing
          // prompts) ship to the provider without passing flushResult — scrub them
          // with the same run-scoped redactor.
          redact,
          onProgress: (message) => emit({ type: 'tool_progress', callId, message }),
          onSubAgent: (ev) =>
            emit({ type: 'subagent', parentCallId: callId, id: ev.id, label: ev.label, status: ev.status }),
          onUsage: (u) => {
            reviewInput += u.inputTokens ?? 0
            reviewOutput += u.outputTokens ?? 0
            reviewCacheRead += u.cacheReadTokens ?? 0
            reviewCacheWrite += u.cacheWriteTokens ?? 0
          },
          signal: abort.signal
        }).finally(() => {
          if (reviewInput || reviewOutput) {
            emit({
              type: 'usage',
              inputTokens: 0,
              outputTokens: reviewOutput,
              cost: turnCostUsd(
                reviewModel,
                reviewInput,
                reviewOutput,
                { readTokens: reviewCacheRead, writeTokens: reviewCacheWrite },
                reviewCaps
              )
            })
          }
        })
      },
      attachImage,
      attachDocument,
      // Undefined on the CLI (no backend wired) so the view_localhost guard reads
      // cleanly; the tool is already filtered out of the schema set above.
      captureLocalhost: localhostCaptureAvailable ? captureLocalhost : undefined,
      // The recall tool reads the full, un-compacted log. Return a shallow copy so a
      // tool can't reassign the loop's `messages` array through this handle (push/splice/
      // reorder). The ChatMessage objects are shared by reference, so callers must treat
      // them as read-only; recall_history only reads, so no deep clone is warranted.
      getHistory: () => [...messages],
      // Back the `skill` tool: resolve a skill name to its full instructions (or a
      // note listing what's available) from the skills loaded for this run.
      useSkill: (name) => resolveSkillInstructions(workspace, skills, name),
      // Back `spawn_session` when a backend is wired (desktop only). Fills in the
      // run-scoped fields the tool doesn't take: provider/model, the workspace, and
      // `run.policy` (read live) so the spawned session inherits the parent's CURRENT
      // approval policy — never more permissive.
      ...(spawnAvailable
        ? {
            spawnSession: (input: {
              title?: string
              prompt: string
              worktree?: { branch: string; base?: string }
            }) =>
              engineSpawnSession({
                ...input,
                providerId: req.providerId,
                model: req.model,
                approvalPolicy: run.policy,
                workspace,
                ...(conversationId ? { parentConversationId: conversationId } : {})
              })
          }
        : {}),
      // Back the schedule tools when a scheduler backend is wired. Create fills
      // in the run-scoped fields the tool doesn't take — provider/model, the
      // workspace, and `run.policy` (read live) so scheduled sessions inherit the
      // creating chat's CURRENT approval policy, never a more permissive one.
      ...(schedulerAvailable
        ? {
            scheduler: {
              create: (input: { name: string; spec: string; prompt: string }) =>
                scheduleCreate({
                  ...input,
                  providerId: req.providerId,
                  model: req.model,
                  approvalPolicy: run.policy,
                  workspace
                }),
              list: () => scheduleList(),
              cancel: (id: string) => scheduleCancel(id)
            }
          }
        : {})
    })

    /** True if a call is a read-only tool with no gating — safe to run concurrently. */
    const isParallelCall = (call: ToolCall): boolean => {
      // ask_user blocks on a human; keep it sequential so its prompt never appears
      // in the middle of a concurrent read batch.
      if (call.name === ASK_USER_NAME) return false
      const tool = lookupTool(call.name)
      if (!tool) return false
      const ruleAction = matchRule(
        permissionRules,
        call.name,
        permissionSubject(call.name, call.arguments),
        roots
      )
      return isParallelizableRead(tool.kind, ruleAction, hasMatchingHook(call.name))
    }

    // Context compaction state. `messages` is always the full, persisted log; what
    // we actually send the provider is `summaryMsgs` (a synthetic summary of the
    // turns before `cut`) followed by `messages.slice(cut)`. The threshold scales
    // to the model's context window (host-listed caps first, then the family
    // heuristic); an explicit setting overrides it, and the fixed default covers
    // models whose window is unknown.
    const threshold = resolveCompactionThreshold(
      settings.compactionThreshold,
      resolveContextWindow(req.model, selectedModelCaps)
    )
    let cut = 0
    let summaryMsgs: ChatMessage[] = []
    let lastInputTokens = 0
    // The boundary the pinned working-memory block is spliced in front of: the user
    // turn this run is answering. Frozen here, after the intake repair and before the
    // loop appends anything, because the loop pushes synthetic `user` messages of its
    // own mid-run (a stall nudge, a Stop-hook continuation, verification feedback).
    // Re-deriving the boundary per iteration would let any of those drag the block
    // down the window and re-churn the prefix cache this placement exists to protect.
    const pinnedAt = lastUserTurnIndex(messages)
    // Resume from compaction state persisted by an earlier run, so a follow-up
    // turn extends the existing summary instead of re-summarizing the whole head
    // again every turn (each run previously started from cut 0). Validated against
    // the current log — a rewritten log (`/compact`, import) or a cut shifted by
    // the intake repair above fails the boundary check and re-summarizes fresh.
    // Guarded like every store touch from the loop: persistence must never kill a run.
    if (conversationId) {
      try {
        const persisted = getConversation(conversationId)?.compaction
        if (persisted && isValidCompactionState(persisted, messages)) {
          cut = persisted.cut
          summaryMsgs = buildSummaryMessages(persisted.summary)
        }
      } catch {
        // Store unavailable (unwired host) — run with in-memory compaction only.
      }
    }

    // Run-scoped content-addressed cache for repeated read-only tool calls. Created
    // here so it lives exactly as long as this run — an identical `read_file`/`glob`/
    // `search_files`/etc. later in the run is served from memory instead of re-hitting
    // the filesystem, cutting tokens/latency/cost on the re-read pattern. It is
    // dropped when startRun returns (GC'd with the closure), so it never leaks across
    // runs. Correctness is preserved by invalidating on every mutation: a write drops
    // the entries depending on the touched path(s); a shell call clears the cache
    // wholesale (a command can change any file). Writers the loop never sees — the
    // user editing in their editor, a git checkout — are caught instead by the stat
    // revalidation every hit performs. See readCache.ts.
    const readCache = new ReadCache({ stat: statPath })
    // Map a tool's `path` argument to a canonical absolute path the way the file
    // tools do, so cache dependencies and write-invalidation keys line up exactly.
    const resolvePath = (rel: string): string => resolveInRoots(roots, rel)
    // Files an apply_patch touches, for path-precise cache invalidation. Derived
    // from the checkpoint target list so the two stay in lockstep.
    const patchPaths = (patch: string): string[] =>
      writeTargets('apply_patch', { patch }).map((t) => t.path)
    // Invalidate cached reads after a mutating tool call. A write invalidates the
    // paths it touched (or everything, if those paths can't be determined); shell —
    // and anything else non-read that changes state — clears the cache wholesale.
    const invalidateForMutation = (name: string, kind: ToolKind, args: Record<string, unknown>): void => {
      if (kind === 'write') {
        const touched = writePaths(name, args, resolvePath, patchPaths)
        if (writeTouchesUnknownPaths(touched)) readCache.invalidateAll()
        else readCache.invalidatePaths(touched)
      } else {
        // shell/network/mcp: a command or side-effect can change arbitrary files.
        readCache.invalidateAll()
      }
    }

    // Adaptive turn budget. The hard iteration cap is still enforced, but as the
    // run nears it (or crosses a cumulative-cost ceiling) we inject a one-time
    // "landing" reminder so the model wraps up cleanly rather than being cut off
    // mid-edit. Cost accumulates from each turn's `turnCostUsd` (the same figure
    // the 'usage' emit reports).
    const budget = resolveBudgetLimits({
      maxIterations: settings.maxIterations,
      costCeilingUsd: settings.costCeilingUsd
    })
    let cumulativeCostUsd = 0
    let landed = false

    // Stall / loop detection. Watches the per-iteration tool pattern for
    // unproductive cycling (same call repeated, or same error repeated) and asks
    // us to nudge once, then stop if it persists. Disabled when the setting is off
    // (an inert detector is simplest, but we just skip observing so no work is done).
    const stallEnabled = settings.stallDetection !== false
    const stallDetector = new StallDetector(
      resolveStallThresholds({
        repeatCallLimit: settings.stallRepeatCallLimit,
        repeatErrorLimit: settings.stallRepeatErrorLimit
      })
    )

    // End-of-run verification gate (opt-in). Tracks whether this run modified any
    // files (so we don't verify a read-only turn) and how many verification passes
    // have already run (bounded self-correction). A run_shell edit can also change
    // files, but keying off write-kind tool calls is the reliable, cheap signal and
    // matches the checkpoint snapshot logic already in the loop.
    let filesModified = false
    let verifyPassesRun = 0
    const verifyMaxPasses = resolveVerifyMaxPasses(settings.verifyMaxPasses)

    // Summarize messages[cut..newCut), fold the result into the synthetic summary,
    // and advance `cut`. Shared by the proactive (pre-send, threshold-driven) path
    // and the reactive (post-overflow) recovery path.
    const compactTo = async (newCut: number): Promise<'ok' | 'aborted' | 'failed'> => {
      if (newCut <= cut) return 'failed'
      // PreCompact: let a hook persist state or inject a note before older turns are
      // summarized away. Any injected context is folded into the material being
      // summarized so it carries into the summary. Best-effort and non-blocking —
      // compaction must proceed to keep the turn within the context window.
      const preCompact = await runHooks(
        hooks,
        'PreCompact',
        { tool: 'PreCompact', input: {} },
        workspace,
        abort.signal
      )
      emitHookNotice(preCompact)
      const toSummarize = messages.slice(cut, newCut)
      const material: ChatMessage[] = preCompact.additionalContext
        ? [{ role: 'user', content: redact(preCompact.additionalContext) }, ...toSummarize]
        : toSummarize
      try {
        const summary = await summarize(
          provider,
          req.model,
          buildSummaryRequestMessages(summaryMsgs, material),
          abort.signal
        )
        if (!summary) return 'failed'
        // Messages folded into the summary *this round* (a count, which is what the
        // renderer shows) — not the absolute tail-start index.
        const compactedNow = newCut - cut
        summaryMsgs = buildSummaryMessages(summary)
        cut = newCut
        lastInputTokens = 0
        // Persist so the next run resumes from this summary instead of paying a
        // fresh summarization of the same head. Guarded: a store failure only
        // costs that resume, never the in-flight compaction.
        if (conversationId) {
          try {
            setCompaction(conversationId, { cut: newCut, summary })
          } catch {
            // Store unavailable — the run continues with in-memory state.
          }
        }
        emit({ type: 'compaction', summarized: compactedNow })
        return 'ok'
      } catch {
        return abort.signal.aborted ? 'aborted' : 'failed'
      }
    }

    // Assemble the window actually sent to the provider from the persisted log. Three
    // durable-context transforms layer on top of the summary + kept tail, and NONE of
    // them mutate `messages` — only this ephemeral copy:
    //   1. summaryMsgs stands in for the compacted head (turns before `cut`).
    //   2. Stale + large tool results in the kept tail are replaced by compact stubs
    //      (recoverable via recall_history) — surgical, unlike whole-turn compaction.
    //   3. Pinned working memory (original task, live todo list, files in play) is
    //      spliced in so it survives compaction/eviction losslessly.
    //
    // Assembly is prompt-cache-aware, which dictates the order above. Caching matches
    // a *prefix*, so the window must stay append-only across a turn's iterations: each
    // request extends the last one, and only the new tail is billed at the full input
    // rate. The pinned block is the one volatile part (a `read_file` reorders "files in
    // play", a `todo_write` rewrites the todos), so it rides at the END of the stable
    // prefix, immediately before the final user turn, instead of at the head where its
    // churn invalidated the cache from message zero on every tool call. Deriving it
    // from the head (the turns before that boundary) freezes it for the turn's
    // duration, which is what keeps the prefix identical iteration to iteration. See
    // workingMemory.ts for the full argument.
    //
    // The final invariant, enforced at the one boundary every request passes through:
    // the provider must never receive a `tool_use` without its `tool_result`
    // immediately after. The transforms above preserve pairing today (the splice lands
    // on a user-turn boundary, never between a call and its result), and the intake
    // repair keeps the persisted log balanced — but any tool that blocks on the user
    // (present_plan, ask_user) or an approval can be interrupted mid-call, and future
    // transforms/hooks could slip. Normalizing here makes every request self-heal
    // regardless of how its messages were assembled. It's a no-op on a balanced window.
    const buildWindow = (): ChatMessage[] => {
      const tail = evictStaleToolResults(messages.slice(cut))
      // The block is derived from, and sits at the end of, everything before the
      // current turn: the frozen pre-run head, or whatever compaction has since folded
      // away, whichever reaches further. So it stays byte-identical between
      // compactions — and refreshing it AT one is free, because advancing the cut
      // rewrites the head of the window and invalidates the cache regardless.
      const headEnd = Math.max(pinnedAt, cut)
      const pinned = headEnd > 0 ? buildPinnedMessages(messages.slice(0, headEnd)) : []
      // Where the boundary falls inside the kept tail. Clamped: once the cut advances
      // past the boundary the whole head is summary, and the block leads the tail.
      const at = Math.min(Math.max(pinnedAt - cut, 0), tail.length)
      return repairDanglingToolResults([
        ...summaryMsgs,
        ...tail.slice(0, at),
        ...pinned,
        ...tail.slice(at)
      ])
    }

    // SessionStart: once, before the first turn. A hook can inject extra context,
    // which we append to the system prompt for the whole run.
    const sessionStart = await runHooks(
      hooks,
      'SessionStart',
      { tool: 'SessionStart', input: {} },
      workspace,
      abort.signal
    )
    emitHookNotice(sessionStart)
    if (sessionStart.additionalContext) {
      system += `\n\n${redact(sessionStart.additionalContext)}`
    }

    // UserPromptSubmit: fires on the message that started this run. A hook can
    // block the prompt outright, or inject context appended to the user's message.
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const promptText = typeof lastUser?.content === 'string' ? lastUser.content : ''
    const promptSubmit = await runHooks(
      hooks,
      'UserPromptSubmit',
      { tool: 'UserPromptSubmit', input: {}, prompt: promptText },
      workspace,
      abort.signal
    )
    // Before the block check: a hook that blocks the prompt AND posts a note still
    // gets its note shown.
    emitHookNotice(promptSubmit)
    if (promptSubmit.blocked) {
      emit({
        type: 'error',
        message: `Blocked by a UserPromptSubmit hook:\n${promptSubmit.message || '(no output)'}`
      })
      return
    }
    if (promptSubmit.additionalContext && lastUser && typeof lastUser.content === 'string') {
      lastUser.content += `\n\n${redact(promptSubmit.additionalContext)}`
      persist(messages)
    }

    // How many times a Stop hook has forced the turn to continue, bounded so a
    // misbehaving hook can't loop forever.
    let stopContinuations = 0

    for (let iter = 0; iter < budget.maxIterations; iter++) {
      if (abort.signal.aborted) {
        emit({ type: 'done', stopReason: 'aborted' })
        return
      }

      // Landing reminder: once the run is within a small margin of the iteration
      // cap, or has crossed the cumulative-cost ceiling, push a single guidance
      // message so the model wraps up cleanly instead of being cut off. It's a
      // real user-role message so it renders sanely in the transcript and folds
      // into future compaction like any other turn (per the loop's persistence
      // discipline). One-time, guarded by `landed`.
      {
        const decision = shouldLand({ iteration: iter, costUsd: cumulativeCostUsd, alreadyLanded: landed }, budget)
        if (decision.land) {
          landed = true
          messages.push({
            role: 'user',
            content: `${SYSTEM_NOTE_PREFIX} ${landingReminder(decision.iterationsLeft, decision.trigger)}`
          })
          persist(messages)
        }
      }

      // The tool schemas for this turn. Recomputed each iteration because lazy MCP
      // loading grows the set as find_tools reveals tools. They ride along on every
      // request but aren't part of the message window, so fold their size into the
      // compaction estimate; real provider usage supersedes it once known.
      const tools = buildTools()
      const toolTokens = Math.ceil(JSON.stringify(tools).length / 4)

      // Compact older turns before they overflow the model's context window. The
      // visible transcript (persisted `messages`) is untouched — only the window
      // sent to the provider shrinks.
      if (threshold > 0) {
        const windowNow = buildWindow()
        const size = Math.max(estimateTokens(system, windowNow) + toolTokens, lastInputTokens)
        if (size > threshold) {
          const newCut = findCompactionCut(messages, cut, KEEP_RECENT_USER_TURNS)
          // Summarization failure is non-fatal: keep going with the full window —
          // the turn may still fit, or the provider error path will recover below.
          if (newCut > cut && (await compactTo(newCut)) === 'aborted') {
            emit({ type: 'done', stopReason: 'aborted' })
            return
          }
        }
      }

      let sendMessages = buildWindow()

      // Re-read the thinking controls fresh each model turn rather than using the
      // run-start `settings` snapshot, so changing the reasoning level mid-run —
      // via the dropdown (which persists through saveSettings) or settings.json —
      // takes effect on the next turn. This mirrors the live approval policy; the
      // natural granularity is per-turn because reasoning is a per-request param.
      // Everything else stays snapshotted so a run's behavior is otherwise stable.
      const { reasoningEffort, reasoningSummary, verbosity } = getSettings()

      let assistantText = ''
      let toolCalls: ToolCall[] = []
      let stopReason: StopReason = 'end_turn'
      let turnInput = 0
      let turnOutput = 0
      let turnCacheRead = 0
      let turnCacheWrite = 0
      let turnReasoning: ReasoningBlock[] = []

      // Stream the model turn, retrying transient failures with backoff — but only
      // when nothing has been emitted yet this attempt, so retried output can't
      // duplicate what the user already saw.
      streaming: for (let attempt = 0; ; attempt++) {
        assistantText = ''
        toolCalls = []
        stopReason = 'end_turn'
        turnInput = 0
        turnOutput = 0
        turnCacheRead = 0
        turnCacheWrite = 0
        turnReasoning = []
        let emitted = false
        try {
          for await (const ev of provider.streamChat({
            model: req.model,
            system,
            messages: sendMessages,
            tools,
            reasoningEffort,
            reasoningCapable,
            reasoningSummary,
            verbosity,
            explicitCacheControl,
            signal: abort.signal
          })) {
            if (ev.type === 'text') {
              emitted = true
              assistantText += ev.text
              emit({ type: 'text', delta: ev.text })
            } else if (ev.type === 'reasoning') {
              emitted = true
              emit({ type: 'reasoning', delta: ev.text })
            } else if (ev.type === 'tool_call') {
              emitted = true
              toolCalls.push(ev.call)
            } else if (ev.type === 'done') {
              stopReason = ev.stopReason
              if (ev.usage?.inputTokens) {
                lastInputTokens = ev.usage.inputTokens
                turnInput = ev.usage.inputTokens
              }
              if (ev.usage?.outputTokens) turnOutput = ev.usage.outputTokens
              turnCacheRead = ev.usage?.cacheReadTokens ?? 0
              turnCacheWrite = ev.usage?.cacheWriteTokens ?? 0
              if (ev.reasoning?.length) turnReasoning = ev.reasoning
            } else if (ev.type === 'error') {
              throw new Error(ev.message)
            }
          }
          break streaming // turn completed successfully
        } catch (e) {
          if (abort.signal.aborted) {
            emit({ type: 'done', stopReason: 'aborted' })
            return
          }
          // Context overflow: the request is simply too big for the window. Retrying
          // it unchanged is futile and failing the run is worse than shrinking it, so
          // (when nothing has streamed) force a compaction step and retry with fewer
          // verbatim turns. Independent of the user's compaction threshold — an
          // unsendable request must shrink regardless.
          if (!emitted && isContextOverflowError(e)) {
            const forcedCut = findForcedCompactionCut(messages, cut)
            const outcome = forcedCut > cut ? await compactTo(forcedCut) : 'failed'
            if (outcome === 'aborted') {
              emit({ type: 'done', stopReason: 'aborted' })
              return
            }
            if (outcome === 'ok') {
              sendMessages = buildWindow()
              attempt = -1 // reset the transient-retry budget for the smaller request
              continue streaming
            }
            // Even the latest turn alone won't fit — no compaction can save it.
            emit({
              type: 'error',
              message:
                "The conversation is too large for this model's context window, even after " +
                'compacting older messages. Start a new conversation, remove large attachments, ' +
                'or switch to a model with a larger context window.'
            })
            return
          }
          // The model can't do tool calling, which the agent requires. The raw API
          // string ("<model> does not support tools") is opaque — point the user at
          // a tool-capable model instead. Fatal, so don't retry.
          if (isToolsUnsupportedError(e)) {
            emit({
              type: 'error',
              message:
                `The selected model "${req.model}" doesn't support tool calling, which this agent ` +
                'requires. Pick a tool-capable model (e.g. qwen2.5-coder, llama3.1, mistral-nemo).'
            })
            return
          }
          // Can't safely retry once output has streamed, or if it's not transient.
          if (emitted || attempt >= MAX_STREAM_RETRIES || !isRetryableError(e)) {
            emit({ type: 'error', message: (e as Error).message })
            return
          }
          emit({
            type: 'retry',
            attempt: attempt + 1,
            max: MAX_STREAM_RETRIES,
            message: (e as Error).message
          })
          await abortableSleep(backoffDelayMs(attempt + 1), abort.signal)
          if (abort.signal.aborted) {
            emit({ type: 'done', stopReason: 'aborted' })
            return
          }
        }
      }

      // Some providers (notably local OpenAI-compatible servers) don't report token
      // usage. Fall back to an estimate of what we actually sent so the context-size
      // readout still reflects the current window instead of sitting at zero.
      if (!turnInput) {
        turnInput = estimateTokens(system, sendMessages) + toolTokens
        lastInputTokens = turnInput
      }

      if (turnInput || turnOutput) {
        const turnCost = turnCostUsd(
          req.model,
          turnInput,
          turnOutput,
          { readTokens: turnCacheRead, writeTokens: turnCacheWrite },
          selectedModelCaps
        )
        // Accumulate for the adaptive-budget cost ceiling (the landing trigger).
        cumulativeCostUsd += turnCost
        emit({
          type: 'usage',
          inputTokens: turnInput,
          outputTokens: turnOutput,
          cost: turnCost
        })
      }

      messages.push({
        role: 'assistant',
        content: assistantText,
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(turnReasoning.length ? { reasoning: turnReasoning } : {})
      })
      persist(messages)

      if (toolCalls.length === 0) {
        // The model's reply was cut off at its output limit — say so rather than
        // presenting a truncated answer as complete. A truncated reply isn't a
        // clean stop, so neither the Stop hooks nor the verification gate run for it.
        if (stopReason === 'max_tokens') {
          emit({ type: 'limit', reason: 'max-output' })
          emit({ type: 'done', stopReason })
          return
        }

        // Stop hooks run when the agent would naturally end its turn. A blocking
        // hook forces another turn — its reason is fed back as a user message —
        // bounded by MAX_STOP_CONTINUATIONS so a hook can't spin forever. Runs
        // before the verification gate: if a hook keeps the turn alive, the turn
        // isn't really ending yet, so there's nothing to verify.
        if (stopReason === 'end_turn' && stopContinuations < MAX_STOP_CONTINUATIONS) {
          const stop = await runHooks(
            hooks,
            'Stop',
            { tool: 'Stop', input: {} },
            workspace,
            abort.signal
          )
          emitHookNotice(stop)
          if (abort.signal.aborted) {
            emit({ type: 'done', stopReason: 'aborted' })
            return
          }
          if (stop.blocked) {
            stopContinuations++
            messages.push({
              role: 'user',
              content: redact(stop.message) || 'A Stop hook requested that you keep working.'
            })
            persist(messages)
            continue
          }
        }

        // End-of-run verification gate (opt-in): if the model stopped naturally
        // after modifying files and the user configured a verification command,
        // run it. On failure, feed the output back and continue the loop for a
        // BOUNDED number of extra passes so the model can self-correct; once the
        // pass budget is spent we accept done regardless (never an infinite loop).
        if (
          stopReason === 'end_turn' &&
          shouldVerify({
            enabled: settings.verifyOnStop === true,
            command: settings.verifyCommand,
            filesModified,
            passesRun: verifyPassesRun,
            maxPasses: verifyMaxPasses,
            // Live policy: Plan mode must run nothing, so a mid-run toggle into
            // Plan suppresses the verify shell command even after a prior edit.
            policy: run.policy
          })
        ) {
          verifyPassesRun += 1
          const result = await runVerification({
            command: settings.verifyCommand!,
            workspace,
            roots,
            // The verify command is USER-authored (a settings field the agent can't
            // change), not agent-authored, so it isn't part of the shell-exfiltration
            // vector the shell-network consent guards. Keep its prior network behavior
            // (full-auto, or an explicit shell-network grant) so a verify command that
            // hits the network isn't silently starved in full-auto.
            allowNetwork:
              (run.policy === 'full-auto' || run.shellNetworkGranted) && !egressUnavailable,
            // The user-authored verify command still egresses through the same
            // per-domain allowlist — the policy is about destinations, not authorship.
            egressProxy,
            signal: abort.signal,
            maxBytes: resolveShellOutputBudget(settings)
          })
          if (result.aborted || abort.signal.aborted) {
            emit({ type: 'done', stopReason: 'aborted' })
            return
          }
          emit({ type: 'verification', passed: result.passed })
          if (!result.passed) {
            // Push the failure feedback as a real user-role message so the model
            // sees it next turn and the transcript renders it sanely; then loop.
            messages.push({
              role: 'user',
              content: verifyFailureMessage(settings.verifyCommand!, result.output)
            })
            persist(messages)
            continue
          }
        }

        emit({ type: 'done', stopReason })
        return
      }

      // Stall-detection accumulators for this iteration: error signatures from
      // failed tool results. Both the parallel and sequential result paths populate
      // this; we feed it to the detector once the iteration's tool calls have all
      // resolved. `observeStall` reacts to the detector's decision (nudge once, then
      // stop if it persists) and returns true when the run was ended so the caller returns.
      const iterErrors: string[] = []
      const observeStall = (): boolean => {
        if (!stallEnabled) return false
        const action = stallDetector.observe({
          calls: toolCalls,
          errors: iterErrors
        })
        if (action.kind === 'nudge') {
          messages.push({ role: 'user', content: `${SYSTEM_NOTE_PREFIX} ${action.message}` })
          persist(messages)
        } else if (action.kind === 'stop') {
          // Persisted past the corrective nudge — end the run cleanly with a
          // dedicated limit reason rather than looping until the budget is spent.
          emit({ type: 'limit', reason: 'stalled' })
          emit({ type: 'done', stopReason: 'end_turn' })
          return true
        }
        return false
      }

      // ---------------------------------------------------------------------
      // Tool dispatch. A turn can mix parallelizable reads with encumbered calls
      // (writes/shell/network/MCP/gated/hooked/ask_user). We run the CONTIGUOUS
      // LEADING run of unencumbered reads CONCURRENTLY, then the rest — the first
      // encumbered call and everything after it (including any later reads) —
      // SEQUENTIALLY in its original relative order. Because the parallel group is
      // entirely before the sequential group in original order, results are flushed
      // (tool_result + appended to the log) INLINE as each call finalizes, still in
      // ORIGINAL call order, so the transcript and the model's window match a
      // fully-sequential run — and a read that follows a write in the same turn sees
      // the write. The all-reads case is the partition where `sequential` is empty;
      // a turn led by an encumbered call has `parallel` empty (fully sequential).
      // ---------------------------------------------------------------------

      // Per-call outcome, ready to emit + append.
      interface CallResult {
        call: ToolCall
        output: string
        ok: boolean
        images: ImageAttachment[]
        documents: DocumentAttachment[]
      }

      // Flush one finalized call: emit tool_result, fire the onToolResult plugin
      // event, and append the tool message — so each tool_use is answered exactly
      // once and the persisted log stays provider-valid (role alternation, matched
      // toolCallId pairing). Called INLINE the moment a call finalizes (parallel
      // group in original order right after Promise.all; sequential group one at a
      // time) so a mid-turn abort never discards an already-completed real result:
      // whatever has been appended persists, and only not-yet-run calls get the
      // interrupted placeholder from the finally block's repair pass.
      const flushResult = async (r: CallResult): Promise<void> => {
        // Strip secrets once, here at the single choke point every tool result passes
        // through, so the redacted text is what fans out to all three sinks below (UI
        // event, plugin event, model/transcript message) — none see the plaintext.
        const output = redact(r.output)
        emit({
          type: 'tool_result',
          callId: r.call.id,
          name: r.call.name,
          ok: r.ok,
          output,
          ...(r.images.length ? { images: r.images } : {})
        })
        await plugins.emit('onToolResult', {
          tool: r.call.name,
          input: r.call.arguments,
          output,
          ok: r.ok
        })
        messages.push({
          role: 'tool',
          content: output,
          toolCallId: r.call.id,
          toolName: r.call.name,
          ...(r.images.length ? { images: r.images } : {}),
          ...(r.documents.length ? { documents: r.documents } : {})
        })
        // Feed the stall/verify accumulators as each call finalizes — inline flush
        // runs in ORIGINAL call order (parallel group in order, then each
        // sequential call), so this is the same call-order collection the detector
        // expects. Record failures (raw output — errorSignature normalization
        // happens inside the detector) for repeated-error tracking, and note any
        // successful workspace-mutating (write/shell) call so a run that's actually
        // editing/running things doesn't count as "no progress". The verification
        // gate is armed more narrowly — only an actual file write (kind 'write')
        // should trigger it, so a read-only shell command (ls/git log) never queues
        // a verify pass.
        const kind = lookupTool(r.call.name)?.kind
        if (!r.ok) iterErrors.push(r.output)
        if (r.ok && kind === 'write') filesModified = true
        // Persist after each append so a mid-turn abort return (which skips the
        // trailing onMessages) still leaves completed results in the saved log.
        persist(messages)
      }

      // Validate a call's arguments against its declared schema BEFORE any
      // dispatch. On a mismatch we short-circuit to a model-friendly repair
      // result (ok:false) instead of executing — the model self-corrects next
      // turn. Returns the repair CallResult, or null when the args are acceptable
      // (or the tool is unknown, which the caller reports separately). Applied in
      // both the parallel and the sequential path.
      const validationFailure = (call: ToolCall): CallResult | null => {
        const tool = lookupTool(call.name)
        if (!tool) return null
        const issues = validateToolArgs(call.arguments, tool.schema.parameters)
        if (issues.length === 0) return null
        return {
          call,
          output: validationError(call.name, tool.schema.parameters, issues),
          ok: false,
          images: [],
          documents: []
        }
      }

      // Coerce obvious argument-shape slips toward each tool's declared schema BEFORE
      // validating or dispatching — most commonly a stringified array/object, or a
      // single value where an array is declared (e.g. present_plan's `files` passed as
      // a string). Mutating `call.arguments` in place makes validation, the tool_start
      // event, execution, and the persisted log all agree on the fixed shape.
      for (const call of toolCalls) {
        const tool = lookupTool(call.name)
        if (tool) call.arguments = coerceToolArgs(call.arguments, tool.schema.parameters)
      }

      // Partition this turn's calls into the CONTIGUOUS LEADING run of unencumbered
      // reads and the sequential rest (the first encumbered call and everything
      // after it, including later reads). Because the parallel group is entirely
      // before the sequential group in original order, we can flush each group's
      // results as soon as they finalize and still keep the model-visible order.
      const { parallel, sequential } = partitionCalls(toolCalls, isParallelCall)

      // --- Parallel group: leading unencumbered reads, all dispatched at once. --
      // These need no approval, plan check, hooks, or checkpoint, so there's no
      // ordering constraint between them. Validate each ONCE up front (reused for
      // both the tool_start decision and the execute map), emit tool_start for the
      // ones that actually run, then dispatch via Promise.all and flush the results
      // in original call order.
      const parallelValidation = parallel.map(({ call }) => validationFailure(call))
      for (let p = 0; p < parallel.length; p++) {
        if (parallelValidation[p]) continue // tool_start intentionally not emitted for a refused call
        const { call } = parallel[p]
        emit({
          type: 'tool_start',
          callId: call.id,
          name: call.name,
          args: call.arguments,
          kind: lookupTool(call.name)?.kind
        })
        await plugins.emit('onToolStart', { tool: call.name, input: call.arguments })
      }
      const parallelResults = await Promise.all(
        parallel.map(async ({ call }, p): Promise<CallResult> => {
          const invalid = parallelValidation[p]
          if (invalid) return invalid
          // Serve an identical repeat from the run cache. A parallel call is always
          // hook-free (isParallelCall excludes hooked tools), but not every read is
          // cacheable — only the pure, on-disk-deterministic ones (isCacheableRead).
          // A stateful read like read_shell_output runs here too and must NOT cache.
          const cacheable = isCacheableRead(call.name, lookupTool(call.name)!.kind)
          const cached = cacheable ? await readCache.get(call.name, call.arguments) : undefined
          if (cached) {
            return {
              call,
              output: cached.output,
              ok: cached.ok,
              images: cached.images,
              documents: cached.documents
            }
          }
          const images: ImageAttachment[] = []
          const documents: DocumentAttachment[] = []
          let output: string
          let ok = true
          try {
            output = await lookupTool(call.name)!.execute(
              call.arguments,
              makeToolContext(
                call.id,
                (i) => images.push(i),
                (d) => documents.push(d)
              )
            )
          } catch (e) {
            output = `Error: ${(e as Error).message}`
            ok = false
          }
          if (cacheable) {
            await readCache.set(
              call.name,
              call.arguments,
              { output, ok, images, documents },
              readDeps(call.name, call.arguments, resolvePath)
            )
          }
          return { call, output, ok, images, documents }
        })
      )
      for (const result of parallelResults) await flushResult(result)

      // --- Sequential group: the first encumbered call and everything after it,
      // one call at a time. -----------------------------------------------------
      // Preserves the original relative order and every existing semantic:
      // unknown-tool, deny rule, plan block, approval prompts, "Allow for run"/rule
      // persistence, Pre/PostToolUse hooks, write checkpoints, format/diagnostics-
      // on-save, and per-call abort checks. Each outcome is flushed INLINE the
      // moment it finalizes, so an abort partway through this loop leaves the
      // already-completed real results in the log (only the not-yet-run calls get
      // the interrupted placeholder from the finally block).
      for (const { call } of sequential) {
        if (abort.signal.aborted) {
          emit({ type: 'done', stopReason: 'aborted' })
          return
        }

        const tool = lookupTool(call.name)
        let output: string
        let ok = true
        const toolImages: ImageAttachment[] = []
        const toolDocs: DocumentAttachment[] = []

        const ruleAction = tool
          ? matchRule(permissionRules, call.name, permissionSubject(call.name, call.arguments), roots)
          : null

        // Validate arguments before any gating so a malformed call is repaired
        // rather than prompting the user to approve a call that can't run.
        const invalid = tool ? validationFailure(call) : null

        if (!tool) {
          output = `Unknown tool: ${call.name}`
          ok = false
        } else if (invalid) {
          output = invalid.output
          ok = false
        } else if (ruleAction === 'deny') {
          // Attribute a deny to the managed tier when it originates there — the admin
          // block is checked first, so if it matches at all it IS the winning rule.
          // Gives the user an honest reason (their org, not a stray local rule) and
          // signals the deny is not one they can lift from Settings.
          const byManaged =
            managedPolicy.permissionRules.length > 0 &&
            matchRule(
              managedPolicy.permissionRules,
              call.name,
              permissionSubject(call.name, call.arguments),
              roots
            ) === 'deny'
          output = byManaged
            ? "Denied by your organization's managed policy."
            : 'Denied by a permission rule.'
          ok = false
        } else if (
          isBlockedByPlan(run.policy, tool.kind) ||
          (run.policy === 'plan' && tool.blockedInPlan === true)
        ) {
          output =
            'Blocked: Houston is in Plan mode (read-only). Do not modify files, run commands, or change remote/PR state. Finish your plan and present it; the user will switch off Plan mode to let you carry it out.'
          ok = false
        } else {
          // PreToolUse hooks run BEFORE the approval gate so a hook can auto-approve
          // or deny the call and rewrite its arguments. The (possibly rewritten)
          // execArgs drive the approval decision, snapshot, execution, and post-write
          // steps; the logged tool_use keeps the model's original arguments.
          const pre = await runHooks(
            hooks,
            'PreToolUse',
            { tool: call.name, input: call.arguments },
            workspace,
            abort.signal
          )
          emitHookNotice(pre)
          // Resolve the arguments the tool actually runs with: a PreToolUse hook may
          // rewrite them. An invalid rewrite fails the call rather than falling back to
          // the model's original (possibly unsafe) args.
          let execArgs = call.arguments
          let rewriteError: string | null = null
          if (!pre.blocked && pre.updatedInput) {
            const issues = validateToolArgs(pre.updatedInput, tool.schema.parameters)
            if (issues.length === 0) {
              execArgs = pre.updatedInput
            } else {
              rewriteError = `A PreToolUse hook rewrote the input, but it was invalid:\n${validationError(call.name, tool.schema.parameters, issues)}`
            }
          }
          // A rewrite changes what will actually run, so the permission rules are
          // re-matched against the rewritten arguments — `ruleAction` above was the
          // verdict on the model's ORIGINAL args. Without this, a user hook could
          // transform a permitted command into one a managed/project deny covers
          // (those tiers must stay tighten-only: hooks are user-level config and can
          // never loosen them), or keep riding an allow that matched only the
          // original subject.
          const execRuleAction =
            execArgs === call.arguments
              ? ruleAction
              : matchRule(permissionRules, call.name, permissionSubject(call.name, execArgs), roots)

          if (pre.blocked) {
            output = `Blocked by a PreToolUse hook:\n${pre.message || '(no output)'}`
            ok = false
          } else if (rewriteError) {
            output = rewriteError
            ok = false
          } else if (execRuleAction === 'deny') {
            // Only reachable via a rewrite (an original-args deny is caught before
            // hooks run), and it wins over a hook's `approve`. Attribute a managed
            // deny honestly, mirroring the pre-hook gate above.
            const byManaged =
              managedPolicy.permissionRules.length > 0 &&
              matchRule(
                managedPolicy.permissionRules,
                call.name,
                permissionSubject(call.name, execArgs),
                roots
              ) === 'deny'
            output = byManaged
              ? "A PreToolUse hook rewrote the input, and the rewritten input is denied by your organization's managed policy."
              : 'A PreToolUse hook rewrote the input, and the rewritten input is denied by a permission rule.'
            ok = false
          } else {
            // A permission rule can force-allow or force-ask; otherwise the policy
            // decides — folding in the honest sandbox status so unconfined shell on a
            // host without an enforceable sandbox is never silently auto-approved.
            const shellEscapesWorkspace =
              tool.kind === 'shell' &&
              call.name === 'run_shell' &&
              typeof execArgs.command === 'string' &&
              shellReferencesExternalPath(execArgs.command, roots)
            // Network consent is per-DESTINATION: "Allow for run" grants only this host,
            // so approving a fetch to one host never opens egress to every host. The
            // granted-host set stands in for the generic kind override on network calls.
            const netDest = tool.kind === 'network' ? networkDestination(call.name, execArgs) : null
            const kindOverride =
              netDest !== null ? run.networkHosts.has(netDest) : run.override.has(tool.kind)
            const { mustApprove, unsandboxedShell } = decideApproval({
              ruleAction: execRuleAction,
              policy: run.policy,
              kind: tool.kind,
              override: kindOverride,
              shellSandboxed: isSandboxed(),
              shellUnsandboxedOverride: run.shellUnsandboxedOverride,
              shellEscapesWorkspace
            })

            // #3b: in full-auto on a confining host, the first shell command pauses once
            // for a conscious network-consent decision. Full-auto otherwise auto-runs
            // shell inside a sandbox that reads the whole filesystem AND (previously) had
            // unconditional network — a one-command read-and-exfiltrate. The consent only
            // decides the sandbox's network switch; the command itself still runs, so when
            // it is the SOLE reason to pause, a decline runs the command offline rather
            // than denying it.
            const needsShellNetworkConsent =
              tool.kind === 'shell' &&
              run.policy === 'full-auto' &&
              isSandboxed() &&
              !run.shellNetworkGranted &&
              !run.shellNetworkDecided
            const consentOnly = needsShellNetworkConsent && !mustApprove

            // An `ask` mandated by the managed policy or the project guardrails can
            // never be skipped by a hook's `approve`: those tiers are tighten-only
            // (see parseTightenOnlyRules) and hooks are user-level config, so honoring
            // the directive would let the user's own hook suppress a prompt an admin
            // or the project explicitly required. Matched against execArgs — what will
            // actually run. A user-tier `ask` rule stays hook-skippable: the user
            // softening their own rule loosens nothing above their tier.
            const guardrailAsk =
              pre.approved &&
              guardrailRules.length > 0 &&
              matchRule(guardrailRules, call.name, permissionSubject(call.name, execArgs), roots) === 'ask'

            let approved = true
            // A PreToolUse hook that explicitly approves skips the approval prompt —
            // unless a guardrail-tier `ask` rule forced it. The one-time shell-network
            // consent rides the same gate.
            if ((mustApprove || needsShellNetworkConsent) && (!pre.approved || guardrailAsk)) {
              // Track the prompt so it can be replayed if the renderer re-opens this
              // conversation while the call is still blocking (the event is one-shot).
              // The shellNetwork FRAMING is shown only when the network question is the
              // sole reason to pause (consentOnly). When the command needs approval for
              // another reason (a rule, an escape, an unconfined host) it keeps its normal
              // command framing, yet approving it still grants the run's shell network
              // below — so the flag drives UI wording, not the grant.
              run.pendingApprovals.set(call.id, {
                name: call.name,
                summary: tool.summarize(execArgs),
                args: execArgs,
                kind: tool.kind,
                ...(unsandboxedShell ? { sandboxed: false } : {}),
                ...(consentOnly ? { shellNetwork: true } : {})
              })
              emit({
                type: 'tool_approval',
                callId: call.id,
                name: call.name,
                summary: tool.summarize(execArgs),
                args: execArgs,
                kind: tool.kind,
                ...(unsandboxedShell ? { sandboxed: false } : {}),
                ...(consentOnly ? { shellNetwork: true } : {})
              })
              const decision = await waitForApproval(run, call.id)
              // Resolved (or cancelled) — it's no longer awaiting the user.
              run.pendingApprovals.delete(call.id)
              if (consentOnly) {
                // The prompt was FRAMED as the network question, so its answer decides
                // ONLY the run's shell network — never whether the command runs (a decline
                // runs it offline). Gated on `consentOnly` (NOT `needsShellNetworkConsent`)
                // so a first shell command approved for another reason (an escape, an `ask`
                // rule), shown with plain command framing, can't silently unlock run-wide
                // egress: the network question is still asked separately. An explicit "Allow
                // for run" on such a command still grants network via applyApprovalDecision.
                const grant = decision !== 'deny' && decision !== 'rule-deny'
                run.shellNetworkGranted = grant
                run.shellNetworkDecided = true
                grantConversationShellNetwork(conversationId, grant)
                approved = true
              } else {
                // Overrides + rule persistence live in applyApprovalDecision (shared with
                // the writable subagent's unconfined-shell gate) — including the
                // per-destination network grant and shell → network coupling.
                approved = applyApprovalDecision(decision, call.name, execArgs, tool.kind, unsandboxedShell)
              }
            }

            if (!approved) {
              output = 'Denied by the user.'
              ok = false
            } else {
              // Snapshot each target's prior content so this turn's file changes can
              // be reverted — one path for the single-file tools, every add/update/
              // delete/move path for apply_patch.
              if (tool.kind === 'write') {
                for (const t of writeTargets(call.name, execArgs)) {
                  await recordOriginal(runId, roots, t.path)
                }
              }
              emit({ type: 'tool_start', callId: call.id, name: call.name, args: execArgs, kind: tool.kind })
              await plugins.emit('onToolStart', { tool: call.name, input: execArgs })
              // Serve identical read-only calls from the run cache. We only consult
              // it when there's no matching hook for this tool (a hook implies the
              // tool's result may be side-effect-gated or observed, so re-run it),
              // mirroring the parallel fast-path's hook exclusion. When a read is
              // cache-eligible there is no matching hook, so execArgs === call.arguments
              // and the key matches the parallel fast-path's.
              const cacheable = isCacheableRead(call.name, tool.kind)
              const useCache = cacheable && !hasMatchingHook(call.name)
              const cached = useCache ? await readCache.get(call.name, call.arguments) : undefined
              if (cached) {
                output = cached.output
                ok = cached.ok
                for (const img of cached.images) toolImages.push(img)
                for (const doc of cached.documents) toolDocs.push(doc)
              } else {
                try {
                  output = await tool.execute(
                    execArgs,
                    makeToolContext(
                      call.id,
                      (img) => toolImages.push(img),
                      (doc) => toolDocs.push(doc)
                    )
                  )
                } catch (e) {
                  output = `Error: ${(e as Error).message}`
                  ok = false
                }
                if (useCache) {
                  await readCache.set(
                    call.name,
                    call.arguments,
                    { output, ok, images: [...toolImages], documents: [...toolDocs] },
                    readDeps(call.name, call.arguments, resolvePath)
                  )
                }
              }
              // PostToolUse hooks run after the tool; their output is shown to the agent.
              const post = await runHooks(
                hooks,
                'PostToolUse',
                { tool: call.name, input: execArgs, result: output },
                workspace,
                abort.signal
              )
              emitHookNotice(post)
              if (post.message) output += `\n\n[PostToolUse hook]\n${post.message}`
              // Format-on-save (opt-in): after a successful write, run the matching
              // formatter on the file the agent wrote, the way an editor would. It's
              // best-effort — a missing binary or out-of-tree path is a silent no-op.
              // Runs before recordResult so the re-snapshot captures the formatted
              // content (and a revert/redo round-trips faithfully).
              if (
                ok &&
                settings.formatOnSave &&
                tool.kind === 'write' &&
                typeof execArgs.path === 'string'
              ) {
                try {
                  await formatFile(execArgs.path, {
                    workspace,
                    roots,
                    signal: abort.signal
                  })
                } catch {
                  // Formatting is best-effort; never fail the tool over it.
                }
              }
              // Snapshot each file's final content (after any hook/formatter)
              // so the change can be faithfully redone after a revert. A file an
              // apply_patch deliberately deleted records its absence as the
              // post-turn state, so redo re-deletes it.
              if (ok && tool.kind === 'write') {
                for (const t of writeTargets(call.name, execArgs)) {
                  await recordResult(runId, roots, t.path, { expectAbsent: t.deleted })
                }
              }
              // Diagnostics-on-save (opt-in): after a successful write, run a fast
              // checker (eslint/ruff/gofmt) on the file and append any problems so
              // the model can self-correct this turn. Runs on the final content
              // (after any formatter) and never mutates the file; best-effort, so a
              // missing binary or crashing checker is a silent no-op.
              if (
                ok &&
                settings.diagnosticsOnSave &&
                tool.kind === 'write' &&
                typeof execArgs.path === 'string'
              ) {
                try {
                  const diag = await runPostEditDiagnostics(execArgs.path, {
                    workspace,
                    roots,
                    signal: abort.signal
                  })
                  if (diag.block) output += diag.block
                } catch {
                  // Diagnostics are best-effort feedback — never fail the edit.
                }
              }
              // Invalidate cached reads that this mutation could have staled. A write
              // drops the entries depending on the path(s) it touched; a shell (or any
              // other non-read) call clears the cache wholesale, since a command can
              // change arbitrary files. Runs regardless of `ok` — a failed write may
              // have partially applied, and a failed shell command may still have had
              // side effects — so we never serve a stale read afterwards.
              if (tool.kind !== 'read') {
                invalidateForMutation(call.name, tool.kind, execArgs)
              }
            }
          }
          // Surface any context a PreToolUse hook injected (unless it blocked, where
          // the block reason is the message). Redacted with the rest at flushResult.
          if (!pre.blocked && pre.additionalContext) {
            output += `\n\n[PreToolUse hook]\n${pre.additionalContext}`
          }
        }

        await flushResult({
          call,
          output,
          ok,
          images: toolImages,
          documents: toolDocs
        })
      }

      persist(messages)
      if (abort.signal.aborted) {
        emit({ type: 'done', stopReason: 'aborted' })
        return
      }
      if (observeStall()) return
    }

    // Fell off the end of the iteration budget — the agent stopped mid-task rather
    // than finishing. Signal it instead of emitting a normal "done".
    emit({ type: 'limit', reason: 'max-steps' })
    emit({ type: 'done', stopReason: 'end_turn' })
  } finally {
    // A turn stopped mid-tool — the user hit Stop, or an exception unwound after
    // the assistant `tool_use` was persisted but before its result — would leave a
    // dangling tool call that makes the conversation un-continuable. Pair any
    // unanswered call with a placeholder so the persisted log stays valid. (A hard
    // crash skips this; the intake repair in startRun is the backstop for that.)
    const repaired = repairDanglingToolResults(messages)
    if (repaired !== messages) {
      messages.splice(0, messages.length, ...repaired)
      persist(messages)
    }
    runs.delete(runId)
    // Only clear the conversation's slot if it still points at this run, so a
    // (guarded-against, but defensive) later run can't have its entry removed.
    if (conversationId && runsByConversation.get(conversationId) === runId) {
      runsByConversation.delete(conversationId)
      notifyActiveRunsChanged()
    }
  }
}
