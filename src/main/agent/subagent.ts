import type { ChatMessage, Provider, TokenUsage } from '@shared/agent'
import { getTool, type ToolContext } from './tools'
import { recordOriginal, recordResult, writeTargets } from './checkpoints'
import type { ShellSession } from './shell-session'
import { isSandboxed } from '../sandbox'

/**
 * A nested subagent: the main agent delegates a scoped task to a fresh loop with
 * its own context, which investigates (and, when writable, acts) and returns a
 * synthesized report.
 *
 * Two tiers:
 * - Read-only (default): reads the project with the read tools, no approvals,
 *   can't change anything — the parent does any writing.
 * - Writable (opt-in): additionally edits files (workspace-root contained in JS) and,
 *   where the host has an OS sandbox, runs shell commands confined to the project with
 *   no shell egress. On a host with no OS sandbox a command would run unconfined, which
 *   always needs the user's per-command consent: a dispatcher that can surface an
 *   approval prompt wires `gateUnconfinedShell` and each run_shell call is propagated
 *   to the user (the main loop routes it to the UI as a normal tool approval); without
 *   the gate, run_shell is refused — fail closed. The parent grants the tier by
 *   approving the dispatch_writable_agent call; every other LOCAL tool call then runs
 *   autonomously without further prompts.
 *
 * Orthogonal to the tier, the dispatcher may also grant network access (`opts.network`):
 * it offers web_fetch/web_search and routes EVERY call through a per-destination
 * consent gate — the same prompts, rules, and grants as the main agent's own network
 * calls. Without it, subagents are local-only. A subagent's SHELL commands never get
 * network, whatever the tier.
 */

/** Tools any subagent may use — local, read-only, no network egress. */
export const SUBAGENT_TOOLS = ['read_file', 'list_dir', 'glob', 'search_files', 'ast_grep'] as const

/** Extra tools a WRITABLE subagent may use — edits + sandboxed shell (still no shell egress). */
export const SUBAGENT_WRITE_TOOLS = [
  'write_file',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'run_shell'
] as const

/**
 * Network tools a subagent may use — offered ONLY when the dispatcher wires the
 * `network` consent seam, since every call is propagated to the user for
 * per-destination approval. Deliberately excludes view_localhost (needs the
 * Electron capture backend) and the GitHub tools (remote/PR state stays the main
 * agent's job).
 */
export const SUBAGENT_NETWORK_TOOLS = ['web_fetch', 'web_search'] as const

/**
 * Resolve the tool names a subagent may use. The base set is read-only, plus the
 * write/shell tools when `writable` and the web tools when the dispatcher wired
 * network consent. A custom agent's declared `tools` can only *narrow* that base —
 * any name outside it is dropped, and an absent/empty list falls back to the full
 * base. So a read-only agent can never gain write tools, and no agent can reach
 * past what its dispatcher granted.
 *
 * A declared list that names something but nothing in the tier's base (e.g. only
 * unrecognized names) fails CLOSED to the read-only tools — never back to the full
 * write+shell base — so a typo'd or stale `tools:` list can't silently grant MORE
 * privilege than it named, the opposite of the author's narrowing intent.
 */
function resolveSubAgentTools(
  allowed: string[] | undefined,
  writable: boolean,
  network: boolean
): readonly string[] {
  const base: readonly string[] = [
    ...SUBAGENT_TOOLS,
    ...(writable ? SUBAGENT_WRITE_TOOLS : []),
    ...(network ? SUBAGENT_NETWORK_TOOLS : [])
  ]
  if (!allowed?.length) return base
  const narrowed = base.filter((t) => allowed.includes(t))
  return narrowed.length ? narrowed : SUBAGENT_TOOLS
}

const MAX_SUBAGENT_ITERATIONS = 16
const SUBAGENT_MAX_TOKENS = 4096

/**
 * How deep dispatches may nest: the main agent (depth 0) can dispatch subagents
 * (depth 1), which can dispatch their own read-only researchers (depth 2), and
 * that's the floor — a depth-2 agent gets no dispatch tool. Enforced by the loop,
 * which only injects `dispatchNested` for agents above the floor.
 */
export const MAX_SUBAGENT_DEPTH = 2

