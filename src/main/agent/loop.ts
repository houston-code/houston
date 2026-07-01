import { realpathSync } from 'node:fs'
import type {
  AgentEvent,
  AgentRunRequest,
  ChatMessage,
  DocumentAttachment,
  Provider,
  QuestionOption,
  ReasoningBlock,
  StopReason,
  ToolApprovalDecision,
  ToolCall,
  ToolSchema
} from '@shared/agent'
import { isApprovalPolicy, type ApprovalPolicy, type PermissionRule } from '@shared/types'
import type { ImageAttachment } from '@shared/images'
import { DEFAULT_COMPACTION_THRESHOLD, resolveShellOutputBudget } from '@shared/defaults'
import { turnCostUsd } from '@shared/usage'
import { addPermissionRule, getKey, getProvider, getSettings } from '../agentHost'
import { createProvider } from '../providers'
import { buildSystemPrompt } from './prompt'
import { loadProjectRules } from './rules'
import { loadProjectConfig } from './projectConfig'
import {
  ASK_USER_NAME,
  getTool,
  toolSchemas,
  type ToolDef,
  type ToolContext,
  type ToolKind
} from './tools'
import { createShellSession } from './shell-session'
import { getMcpToolDefs } from '../mcp/manager'
import { MCP_LAZY_THRESHOLD, makeFindToolsDef } from './lazy-mcp'
import { isParallelizableRead, partitionCalls } from './scheduling'
import { validateToolArgs, validationError } from './argValidation'
import { abortableSleep, backoffDelayMs, isRetryableError, isToolsUnsupportedError } from './retry'
import { isBlockedByPlan, decideApproval } from './approval'
import { missingToolResults } from './repair'
import { matchRule, permissionSubject, shellReferencesExternalPath } from './permissions'
import { grantConversationOverride, overrideForConversation } from './overrides'
import { recordOriginal, recordResult, noteConversationRun } from './checkpoints'
import { runPostEditDiagnostics } from './diagnostics'
import { isSandboxed } from '../sandbox'
import { formatFile } from './format'
import { runSubAgent } from './subagent'
import { reviewWorkspaceChanges } from './review'
import { captureLocalhost } from './viewlocalhost'
import { matchingHooks, runHooks } from './hooks'
import { loadAgents } from './agents'
import { loadSkills } from './skills'
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
  summarizationSystemPrompt
} from './compaction'
import { buildPinnedMessages } from './workingMemory'

