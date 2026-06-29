import { realpathSync } from 'node:fs'
import type {
  AgentEvent,
  AgentRunRequest,
  ChatMessage,
  DocumentAttachment,
  Provider,
  ReasoningBlock,
  StopReason,
  ToolApprovalDecision,
  ToolCall,
  ToolSchema
} from '@shared/agent'
import { isApprovalPolicy, type ApprovalPolicy } from '@shared/types'
import type { ImageAttachment } from '@shared/images'
import { DEFAULT_COMPACTION_THRESHOLD, resolveShellOutputBudget } from '@shared/defaults'
import { turnCostUsd } from '@shared/usage'
import { getProvider, getSettings } from '../store'
import { getKey } from '../secrets'
import { createProvider } from '../providers'
import { buildSystemPrompt } from './prompt'
import { loadProjectRules } from './rules'
import { loadProjectConfig } from './projectConfig'
import { ASK_USER_NAME, getTool, toolSchemas, type ToolDef, type ToolContext } from './tools'
import { createShellSession } from './shell-session'
import { getMcpToolDefs } from '../mcp/manager'
import { MCP_LAZY_THRESHOLD, makeFindToolsDef } from './lazy-mcp'
import { isParallelizableRead } from './scheduling'
import { abortableSleep, backoffDelayMs, isRetryableError, isToolsUnsupportedError } from './retry'
import { isBlockedByPlan, decideApproval } from './approval'
import { matchRule, permissionSubject, shellReferencesExternalPath } from './permissions'
import { recordOriginal, recordResult } from './checkpoints'
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
import { githubContext, resolveGh, runGh } from './github'
import {
  KEEP_RECENT_USER_TURNS,
  SUMMARY_MAX_TOKENS,
  buildSummaryMessages,
  buildSummaryRequestMessages,
  estimateTokens,
  findCompactionCut,
  findForcedCompactionCut,
  isContextOverflowError,
  summarizationSystemPrompt
} from './compaction'

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
  /** Flipped to true once the user chooses "always" — auto-approve the rest. */
  override: boolean
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

export function cancelRun(runId: string): void {
  const run = runs.get(runId)
  if (!run) return
  for (const resolve of run.approvals.values()) resolve('deny')
  run.approvals.clear()
  // Unblock any pending question so its tool call returns instead of hanging.
  for (const resolve of run.questions.values()) resolve('[The user stopped the agent without answering.]')
  run.questions.clear()
  run.abort.abort()
}

export function resolveApproval(runId: string, callId: string, decision: ToolApprovalDecision): void {
  const run = runs.get(runId)
  const resolve = run?.approvals.get(callId)
  if (run && resolve) {
    run.approvals.delete(callId)
    resolve(decision)
  }
}