/** Tier-specific constraints + reporting contract, shared by the default and custom agents. */
function subAgentConstraints(
  workspace: string,
  writable: boolean,
  shellSandboxed: boolean,
  shellGated: boolean,
  network: boolean
): string {
  let capabilities: string
  if (!writable) {
    capabilities = `You are working inside the project at ${workspace}. You can only READ: read_file, list_dir, glob, search_files, ast_grep. You cannot edit files or run commands.`
  } else if (shellSandboxed) {
    capabilities = `You are working inside the project at ${workspace}. You can READ (read_file, list_dir, glob, search_files, ast_grep) and make CHANGES: edit files (write_file, edit_file, multi_edit, apply_patch) and run shell commands (run_shell). Edits and commands are confined to the project sandbox — you cannot write outside the workspace, and your shell commands cannot reach the network.`
  } else if (shellGated) {
    // No OS sandbox, but the dispatcher wired a consent gate: each command is
    // propagated to the user as an approval prompt before it runs unconfined.
    capabilities = `You are working inside the project at ${workspace}. You can READ (read_file, list_dir, glob, search_files, ast_grep) and make CHANGES: edit files (write_file, edit_file, multi_edit, apply_patch), confined to the project, and run shell commands (run_shell, which cannot reach the network). This host has no OS sandbox, so EACH run_shell command first asks the user for approval — that happens automatically when you call it, and a denial comes back as the tool result. Prefer edits over commands, batch related commands into one call where reasonable, and if a command is denied do not retry it: work around it or note it in your report.`
  } else {
    // No OS sandbox and no consent gate, so run_shell is refused (see runSubAgent):
    // without a gate a background subagent can't prompt for the consent an
    // unconfined command needs.
    capabilities = `You are working inside the project at ${workspace}. You can READ (read_file, list_dir, glob, search_files, ast_grep) and EDIT files (write_file, edit_file, multi_edit, apply_patch), confined to the project. This host has no OS sandbox, so run_shell is NOT available to you — make the edits you can and note in your report anything that still needs a command run (the main agent can run it with approval).`
  }
  const egress = network
    ? `You can also fetch public URLs with web_fetch and search the web with web_search. EACH network request first asks the user for approval (automatically, when you call the tool) unless they already granted that destination — a denial comes back as the tool result; do not retry a denied request.`
    : `You have no network access.`
  return `${capabilities} ${egress}

Your final message is your entire report back to the calling agent — make it self-contained: include the concrete outcome (what you found or changed, file paths, key code) it needs, not a narration of your steps. Be concise.`
}

function subAgentSystemPrompt(
  workspace: string,
  writable: boolean,
  shellSandboxed: boolean,
  shellGated: boolean,
  network: boolean
): string {
  const role = writable
    ? `You are an implementation subagent. Another agent has delegated a focused task to you. Carry it out end to end — make the edits and run the commands needed — then report what you did.`
    : `You are a research subagent. Another agent has delegated a focused question to you. Investigate efficiently, then answer it directly.`
  return `${role}

${subAgentConstraints(workspace, writable, shellSandboxed, shellGated, network)}`
}

