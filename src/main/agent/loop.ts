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
  ToolCall
} from '@shared/agent'
import type { ImageAttachment } from '@shared/images'
import { DEFAULT_COMPACTION_THRESHOLD } from '@shared/defaults'
import { getProvider, getSettings } from '../store'
import { getKey } from '../secrets'
import { createProvider } from '../providers'
import { buildSystemPrompt } from './prompt'
import { loadProjectRules } from './rules'
import { getTool, toolSchemas, type ToolDef, type ToolContext } from './tools'
import { getMcpToolDefs } from '../mcp/manager'
import { isParallelizableRead } from './scheduling'
import { isBlockedByPlan, needsApproval } from './approval'
import { matchRule, permissionSubject } from './permissions'
import { recordOriginal, recordResult } from './checkpoints'
import { runSubAgent } from './subagent'
import { matchingHooks, runHooks } from './hooks'
import { loadAgents } from './agents'
import { loadSkills } from './skills'
import { buildCapabilities } from './capabilities'
import { gitContext } from './git'
import {
  KEEP_RECENT_USER_TURNS,
  SUMMARY_MAX_TOKENS,
  buildSummaryMessages,
  buildSummaryRequestMessages,
  estimateTokens,
  findCompactionCut,
  summarizationSystemPrompt
} from './compaction'

const MAX_ITERATIONS = 40

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
  /** Flipped to true once the user chooses "always" — auto-approve the rest. */
  override: boolean
}

const runs = new Map<string, RunState>()

