import type { ChatMessage, Provider, TokenUsage } from '@shared/agent'
import { getTool, type ToolContext } from './tools'
import type { ShellSession } from './shell-session'
import { isSandboxed } from '../sandbox'

/**
 * A nested subagent: the main agent delegates a scoped task to a fresh loop with
 * its own context, which investigates (and, when writable, acts) and returns a
 * synthesized report.
 *
 * Two tiers:
 * - Read-only (default): reads the project with the read tools, no approvals,
 *   can't change anything or leave the machine — the parent does any writing.
 * - Writable (opt-in): additionally edits files (workspace-root contained in JS) and,
 *   where the host has an OS sandbox, runs shell commands confined to the project with
 *   no network. On a host with no OS sandbox, run_shell is refused — a background
 *   subagent can't prompt for the consent an unconfined command needs — so it is
 *   edits-only there. The parent grants this by approving the dispatch_writable_agent
 *   call; the subagent then works autonomously, so its individual tool calls need no
 *   further prompts.
 */

/** Tools any subagent may use — local, read-only, no network egress. */
export const SUBAGENT_TOOLS = ['read_file', 'list_dir', 'glob', 'search_files', 'ast_grep'] as const

/** Extra tools a WRITABLE subagent may use — edits + sandboxed shell (still no network). */
export const SUBAGENT_WRITE_TOOLS = [
  'write_file',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'run_shell'
] as const

/**
 * Resolve the tool names a subagent may use. The base set is read-only, plus the
 * write/shell tools when `writable`. A custom agent's declared `tools` can only
 * *narrow* that base — any name outside it is dropped, and an absent/empty list
 * falls back to the full base. So a read-only agent can never gain write tools, and
 * a writable agent can restrict itself but not reach past the sandboxed set.
 */
function resolveSubAgentTools(allowed: string[] | undefined, writable: boolean): readonly string[] {
  const base: readonly string[] = writable
    ? [...SUBAGENT_TOOLS, ...SUBAGENT_WRITE_TOOLS]
    : SUBAGENT_TOOLS
  if (!allowed?.length) return base
  const narrowed = base.filter((t) => allowed.includes(t))
  return narrowed.length ? narrowed : base
}

const MAX_SUBAGENT_ITERATIONS = 16
const SUBAGENT_MAX_TOKENS = 4096

/** Tier-specific constraints + reporting contract, shared by the default and custom agents. */
function subAgentConstraints(workspace: string, writable: boolean, shellSandboxed: boolean): string {
  let capabilities: string
  if (!writable) {
    capabilities = `You are working inside the project at ${workspace}. You can only READ: read_file, list_dir, glob, search_files, ast_grep. You cannot edit files, run commands, or access the network.`
  } else if (shellSandboxed) {
    capabilities = `You are working inside the project at ${workspace}. You can READ (read_file, list_dir, glob, search_files, ast_grep) and make CHANGES: edit files (write_file, edit_file, multi_edit, apply_patch) and run shell commands (run_shell). All of it is confined to the project sandbox with no network access — you cannot reach outside the workspace or the internet.`
  } else {
    // No OS sandbox on this host, so run_shell is refused for a subagent (see runSubAgent):
    // a background subagent can't prompt for the consent an unconfined command needs.
    capabilities = `You are working inside the project at ${workspace}. You can READ (read_file, list_dir, glob, search_files, ast_grep) and EDIT files (write_file, edit_file, multi_edit, apply_patch), confined to the project with no network. This host has no OS sandbox, so run_shell is NOT available to you — make the edits you can and note in your report anything that still needs a command run (the main agent can run it with approval).`
  }
  return `${capabilities}

Your final message is your entire report back to the calling agent — make it self-contained: include the concrete outcome (what you found or changed, file paths, key code) it needs, not a narration of your steps. Be concise.`
}