export interface SubAgentOptions {
  provider: Provider
  model: string
  workspace: string
  /** The task/question delegated to the subagent. */
  prompt: string
  signal: AbortSignal
  /** A custom agent's system prompt to use instead of the default one. */
  systemOverride?: string
  /**
   * A custom agent's declared tool allow-list. Intersected with the tier's tools,
   * so it can only narrow the set, never expand it. Absent/empty => the full tier.
   */
  tools?: string[]
  /**
   * Grant the write tier: the subagent may edit files and run shell commands
   * (sandboxed, no network). Default false keeps it read-only.
   */
  writable?: boolean
  /** Allowed roots for edits (workspace + added dirs). Defaults to [workspace]. */
  roots?: string[]
  /**
   * Record the subagent's file edits in this run's checkpoint (the dispatching
   * turn's), so reverting/redoing the parent turn covers delegated changes too.
   * Absent => edits aren't checkpointed (read-only tiers have nothing to record).
   */
  checkpointRunId?: string
  /**
   * Whether the host OS-confines shell execution. Defaults to the live sandbox status.
   * When false, the writable tier's `run_shell` needs per-command consent: it is routed
   * through `gateUnconfinedShell` when wired, and refused otherwise. Injected for testing.
   */
  shellSandboxed?: boolean
  /**
   * Per-command consent seam for `run_shell` on a host with NO OS sandbox, where the
   * command would run unconfined. Wired by a dispatcher that can surface an approval
   * prompt (the main loop propagates it to the user as a normal tool approval). Called
   * with the call's arguments and a thunk that executes it; resolves with the
   * tool-result text — the command's output when consent was given (the gate runs the
   * thunk), or a refusal note when it wasn't. Absent => run_shell is refused on such
   * hosts (fail closed: a dispatcher that can't prompt can't consent). Never consulted
   * on a confining host.
   */
  gateUnconfinedShell?: (
    args: Record<string, unknown>,
    run: () => Promise<string>
  ) => Promise<string>
  /**
   * Network access, granted only by a dispatcher that can surface approval prompts.
   * Presence offers {@link SUBAGENT_NETWORK_TOOLS} and routes EVERY call to them
   * through `gate`, which propagates it to the user for per-destination consent
   * (the loop mirrors its own network gating: deny rules refuse without a prompt,
   * an allow rule or an already-granted destination skips it, and a denial comes
   * back as the tool result). `getSecret`/`searchProvider` feed web_search its key;
   * `collectSecrets` feeds egress credential masking, so a subagent fetch refuses
   * to transmit a stored secret exactly like the main loop's. Absent => no network
   * tools are offered and the tiers stay local-only (fail closed: a dispatcher that
   * can't prompt can't consent).
   */
  network?: {
    gate: (
      name: string,
      args: Record<string, unknown>,
      run: () => Promise<string>
    ) => Promise<string>
    getSecret?: (id: string) => string | null
    searchProvider?: string
    collectSecrets?: () => string[]
  }
  /** Persistent shell state for run_shell (writable tier). */
  shellSession?: ShellSession
  /** Cap on a single shell command's output kept in a tool result. */
  shellOutputMaxBytes?: number
  /**
   * Scrub secrets from each tool output before it enters the subagent's transcript
   * (which ships to the provider on the next iteration) — the same seam the main
   * loop's flushResult covers for its own tool results. Because the model never
   * receives the plaintext, the subagent's report is transitively clean too. The
   * loop wires its run-scoped redactor (see redact.ts) here; defaults to identity.
   */
  redact?: (text: string) => string
  /** Called with each turn's token usage, so callers (e.g. a review) can total cost. */
  onUsage?: (usage: TokenUsage) => void
  /**
   * Send `cache_control` breakpoints on OpenAI-compatible requests (see
   * `ChatRequest.explicitCacheControl`). The caller gates this per route; a
   * subagent loop re-reads its prefix every iteration, so it benefits the same
   * way the main loop does.
   */
  explicitCacheControl?: boolean
  /**
   * Called with a short line per step (turn counter + what the tool is doing) so
   * the caller can surface live progress — without it, a long dispatch is silent
   * until its final report and reads as a stall in the parent's UI.
   */
  onProgress?: (message: string) => void
  /**
   * Resume: the transcript of a previous run of this agent. `prompt` is appended
   * as the next user turn, so the agent answers the follow-up with its earlier
   * context (files it read, conclusions it reached) intact.
   */
  priorMessages?: ChatMessage[]
  /**
   * Called with the complete message log when the run ends cleanly (final answer,
   * or step limit — both leave every tool call paired with its result). The caller
   * stores it to make the agent resumable. NOT called after an abort or provider
   * error, whose transcript may end mid-tool-call and can't be replayed into a
   * provider request.
   */
  onTranscript?: (messages: ChatMessage[]) => void
  /**
   * Dispatch a nested read-only research subagent (injected by the loop, which
   * enforces {@link MAX_SUBAGENT_DEPTH}). When present, the `dispatch_agent` tool
   * is offered to this subagent so it can fan out focused sub-searches; always
   * read-only regardless of this agent's own tier, so nesting never widens write
   * authority.
   */
  dispatchNested?: (prompt: string, agentName?: string, model?: string) => Promise<string>
}