export function cancelRun(runId: string): void {
  const run = runs.get(runId)
  if (!run) return
  for (const resolve of run.approvals.values()) resolve('deny')
  run.approvals.clear()
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
  const { runId } = req
  const abort = new AbortController()
  const run: RunState = { abort, approvals: new Map(), override: false }
  runs.set(runId, run)

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

    let provider
    try {
      provider = createProvider(providerConfig)
    } catch (e) {
      emit({ type: 'error', message: (e as Error).message })
      return
    }

    const settings = getSettings()
    const rules = await loadProjectRules(workspace)
    const planMode = req.approvalPolicy === 'plan'
    const agents = await loadAgents(workspace)
    const skills = await loadSkills(workspace)
    const agentsByName = new Map(agents.map((a) => [a.name, a]))
    const capabilities = buildCapabilities(agents, skills)
    const gitStatus = await gitContext(workspace)
    const system = buildSystemPrompt(
      workspace,
      settings.systemPromptExtra,
      rules.text,
      planMode,
      capabilities,
      gitStatus
    )
    // Built-in tools plus any tools from connected MCP servers (best effort).
    const mcpToolDefs = await getMcpToolDefs(settings.mcpServers)
    const tools = [...toolSchemas(), ...mcpToolDefs.map((d) => d.schema)]
    const lookupTool = (name: string): ToolDef | undefined =>
      getTool(name) ?? mcpToolDefs.find((d) => d.schema.name === name)
    const messages: ChatMessage[] = [...req.messages]

    // Shared tool-execution context. `run.override` is read at call time so an
    // "Allow for run" decision earlier in the turn takes effect.
    const makeToolContext = (
      attachImage: (i: ImageAttachment) => void,
      attachDocument: (d: DocumentAttachment) => void
    ): ToolContext => ({
      workspace,
      allowNetwork: req.approvalPolicy === 'full-auto' || run.override,
      signal: abort.signal,
      getSecret: getKey,
      dispatchSubAgent: (prompt, agentName) =>
        runSubAgent({
          provider,
          model: req.model,
          workspace,
          prompt,
          signal: abort.signal,
          systemOverride: agentName ? agentsByName.get(agentName)?.systemPrompt : undefined
        }),
      attachImage,
      attachDocument
    })

    /** True if a call is a read-only tool with no gating — safe to run concurrently. */
    const isParallelCall = (call: ToolCall): boolean => {
      const tool = lookupTool(call.name)
      if (!tool) return false
      const ruleAction = matchRule(
        settings.permissionRules,
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

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (abort.signal.aborted) {
        emit({ type: 'done', stopReason: 'aborted' })
        return
      }

      // Compact older turns before they overflow the model's context window. The
      // visible transcript (persisted `messages`) is untouched — only the window
      // sent to the provider shrinks.
      if (threshold > 0) {
        const windowNow = [...summaryMsgs, ...messages.slice(cut)]
        const size = Math.max(estimateTokens(system, windowNow), lastInputTokens)
        if (size > threshold) {
          const newCut = findCompactionCut(messages, cut, KEEP_RECENT_USER_TURNS)
          if (newCut > cut) {
            try {
              const summary = await summarize(
                provider,
                req.model,
                buildSummaryRequestMessages(summaryMsgs, messages.slice(cut, newCut)),
                abort.signal
              )
              if (summary) {
                // Messages folded into the summary *this round* (a count, which is
                // what the renderer shows) — not the absolute tail-start index.
                const compactedNow = newCut - cut
                summaryMsgs = buildSummaryMessages(summary)
                cut = newCut
                lastInputTokens = 0
                emit({ type: 'compaction', summarized: compactedNow })
              }
            } catch {
              if (abort.signal.aborted) {
                emit({ type: 'done', stopReason: 'aborted' })
                return
              }
              // Summarization failed — keep going with the full window rather than
              // breaking the run. The turn may still fit, or surface a provider error.
            }
          }
        }
      }

      const sendMessages = [...summaryMsgs, ...messages.slice(cut)]

      let assistantText = ''
      const toolCalls: ToolCall[] = []
      let stopReason: StopReason = 'end_turn'
      let turnInput = 0
      let turnOutput = 0
      let turnReasoning: ReasoningBlock[] = []

      try {
        for await (const ev of provider.streamChat({
          model: req.model,
          system,
          messages: sendMessages,
          tools,
          reasoningEffort: settings.reasoningEffort,
          signal: abort.signal
        })) {
          if (ev.type === 'text') {
            assistantText += ev.text
            emit({ type: 'text', delta: ev.text })
          } else if (ev.type === 'reasoning') {
            emit({ type: 'reasoning', delta: ev.text })
          } else if (ev.type === 'tool_call') {
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
            emit({ type: 'error', message: ev.message })
            return
          }
        }
      } catch (e) {
        if (abort.signal.aborted) {
          emit({ type: 'done', stopReason: 'aborted' })
        } else {
          emit({ type: 'error', message: (e as Error).message })
        }
        return
      }

      if (turnInput || turnOutput) {
        emit({ type: 'usage', inputTokens: turnInput, outputTokens: turnOutput })
      }

      messages.push({
        role: 'assistant',
        content: assistantText,
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(turnReasoning.length ? { reasoning: turnReasoning } : {})
      })
      onMessages?.(messages)

      if (toolCalls.length === 0) {
        emit({ type: 'done', stopReason })
        return
      }

      // Fast path: when every call in the turn is an unencumbered read, run them
      // concurrently. Any write/shell/network/mcp call, gating rule, or hook makes
      // the whole turn fall back to the sequential path below (unchanged).
      if (toolCalls.length > 1 && toolCalls.every(isParallelCall)) {
        for (const call of toolCalls) {
          emit({ type: 'tool_start', callId: call.id, name: call.name, args: call.arguments })
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
          emit({ type: 'tool_result', callId: r.call.id, name: r.call.name, ok: r.ok, output: r.output })
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
          ? matchRule(settings.permissionRules, call.name, permissionSubject(call.name, call.arguments))
          : null

        if (!tool) {
          output = `Unknown tool: ${call.name}`
          ok = false
        } else if (ruleAction === 'deny') {
          output = 'Denied by a permission rule.'
          ok = false
        } else if (isBlockedByPlan(req.approvalPolicy, tool.kind)) {
          output =
            'Blocked: Houston is in Plan mode (read-only). Do not modify files or run commands. Finish your plan and present it; the user will switch off Plan mode to let you carry it out.'
          ok = false
        } else {
          // A permission rule can force-allow or force-ask; otherwise the policy decides.
          const mustApprove =
            ruleAction === 'allow'
              ? false
              : ruleAction === 'ask'
                ? true
                : needsApproval(req.approvalPolicy, tool.kind, run.override)

          let approved = true
          if (mustApprove) {
            emit({
              type: 'tool_approval',
              callId: call.id,
              name: call.name,
              summary: tool.summarize(call.arguments),
              kind: tool.kind
            })
            const decision = await waitForApproval(run, call.id)
            if (decision === 'always') run.override = true
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
                await recordOriginal(runId, workspace, call.arguments.path)
              }
              emit({ type: 'tool_start', callId: call.id, name: call.name, args: call.arguments })
              try {
                output = await tool.execute(
                  call.arguments,
                  makeToolContext(
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
              // Snapshot the file's final content (after any hook, e.g. a formatter)
              // so the change can be faithfully redone after a revert.
              if (ok && tool.kind === 'write' && typeof call.arguments.path === 'string') {
                await recordResult(runId, workspace, call.arguments.path)
              }
            }
          }
        }

        emit({ type: 'tool_result', callId: call.id, name: call.name, ok, output })
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

    emit({ type: 'done', stopReason: 'end_turn' })
  } finally {
    runs.delete(runId)
  }
}