/** Deliver the user's answer to a pending `ask_user` question. */
export function resolveQuestion(runId: string, callId: string, answer: string): void {
  const run = runs.get(runId)
  const resolve = run?.questions.get(callId)
  if (run && resolve) {
    run.questions.delete(callId)
    resolve(answer)
  }
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
  const run: RunState = {
    abort,
    approvals: new Map(),
    questions: new Map(),
    override: false,
    shellUnsandboxedOverride: false,
    policy: req.approvalPolicy
  }
  runs.set(runId, run)
  if (conversationId) runsByConversation.set(conversationId, runId)

  type DistributiveOmitRunId<T> = T extends unknown ? Omit<T, 'runId'> : never
  const emit = (e: DistributiveOmitRunId<AgentEvent>): void =>
    send({ ...(e as object), runId } as AgentEvent)

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
    const messages: ChatMessage[] = [...req.messages]

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

    // Persistent shell state for this run: `cd` and exported env carry between
    // foreground run_shell calls so the agent gets "same terminal" behavior.
    const shellSession = createShellSession(workspace)

    // Resolve `gh` once for the run; the GitHub tools fall back to their own
    // resolution (and a guiding error) when it isn't installed.
    const ghPath = resolveGh()
    const ghExec = ghPath ? runGh(ghPath) : undefined

    // Shared tool-execution context. `run.policy` and `run.override` are read at
    // call time so a mid-run policy change or an "Allow for run" decision earlier
    // in the turn takes effect.
    const makeToolContext = (
      callId: string,
      attachImage: (i: ImageAttachment) => void,
      attachDocument: (d: DocumentAttachment) => void
    ): ToolContext => ({
      workspace,
      roots,
      allowNetwork: run.policy === 'full-auto' || run.override,
      signal: abort.signal,
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
        return runSubAgent({
          provider,
          model: req.model,
          workspace,
          prompt,
          signal: abort.signal,
          systemOverride: agent?.systemPrompt,
          tools: agent?.tools
        })
      },
      dispatchReview: (base, paths, effort) =>
        reviewWorkspaceChanges({
          provider,
          model: req.model,
          workspace,
          base,
          paths,
          effort,
          onProgress: (message) => emit({ type: 'tool_progress', callId, message }),
          onSubAgent: (ev) =>
            emit({ type: 'subagent', parentCallId: callId, id: ev.id, label: ev.label, status: ev.status }),
          signal: abort.signal
        }),
      attachImage,
      attachDocument,
      captureLocalhost
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
        const windowNow = [...summaryMsgs, ...messages.slice(cut)]
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

      let sendMessages = [...summaryMsgs, ...messages.slice(cut)]

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
              sendMessages = [...summaryMsgs, ...messages.slice(cut)]
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

      // Fast path: when every call in the turn is an unencumbered read, run them
      // concurrently. Any write/shell/network/mcp call, gating rule, or hook makes
      // the whole turn fall back to the sequential path below (unchanged).
      if (toolCalls.length > 1 && toolCalls.every(isParallelCall)) {
        for (const call of toolCalls) {
          emit({ type: 'tool_start', callId: call.id, name: call.name, args: call.arguments })
          await plugins.emit('onToolStart', { tool: call.name, input: call.arguments })
        }
        const results = await Promise.all(
          toolCalls.map(async (call) => {
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
            return { call, output, ok, images, documents }
          })
        )
        for (const r of results) {
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
        continue
      }

      for (const call of toolCalls) {
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

        if (!tool) {
          output = `Unknown tool: ${call.name}`
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
            override: run.override,
            shellSandboxed: isSandboxed(),
            shellUnsandboxedOverride: run.shellUnsandboxedOverride,
            shellEscapesWorkspace
          })

          let approved = true
          if (mustApprove) {
            emit({
              type: 'tool_approval',
              callId: call.id,
              name: call.name,
              summary: tool.summarize(call.arguments),
              kind: tool.kind,
              ...(unsandboxedShell ? { sandboxed: false } : {})
            })
            const decision = await waitForApproval(run, call.id)
            if (decision === 'always') {
              run.override = true
              // "Allow for run" on an unconfined-shell prompt is the conscious consent
              // to keep running unsandboxed; a generic override never sets this.
              if (unsandboxedShell) run.shellUnsandboxedOverride = true
            }
            approved = decision !== 'deny'
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

        emit({
          type: 'tool_result',
          callId: call.id,
          name: call.name,
          ok,
          output,
          ...(toolImages.length ? { images: toolImages } : {})
        })
        await plugins.emit('onToolResult', { tool: call.name, input: call.arguments, output, ok })
        messages.push({
          role: 'tool',
          content: output,
          toolCallId: call.id,
          toolName: call.name,
          ...(toolImages.length ? { images: toolImages } : {}),
          ...(toolDocs.length ? { documents: toolDocs } : {})
        })
        onMessages?.(messages)
      }
    }

    // Fell off the end of the iteration budget — the agent stopped mid-task rather
    // than finishing. Signal it instead of emitting a normal "done".
    emit({ type: 'limit', reason: 'max-steps' })
    emit({ type: 'done', stopReason: 'end_turn' })
  } finally {
    runs.delete(runId)
    // Only clear the conversation's slot if it still points at this run, so a
    // (guarded-against, but defensive) later run can't have its entry removed.
    if (conversationId && runsByConversation.get(conversationId) === runId) {
      runsByConversation.delete(conversationId)
    }
  }
}