/** Run a subagent loop to completion and return its final report text. */
export async function runSubAgent(opts: SubAgentOptions): Promise<string> {
  const { provider, model, workspace, prompt, signal } = opts
  const writable = opts.writable === true
  // Whether this host OS-confines shell. When it doesn't, an unconfined command
  // never runs without the user's consent — the main loop's invariant. A dispatcher
  // that can surface an approval prompt wires gateUnconfinedShell to obtain that
  // consent per command; without the gate, run_shell is refused below (fail closed).
  const shellSandboxed = opts.shellSandboxed ?? isSandboxed()
  const shellGated = !shellSandboxed && opts.gateUnconfinedShell !== undefined
  const network = opts.network !== undefined
  const redact = opts.redact ?? ((t: string): string => t)
  const allowedTools = resolveSubAgentTools(opts.tools, writable, network)
  const allowedToolSet = new Set<string>(allowedTools)
  const tools = allowedTools.map((name) => getTool(name)!.schema)
  // Nested dispatch: offered as a separate capability, not part of the narrowable
  // tier base, so a custom agent's `tools:` list can't accidentally strip it and
  // — more importantly — can never *grant* it (only the loop injects the handler,
  // which enforces the depth cap and the read-only nested tier).
  if (opts.dispatchNested) tools.push(getTool('dispatch_agent')!.schema)
  // A custom agent's prompt still gets the tier constraints appended.
  let system = opts.systemOverride
    ? `${opts.systemOverride}\n\n${subAgentConstraints(workspace, writable, shellSandboxed, shellGated, network)}`
    : subAgentSystemPrompt(workspace, writable, shellSandboxed, shellGated, network)
  if (opts.dispatchNested) {
    system += `\n\nYou may also delegate a focused read-only sub-search to your own nested subagent via dispatch_agent — useful to explore several areas in parallel without filling your context. Nested agents are always read-only and cannot dispatch further.`
  }
  // Tool-execution context. Reads default their roots to [workspace]; the writable
  // tier passes the real roots (for edits) and a shell session. `allowNetwork` stays
  // false: it is the SHELL sandbox's egress switch, and a subagent's commands never
  // get network — web egress goes only through the consent-gated network tools.
  // NOTE: a confined shell can still READ outside the workspace (the sandbox is a
  // write/network jail, not a read one). We accept that here: without shell egress a
  // read can't leave the machine, its file writes stay contained to `roots`, and the
  // web tools mask credentials on the way out (see collectSecrets).
  const roots = opts.roots ?? [workspace]
  const toolCtx: ToolContext = {
    workspace,
    roots,
    allowNetwork: false,
    signal,
    ...(opts.shellSession ? { shellSession: opts.shellSession } : {}),
    ...(opts.shellOutputMaxBytes ? { shellOutputMaxBytes: opts.shellOutputMaxBytes } : {}),
    // Network-tool plumbing (web_search key lookup, egress credential masking) —
    // only meaningful when the network tools are offered at all.
    ...(opts.network?.getSecret ? { getSecret: opts.network.getSecret } : {}),
    ...(opts.network?.searchProvider ? { searchProvider: opts.network.searchProvider } : {}),
    ...(opts.network?.collectSecrets ? { collectSecrets: opts.network.collectSecrets } : {})
  }
  // A resumed agent continues its prior transcript; the new prompt is the next
  // user turn. Copied so the caller's stored transcript isn't mutated mid-run.
  const messages: ChatMessage[] = opts.priorMessages
    ? [...opts.priorMessages, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }]
  let lastText = ''

  // Clean-completion exit: hand the transcript back (for resumability) and return.
  const finish = (text: string): string => {
    opts.onTranscript?.(messages)
    return text
  }

  // One live-progress line per tool call, reusing each tool's summarize() label
  // (the same short form the main transcript shows) plus a turn counter so the
  // parent UI shows both what the agent is doing and how far along it is.
  const progress = (iter: number, call: { name: string; arguments: Record<string, unknown> }): void => {
    if (!opts.onProgress) return
    let label: string
    try {
      label = getTool(call.name)?.summarize(call.arguments) ?? call.name
    } catch {
      label = call.name
    }
    opts.onProgress(`turn ${iter + 1}/${MAX_SUBAGENT_ITERATIONS} · ${label}`)
  }

  for (let iter = 0; iter < MAX_SUBAGENT_ITERATIONS; iter++) {
    if (signal.aborted) return lastText.trim() || '[subagent aborted]'

    let text = ''
    const calls: { id: string; name: string; arguments: Record<string, unknown> }[] = []
    try {
      for await (const ev of provider.streamChat({
        model,
        system,
        messages,
        tools,
        maxTokens: SUBAGENT_MAX_TOKENS,
        ...(opts.explicitCacheControl ? { explicitCacheControl: true } : {}),
        signal
      })) {
        if (ev.type === 'text') text += ev.text
        else if (ev.type === 'tool_call') calls.push(ev.call)
        else if (ev.type === 'done') {
          if (ev.usage) opts.onUsage?.(ev.usage)
        } else if (ev.type === 'error') return `[subagent error: ${ev.message}]`
      }
    } catch (e) {
      if (signal.aborted) return lastText.trim() || '[subagent aborted]'
      return `[subagent error: ${(e as Error).message}]`
    }

    if (text.trim()) lastText = text
    messages.push({ role: 'assistant', content: text, ...(calls.length ? { toolCalls: calls } : {}) })

    if (calls.length === 0) return finish(text.trim() || '[subagent returned no answer]')

    for (const call of calls) {
      progress(iter, call)
      const tool = allowedToolSet.has(call.name) ? getTool(call.name) : undefined
      let output: string
      if (call.name === 'dispatch_agent' && opts.dispatchNested) {
        // Nested dispatch is handled here (not via toolCtx) so the loop's injected
        // handler — which carries the depth cap and the read-only nested tier —
        // is the only path to it.
        const nestedPrompt =
          typeof call.arguments.prompt === 'string' ? call.arguments.prompt.trim() : ''
        const agentName =
          typeof call.arguments.agent === 'string' && call.arguments.agent
            ? call.arguments.agent
            : undefined
        const nestedModel =
          typeof call.arguments.model === 'string' && call.arguments.model
            ? call.arguments.model
            : undefined
        if (call.arguments.resume !== undefined && call.arguments.resume !== null) {
          output =
            'resume is not available from within a subagent — dispatch a fresh nested agent instead.'
        } else if (!nestedPrompt) {
          output = 'prompt is required.'
        } else {
          output = await opts.dispatchNested(nestedPrompt, agentName, nestedModel)
        }
      } else if (!tool) {
        output = writable
          ? `Tool not available to this subagent: ${call.name}`
          : `Tool not available to a read-only subagent: ${call.name}`
      } else if (call.name === 'run_shell' && !shellSandboxed) {
        // On a host with no OS sandbox the command would run UNCONFINED, which the
        // main loop never does without the user's consent. With a gate wired, ask:
        // the dispatcher surfaces the approval prompt and runs the thunk only on a
        // yes (the gate's resolution — output or refusal — is the tool result).
        // Without a gate, fail closed: refuse the command; the subagent can still
        // edit files (path-contained in JS on every OS) and report what remains.
        if (opts.gateUnconfinedShell) {
          try {
            output = await opts.gateUnconfinedShell(call.arguments, () =>
              tool.execute(call.arguments, toolCtx)
            )
          } catch (e) {
            output = `Error: ${(e as Error).message}`
          }
        } else {
          output =
            'run_shell is unavailable to a subagent on this host: it has no OS-enforced sandbox, so the ' +
            'command would run unconfined, and a background subagent cannot prompt for the required consent. ' +
            'Make the edits you can and note what still needs a command; the main agent can run it with approval.'
        }
      } else if (tool.kind === 'network') {
        // Every network call is egress and goes through the dispatcher's consent
        // gate — per destination, mirroring the main loop. The tool is only offered
        // when opts.network is wired, but a model may still name it unprompted;
        // without a gate there is no way to ask, so refuse (fail closed).
        if (opts.network) {
          try {
            output = await opts.network.gate(call.name, call.arguments, () =>
              tool.execute(call.arguments, toolCtx)
            )
          } catch (e) {
            output = `Error: ${(e as Error).message}`
          }
        } else {
          output = `Tool not available to this subagent: ${call.name} (no network access).`
        }
      } else {
        // Snapshot write targets into the dispatching turn's checkpoint, exactly
        // as the main loop does for its own write tools, so "revert" covers the
        // subagent's edits. (Shell side effects aren't checkpointed here — the
        // main loop doesn't checkpoint run_shell either.)
        const cpRunId = tool.kind === 'write' ? opts.checkpointRunId : undefined
        const targets = cpRunId ? writeTargets(call.name, call.arguments) : []
        for (const t of targets) await recordOriginal(cpRunId!, roots, t.path)
        try {
          output = await tool.execute(call.arguments, toolCtx)
          for (const t of targets) {
            await recordResult(cpRunId!, roots, t.path, { expectAbsent: t.deleted })
          }
        } catch (e) {
          output = `Error: ${(e as Error).message}`
        }
      }
      // Strip secrets here at the single choke point every tool output passes through
      // (execution results, errors, and refusal notes alike) — mirroring the main
      // loop's flushResult — so the provider never sees the plaintext.
      messages.push({ role: 'tool', content: redact(output), toolCallId: call.id, toolName: call.name })
    }
  }

  return finish(lastText.trim() || '[subagent reached its step limit without a final answer]')
}