function subAgentSystemPrompt(workspace: string, writable: boolean, shellSandboxed: boolean): string {
  const role = writable
    ? `You are an implementation subagent. Another agent has delegated a focused task to you. Carry it out end to end — make the edits and run the commands needed — then report what you did.`
    : `You are a research subagent. Another agent has delegated a focused question to you. Investigate efficiently, then answer it directly.`
  return `${role}

${subAgentConstraints(workspace, writable, shellSandboxed)}`
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
   * Whether the host OS-confines shell execution. Defaults to the live sandbox status.
   * When false, the writable tier's `run_shell` is refused (a background subagent can't
   * prompt for the consent an unconfined command requires); injected for testing.
   */
  shellSandboxed?: boolean
  /** Persistent shell state for run_shell (writable tier). */
  shellSession?: ShellSession
  /** Cap on a single shell command's output kept in a tool result. */
  shellOutputMaxBytes?: number
  /** Called with each turn's token usage, so callers (e.g. a review) can total cost. */
  onUsage?: (usage: TokenUsage) => void
}

/** Run a subagent loop to completion and return its final report text. */
export async function runSubAgent(opts: SubAgentOptions): Promise<string> {
  const { provider, model, workspace, prompt, signal } = opts
  const writable = opts.writable === true
  // Whether this host OS-confines shell. When it doesn't, a writable subagent's
  // run_shell is refused below: unlike the main loop it can't surface a per-call
  // approval, and the main loop never runs an UNCONFINED shell command without one.
  const shellSandboxed = opts.shellSandboxed ?? isSandboxed()
  const allowedTools = resolveSubAgentTools(opts.tools, writable)
  const allowedToolSet = new Set<string>(allowedTools)
  const tools = allowedTools.map((name) => getTool(name)!.schema)
  // A custom agent's prompt still gets the tier constraints appended.
  const system = opts.systemOverride
    ? `${opts.systemOverride}\n\n${subAgentConstraints(workspace, writable, shellSandboxed)}`
    : subAgentSystemPrompt(workspace, writable, shellSandboxed)
  // Tool-execution context. Reads default their roots to [workspace]; the writable
  // tier passes the real roots (for edits) and a shell session, and never allows
  // network — so run_shell stays sandboxed with no egress. NOTE: a confined shell can
  // still READ outside the workspace (the sandbox is a write/network jail, not a read
  // one). We accept that here: with allowNetwork:false the subagent has no egress, so a
  // read can't leave the machine, and its file writes stay contained to `roots`.
  const toolCtx: ToolContext = {
    workspace,
    roots: opts.roots ?? [workspace],
    allowNetwork: false,
    signal,
    ...(opts.shellSession ? { shellSession: opts.shellSession } : {}),
    ...(opts.shellOutputMaxBytes ? { shellOutputMaxBytes: opts.shellOutputMaxBytes } : {})
  }
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }]
  let lastText = ''

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

    if (calls.length === 0) return text.trim() || '[subagent returned no answer]'

    for (const call of calls) {
      const tool = allowedToolSet.has(call.name) ? getTool(call.name) : undefined
      let output: string
      if (!tool) {
        output = writable
          ? `Tool not available to this subagent: ${call.name}`
          : `Tool not available to a read-only subagent: ${call.name}`
      } else if (call.name === 'run_shell' && !shellSandboxed) {
        // Fail closed: on a host with no OS sandbox the command would run UNCONFINED,
        // and a background subagent can't surface the approval the main loop requires
        // for that. Refuse it here; the subagent can still edit files (path-contained
        // in JS on every OS) and report what still needs a command run.
        output =
          'run_shell is unavailable to a subagent on this host: it has no OS-enforced sandbox, so the ' +
          'command would run unconfined, and a background subagent cannot prompt for the required consent. ' +
          'Make the edits you can and note what still needs a command; the main agent can run it with approval.'
      } else {
        try {
          output = await tool.execute(call.arguments, toolCtx)
        } catch (e) {
          output = `Error: ${(e as Error).message}`
        }
      }
      messages.push({ role: 'tool', content: output, toolCallId: call.id, toolName: call.name })
    }
  }

  return lastText.trim() || '[subagent reached its step limit without a final answer]'
}