const MAX_ITERATIONS = 40
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
  pendingApprovals: Map<string, { name: string; summary: string; kind: ToolKind; sandboxed?: boolean }>
  pendingQuestions: Map<string, { question: string; options: QuestionOption[]; multiSelect?: boolean }>
  /**
   * Tool KINDS the user granted "Allow for run" on. A call is auto-approved when its
   * kind is in this set — per-kind, so allowing a write never silently also allows
   * network/MCP. Seeded from the conversation's accumulated grants (so the consent
   * spans the whole chat, not just this turn) and extended as the user approves more.
   * See {@link overrideForConversation}.
   */
  override: Set<ToolKind>
  /**
   * Per-run consent specifically to run UNCONFINED shell commands. On a host with no
   * enforceable sandbox, a generic `override` (granted for an unrelated tool) does NOT
   * substitute for this — the first unconfined shell command still prompts, surfacing
   * that there is no OS sandbox. Only "Allow for run" on such a prompt sets this. Stays
   * false (and unused) on confining hosts like macOS.
   */
  shellUnsandboxedOverride: boolean
  /**
   * The live approval policy. Seeded from the run request, but mutable so a
   * change made mid-run (e.g. the user switches the mode dropdown while the
   * agent is working) takes effect on the *next* tool-permission check rather
   * than only on the next turn. Read at call time everywhere policy is gated.
   */
  policy: ApprovalPolicy
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
      kind: a.kind,
      ...(a.sandboxed === false ? { sandboxed: false } : {})
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
  return events
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
  onMessages?: (messages: ChatMessage[]) => void
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
    override: seededOverride.kinds,
    shellUnsandboxedOverride: seededOverride.unsandboxedShell,
    policy: req.approvalPolicy
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
  const emit = (e: DistributiveOmitRunId<AgentEvent>): void =>
    send({ ...(e as object), runId } as AgentEvent)

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
    // Host-listed reasoning support for the selected model, used to override the
    // adapter's id-based heuristic so host-routed reasoning models still get a
    // reasoning param. Undefined when the model carries no capability metadata.
    const reasoningCapable = providerConfig.models.find((m) => m.id === req.model)?.caps?.reasoning

    let provider
    try {
      provider = createProvider(providerConfig)
    } catch (e) {
      emit({ type: 'error', message: (e as Error).message })
      return
    }

    const settings = getSettings()
    const rules = await loadProjectRules(workspace)
    // Project-scoped guardrails (.houston/settings.json) are checked before the
    // user's global rules. The project file can only tighten (deny/ask) — see
    // projectConfig.ts for why.
    const projectConfig = await loadProjectConfig(workspace)
    const permissionRules = [...projectConfig.permissionRules, ...(settings.permissionRules ?? [])]
    // The system prompt is built once and can't change mid-run, so plan-mode
    // *guidance* is a snapshot of the starting policy. The runtime plan-mode
    // *block* below reads `run.policy`, so toggling plan on/off mid-run still
    // gates tool calls live — only the prose the model already saw is fixed.
    const planMode = req.approvalPolicy === 'plan'
    const agents = await loadAgents(workspace)
    const skills = await loadSkills(workspace)
    // Local plugins (.houston/plugins/*.js) register observational lifecycle
    // hooks. They are executable JS run in-process and `vm` is not a security
    // boundary, so they are NEVER auto-run for an opened repo — only when the user
    // has explicitly opted into project plugins for a trusted project. See
    // plugins.ts for the trust boundary.
    const plugins = await loadPluginsIfEnabled(workspace, settings.projectPlugins)
    const agentsByName = new Map(agents.map((a) => [a.name, a]))
    const capabilities = buildCapabilities(agents, skills)
    // Git + GitHub awareness folded into the prompt. githubContext is a pure PATH
    // probe (no network), so the run start never triggers unapproved egress.
    const gitStatus = [await gitContext(workspace), githubContext()].filter((s) => s.trim()).join('\n')
    const system = buildSystemPrompt(
      workspace,
      settings.systemPromptExtra,
      rules.text,
      planMode,
      capabilities,
      gitStatus,
      req.providerId,
      req.model
    )
    // Built-in tools plus any tools from connected MCP servers (best effort).
    // When a lot of MCP tools are connected, sending every schema on every turn
    // bloats the context window (and bills BYO-model users) for tools the model
    // may never touch. Above a threshold we defer them: the model gets a compact
    // catalog via a `find_tools` meta-tool and loads only what it needs, which
    // then rides along on later turns. At/below the threshold nothing changes.
    const mcpToolDefs = await getMcpToolDefs(settings.mcpServers)
    const lazyMcp = mcpToolDefs.length > MCP_LAZY_THRESHOLD
    const revealedMcp = new Set<string>()
    const findTools = lazyMcp ? makeFindToolsDef(mcpToolDefs, revealedMcp) : null
    const lookupTool = (name: string): ToolDef | undefined =>
      getTool(name) ??
      (findTools && name === findTools.schema.name ? findTools : undefined) ??
      mcpToolDefs.find((d) => d.schema.name === name)
    // The schemas advertised to the model this turn: built-ins, plus either every
    // MCP schema (small setups) or just find_tools + already-revealed MCP tools
    // (lazy). Recomputed each turn so tools revealed via find_tools then appear.
    const buildTools = (): ToolSchema[] => [
      ...toolSchemas(),
      ...(findTools ? [findTools.schema] : []),
      ...mcpToolDefs
        .filter((d) => !lazyMcp || revealedMcp.has(d.schema.name))
        .map((d) => d.schema)
    ]
    // A prior run interrupted while a tool call was pending (commonly parked on an
    // approval prompt when the app quit/crashed) leaves an assistant `tool_use`
    // with no matching `tool_result`. Providers reject that history, so backfill
    // placeholder results before the first provider call — otherwise every
    // continue/retry on this conversation fails. Persist the repair so the stored
    // log and transcript are valid too, not just the in-flight request.
    const orphanFill = missingToolResults(messages)
    if (orphanFill.length > 0) {
      messages.push(...orphanFill)
      onMessages?.(messages)
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

    // Resolve `gh` once for the run; the GitHub tools fall back to their own
    // resolution (and a guiding error) when it isn't installed.
    const ghPath = resolveGh()
    const ghExec = ghPath ? runGh(ghPath) : undefined

    // Shared tool-execution context. `run.policy` and `run.override` are read at
    // call time so a mid-run policy change or an "Allow for run" decision earlier
    // in the turn takes effect. `allowNetwork` governs the shell sandbox's network
    // access, so it tracks the shell grant: full-auto, or "Allow for run" on a shell
    // command (granting an unrelated kind no longer loosens shell networking).
    const makeToolContext = (
      callId: string,
      attachImage: (i: ImageAttachment) => void,
      attachDocument: (d: DocumentAttachment) => void
    ): ToolContext => ({
      workspace,
      roots,
      allowNetwork: run.policy === 'full-auto' || run.override.has('shell'),
      signal: abort.signal,
      ...(conversationId ? { conversationId } : {}),
      shellSession,
      shellOutputMaxBytes: resolveShellOutputBudget(settings),
      ghExec,
      getSecret: getKey,
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
      dispatchSubAgent: (prompt, agentName) => {
        const agent = agentName ? agentsByName.get(agentName) : undefined
        // A research subagent bills against the same model; total its tokens and
        // fold them into the conversation's usage when it ends. inputTokens: 0
        // keeps the context-size meter on the main turn (this is an ephemeral
        // subagent context), while output + cost accumulate. Mirrors dispatchReview.
        let subInput = 0
        let subOutput = 0
        return runSubAgent({
          provider,
          model: req.model,
          workspace,
          prompt,
          signal: abort.signal,
          systemOverride: agent?.systemPrompt,
          tools: agent?.tools,
          onUsage: (u) => {
            subInput += u.inputTokens ?? 0
            subOutput += u.outputTokens ?? 0
          }
        }).finally(() => {
          if (subInput || subOutput) {
            emit({
              type: 'usage',
              inputTokens: 0,
              outputTokens: subOutput,
              cost: turnCostUsd(req.model, subInput, subOutput)
            })
          }
        })
      },
      dispatchReview: (base, paths, effort) => {
        // The review's nested subagent calls bill against the same model; total
        // their tokens and fold them into the conversation's usage when it ends.
        // inputTokens: 0 keeps the context-size meter on the main turn (these are
        // ephemeral subagent contexts), while output + cost accumulate.
        let reviewInput = 0
        let reviewOutput = 0
        return reviewWorkspaceChanges({
          provider,
          model: req.model,
          workspace,
          base,
          paths,
          effort,
          onProgress: (message) => emit({ type: 'tool_progress', callId, message }),
          onSubAgent: (ev) =>
            emit({ type: 'subagent', parentCallId: callId, id: ev.id, label: ev.label, status: ev.status }),
          onUsage: (u) => {
            reviewInput += u.inputTokens ?? 0
            reviewOutput += u.outputTokens ?? 0
          },
          signal: abort.signal
        }).finally(() => {
          if (reviewInput || reviewOutput) {
            emit({
              type: 'usage',
              inputTokens: 0,
              outputTokens: reviewOutput,
              cost: turnCostUsd(req.model, reviewInput, reviewOutput)
            })
          }
        })
      },
      attachImage,
      attachDocument,
      captureLocalhost,
      // The recall tool reads the full, un-compacted log. Return a shallow copy so a
      // tool can never mutate the loop's persisted `messages` through this handle.
      getHistory: () => [...messages]
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
        permissionSubject(call.name, call.arguments)
      )
      const hasHook =
        matchingHooks(settings.hooks, 'PreToolUse', call.name).length > 0 ||
        matchingHooks(settings.hooks, 'PostToolUse', call.name).length > 0
      return isParallelizableRead(tool.kind, ruleAction, hasHook)
    }

    // Context compaction state. `messages` is always the full, persisted log; what
    // we actually send the provider is `summaryMsgs` (a synthetic summary of the
    // turns before `cut`) followed by `messages.slice(cut)`.
    const threshold = settings.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD
    let cut = 0
    let summaryMsgs: ChatMessage[] = []
    let lastInputTokens = 0

    // Summarize messages[cut..newCut), fold the result into the synthetic summary,
    // and advance `cut`. Shared by the proactive (pre-send, threshold-driven) path
    // and the reactive (post-overflow) recovery path.
    const compactTo = async (newCut: number): Promise<'ok' | 'aborted' | 'failed'> => {
      if (newCut <= cut) return 'failed'
      try {
        const summary = await summarize(
          provider,
          req.model,
          buildSummaryRequestMessages(summaryMsgs, messages.slice(cut, newCut)),
          abort.signal
        )
        if (!summary) return 'failed'
        // Messages folded into the summary *this round* (a count, which is what the
        // renderer shows) — not the absolute tail-start index.
        const compactedNow = newCut - cut
        summaryMsgs = buildSummaryMessages(summary)
        cut = newCut
        lastInputTokens = 0
        emit({ type: 'compaction', summarized: compactedNow })
        return 'ok'
      } catch {
        return abort.signal.aborted ? 'aborted' : 'failed'
      }
    }

    // Assemble the window actually sent to the provider from the persisted log. Three
    // durable-context transforms layer on top of the summary + kept tail, and NONE of
    // them mutate `messages` — only this ephemeral copy:
    //   1. Pinned working memory (original task, live todo list, files in play) is
    //      prepended ahead of everything so it survives compaction/eviction losslessly.
    //   2. summaryMsgs stands in for the compacted head (turns before `cut`).
    //   3. Stale + large tool results in the kept tail are replaced by compact stubs
    //      (recoverable via recall_history) — surgical, unlike whole-turn compaction.
    const buildWindow = (): ChatMessage[] => [
      ...buildPinnedMessages(messages),
      ...summaryMsgs,
      ...evictStaleToolResults(messages.slice(cut))
    ]

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (abort.signal.aborted) {
        emit({ type: 'done', stopReason: 'aborted' })
        return
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
        emit({
          type: 'usage',
          inputTokens: turnInput,
          outputTokens: turnOutput,
          cost: turnCostUsd(req.model, turnInput, turnOutput)
        })
      }

      messages.push({
        role: 'assistant',
        content: assistantText,
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(turnReasoning.length ? { reasoning: turnReasoning } : {})
      })
      onMessages?.(messages)

      if (toolCalls.length === 0) {
        // The model's reply was cut off at its output limit — say so rather than
        // presenting a truncated answer as complete.
        if (stopReason === 'max_tokens') emit({ type: 'limit', reason: 'max-output' })
        emit({ type: 'done', stopReason })
        return
      }

      // ---------------------------------------------------------------------
      // Tool dispatch. A turn can mix parallelizable reads with encumbered calls
      // (writes/shell/network/MCP/gated/hooked/ask_user). We run the independent
      // read subset CONCURRENTLY while the rest runs SEQUENTIALLY in its original
      // relative order, then append every tool_result to the message log in the
      // ORIGINAL call order — so the transcript and the window the model sees are
      // identical to a fully-sequential run. The all-reads case is just the
      // partition where `sequential` is empty; the all-encumbered case is the one
      // where `parallel` is empty (fully sequential, exactly as before).
      // ---------------------------------------------------------------------

      // Per-call outcome, ready to emit + append. `slots` is indexed by the call's
      // original position so we can flush results in model-visible order regardless
      // of the order the parallel/sequential groups actually finished in. A slot may
      // stay undefined only if the run aborts mid-sequential-dispatch — that early
      // return emits its own terminal 'done' and never reaches the flush.
      interface CallResult {
        call: ToolCall
        output: string
        ok: boolean
        images: ImageAttachment[]
        documents: DocumentAttachment[]
      }
      const slots: (CallResult | undefined)[] = new Array(toolCalls.length)

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

      // Partition this turn's calls. `isParallelCall` already excludes ask_user,
      // MCP, writes/shell/network, gated (deny/ask) rules, and hooked tools.
      const { parallel, sequential } = partitionCalls(toolCalls, isParallelCall)

      // --- Parallel group: unencumbered reads, all dispatched at once. ---------
      // These need no approval, plan check, hooks, or checkpoint, so there's no
      // ordering constraint between them. We still validate each before executing
      // and emit tool_start for the ones that actually run (renderer + plugins see
      // the call). Results land in their original slot; the ordered flush below
      // emits tool_result/appends messages in call order.
      for (const { call } of parallel) {
        const invalid = validationFailure(call)
        if (invalid) continue // tool_start intentionally not emitted for a refused call
        emit({ type: 'tool_start', callId: call.id, name: call.name, args: call.arguments })
        await plugins.emit('onToolStart', { tool: call.name, input: call.arguments })
      }
      const parallelResults = await Promise.all(
        parallel.map(async ({ call, index }): Promise<[number, CallResult]> => {
          const invalid = validationFailure(call)
          if (invalid) return [index, invalid]
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
          return [index, { call, output, ok, images, documents }]
        })
      )
      for (const [index, result] of parallelResults) slots[index] = result

      // --- Sequential group: everything else, one call at a time. --------------
      // Preserves the original relative order of the encumbered calls and every
      // existing semantic: unknown-tool, deny rule, plan block, approval prompts,
      // "Allow for run"/rule persistence, Pre/PostToolUse hooks, write checkpoints,
      // format/diagnostics-on-save, and per-call abort checks. Identical to the old
      // sequential path, except the outcome is stored in `slots[index]` (flushed in
      // order below) instead of being emitted/appended inline.
      for (const { call, index } of sequential) {
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
          ? matchRule(permissionRules, call.name, permissionSubject(call.name, call.arguments))
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
          output = 'Denied by a permission rule.'
          ok = false
        } else if (
          isBlockedByPlan(run.policy, tool.kind) ||
          (run.policy === 'plan' && tool.blockedInPlan === true)
        ) {
          output =
            'Blocked: Houston is in Plan mode (read-only). Do not modify files, run commands, or change remote/PR state. Finish your plan and present it; the user will switch off Plan mode to let you carry it out.'
          ok = false
        } else {
          // A permission rule can force-allow or force-ask; otherwise the policy
          // decides — folding in the honest sandbox status so unconfined shell on a
          // host without an enforceable sandbox is never silently auto-approved.
          const shellEscapesWorkspace =
            tool.kind === 'shell' &&
            call.name === 'run_shell' &&
            typeof call.arguments.command === 'string' &&
            shellReferencesExternalPath(call.arguments.command)
          const { mustApprove, unsandboxedShell } = decideApproval({
            ruleAction,
            policy: run.policy,
            kind: tool.kind,
            override: run.override.has(tool.kind),
            shellSandboxed: isSandboxed(),
            shellUnsandboxedOverride: run.shellUnsandboxedOverride,
            shellEscapesWorkspace
          })

          let approved = true
          if (mustApprove) {
            // Track the prompt so it can be replayed if the renderer re-opens this
            // conversation while the call is still blocking (the event is one-shot).
            run.pendingApprovals.set(call.id, {
              name: call.name,
              summary: tool.summarize(call.arguments),
              kind: tool.kind,
              ...(unsandboxedShell ? { sandboxed: false } : {})
            })
            emit({
              type: 'tool_approval',
              callId: call.id,
              name: call.name,
              summary: tool.summarize(call.arguments),
              kind: tool.kind,
              ...(unsandboxedShell ? { sandboxed: false } : {})
            })
            const decision = await waitForApproval(run, call.id)
            // Resolved (or cancelled) — it's no longer awaiting the user.
            run.pendingApprovals.delete(call.id)
            if (decision === 'always') {
              // "Allow for run" — auto-approve this KIND for the rest of the run, and
              // remember it on the conversation so later turns inherit the consent.
              run.override.add(tool.kind)
              // "Allow for run" on an unconfined-shell prompt is the conscious consent
              // to keep running unsandboxed; a generic override never sets this.
              if (unsandboxedShell) run.shellUnsandboxedOverride = true
              grantConversationOverride(conversationId, tool.kind, unsandboxedShell)
            } else if (decision === 'rule-allow' || decision === 'rule-deny') {
              // "Always allow/deny" — persist a permission rule for this tool + subject
              // so the choice survives restarts, and splice it into this run's rules
              // (after the project rules, which only tighten) so it takes effect now.
              const rule: PermissionRule = {
                action: decision === 'rule-allow' ? 'allow' : 'deny',
                tool: call.name,
                match: permissionSubject(call.name, call.arguments) || '*'
              }
              addPermissionRule(rule)
              permissionRules.splice(projectConfig.permissionRules.length, 0, rule)
            }
            approved = decision !== 'deny' && decision !== 'rule-deny'
          }

          if (!approved) {
            output = 'Denied by the user.'
            ok = false
          } else {
            // PreToolUse hooks can block the call before it runs.
            const pre = await runHooks(
              settings.hooks,
              'PreToolUse',
              { tool: call.name, input: call.arguments },
              workspace,
              abort.signal
            )
            if (pre.blocked) {
              output = `Blocked by a PreToolUse hook:\n${pre.message || '(no output)'}`
              ok = false
            } else {
              // Snapshot the target's prior content so this turn's file changes can be reverted.
              if (tool.kind === 'write' && typeof call.arguments.path === 'string') {
                await recordOriginal(runId, roots, call.arguments.path)
              }
              emit({ type: 'tool_start', callId: call.id, name: call.name, args: call.arguments })
              await plugins.emit('onToolStart', { tool: call.name, input: call.arguments })
              try {
                output = await tool.execute(
                  call.arguments,
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
              // PostToolUse hooks run after the tool; their output is shown to the agent.
              const post = await runHooks(
                settings.hooks,
                'PostToolUse',
                { tool: call.name, input: call.arguments, result: output },
                workspace,
                abort.signal
              )
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
                typeof call.arguments.path === 'string'
              ) {
                try {
                  await formatFile(call.arguments.path, {
                    workspace,
                    roots,
                    signal: abort.signal
                  })
                } catch {
                  // Formatting is best-effort; never fail the tool over it.
                }
              }
              // Snapshot the file's final content (after any hook/formatter)
              // so the change can be faithfully redone after a revert.
              if (ok && tool.kind === 'write' && typeof call.arguments.path === 'string') {
                await recordResult(runId, roots, call.arguments.path)
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
                typeof call.arguments.path === 'string'
              ) {
                try {
                  const diag = await runPostEditDiagnostics(call.arguments.path, {
                    workspace,
                    roots,
                    signal: abort.signal
                  })
                  if (diag.block) output += diag.block
                } catch {
                  // Diagnostics are best-effort feedback — never fail the edit.
                }
              }
            }
          }
        }

        slots[index] = {
          call,
          output,
          ok,
          images: toolImages,
          documents: toolDocs
        }
      }

      // --- Ordered flush. -------------------------------------------------------
      // Emit tool_result + fire the onToolResult plugin event + append the tool
      // message, all in ORIGINAL call order, so each tool_use is answered exactly
      // once and the persisted log stays provider-valid (role alternation, matched
      // toolCallId pairing). Every slot is populated: the sequential path fills its
      // slots inline and only leaves them empty on an early abort return (which
      // never reaches here). A `!` guard keeps that invariant explicit.
      for (let i = 0; i < toolCalls.length; i++) {
        const r = slots[i]!
        emit({
          type: 'tool_result',
          callId: r.call.id,
          name: r.call.name,
          ok: r.ok,
          output: r.output,
          ...(r.images.length ? { images: r.images } : {})
        })
        await plugins.emit('onToolResult', {
          tool: r.call.name,
          input: r.call.arguments,
          output: r.output,
          ok: r.ok
        })
        messages.push({
          role: 'tool',
          content: r.output,
          toolCallId: r.call.id,
          toolName: r.call.name,
          ...(r.images.length ? { images: r.images } : {}),
          ...(r.documents.length ? { documents: r.documents } : {})
        })
      }
      onMessages?.(messages)
      if (abort.signal.aborted) {
        emit({ type: 'done', stopReason: 'aborted' })
        return
      }
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
    const fill = missingToolResults(messages)
    if (fill.length > 0) {
      messages.push(...fill)
      onMessages?.(messages)
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
