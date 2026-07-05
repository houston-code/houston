import { minimatch } from 'minimatch'
import type { Hook } from '@shared/types'
import { runSandboxed, type SandboxRunOptions, type SandboxRunResult } from '../sandbox'

/**
 * Lifecycle hooks: user-configured shell commands that run at points in the agent
 * loop. Every hook is user-authored (configured in Settings, not by the project)
 * and runs inside the same Seatbelt sandbox as run_shell — confined to the
 * workspace, no network — so a buggy hook can't escape the project. Context is
 * passed via HOUSTON_* environment variables (never interpolated into the command,
 * so there's no injection).
 *
 * Events:
 * - PreToolUse: before a tool runs. Can block the call, auto-approve it (skip the
 *   approval prompt), or rewrite its input. Matcher globs the tool name.
 * - PostToolUse: after a tool runs; output is appended to the tool result so the
 *   agent sees it. Matcher globs the tool name.
 * - UserPromptSubmit: when the user submits a message, before the turn runs. Can
 *   block the prompt or inject extra context.
 * - SessionStart: once when a run begins. Can inject extra context (appended to
 *   the system prompt).
 * - Stop: when the agent would end its turn. Blocking forces another turn (the
 *   reason is fed back), e.g. "run the tests before you stop".
 * - PreCompact: before the conversation is compacted. Injected context is folded
 *   into the material being summarized so it survives compaction.
 *
 * Beyond the exit code, a hook may print a single JSON object on stdout to steer
 * the loop (see {@link HookDirective}). A non-JSON stdout is treated as plain
 * feedback, and a non-zero exit still blocks a blocking event — so pre-JSON hooks
 * keep working unchanged.
 */

export type HookEvent = Hook['event']

/** Events tied to a specific tool call; their matcher globs the tool name. */
const TOOL_EVENTS = new Set<HookEvent>(['PreToolUse', 'PostToolUse'])

/** Events a hook can veto — a block stops the action (or, for Stop, forces another turn). */
const BLOCKING_EVENTS = new Set<HookEvent>(['PreToolUse', 'UserPromptSubmit', 'Stop'])

export interface HookContext {
  /** The tool name for Pre/PostToolUse; the event name for lifecycle events. */
  tool: string
  /** The tool's arguments (Pre/PostToolUse); empty for lifecycle events. */
  input: Record<string, unknown>
  /** Present for PostToolUse: the tool's output. */
  result?: string
  /** Present for UserPromptSubmit: the submitted prompt text. */
  prompt?: string
}

/**
 * Hooks for this event whose matcher matches the subject. For tool events the
 * subject is the tool name (glob-matched); lifecycle events have no tool, so only
 * an empty or `*` matcher matches them.
 */
export function matchingHooks(hooks: Hook[] | undefined, event: HookEvent, subject = ''): Hook[] {
  if (!hooks?.length) return []
  const toolEvent = TOOL_EVENTS.has(event)
  return hooks.filter((h) => {
    if (h.event !== event) return false
    const m = (h.matcher ?? '').trim()
    if (!m || m === '*') return true
    if (!toolEvent) return false
    return m === subject || minimatch(subject, m)
  })
}

type Runner = (opts: SandboxRunOptions) => Promise<SandboxRunResult>

function hookEnv(event: HookEvent, ctx: HookContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOUSTON_HOOK_EVENT: event,
    HOUSTON_TOOL_NAME: ctx.tool,
    HOUSTON_TOOL_INPUT: JSON.stringify(ctx.input ?? {})
  }
  if (ctx.result !== undefined) env.HOUSTON_TOOL_RESULT = ctx.result
  if (ctx.prompt !== undefined) env.HOUSTON_USER_PROMPT = ctx.prompt
  return env
}

/** A structured directive a hook may print as a single JSON object on stdout. */
interface HookDirective {
  /** `block` vetoes the action; `approve` (PreToolUse only) skips the approval prompt. */
  decision?: 'block' | 'approve'
  /** Human-readable reason, fed back to the agent (or shown on a block). */
  reason?: string
  /** Extra context to inject into the conversation. */
  additionalContext?: string
  /** Replacement tool arguments (PreToolUse only), applied before the tool runs. */
  updatedInput?: Record<string, unknown>
  /** A note surfaced to the user (not the model). */
  systemMessage?: string
}

/** Parse a hook's stdout as a control directive, or null if it isn't one. */
function parseDirective(stdout: string | undefined): HookDirective | null {
  const trimmed = (stdout ?? '').trim()
  if (!trimmed.startsWith('{')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const d = parsed as Record<string, unknown>
  const out: HookDirective = {}
  if (d.decision === 'block' || d.decision === 'approve') out.decision = d.decision
  if (typeof d.reason === 'string') out.reason = d.reason
  if (typeof d.additionalContext === 'string') out.additionalContext = d.additionalContext
  if (typeof d.systemMessage === 'string') out.systemMessage = d.systemMessage
  if (d.updatedInput && typeof d.updatedInput === 'object' && !Array.isArray(d.updatedInput)) {
    out.updatedInput = d.updatedInput as Record<string, unknown>
  }
  return out
}

export interface HookOutcome {
  /** A blocking event was vetoed (non-zero exit, or `{decision:"block"}`). For Stop, "force another turn". */
  blocked: boolean
  /** A PreToolUse hook explicitly approved the call (and none blocked) — the approval prompt can be skipped. */
  approved: boolean
  /** Combined feedback (directive reasons + plain stdout/stderr) for the agent to see. */
  message: string
  /** Extra context to inject into the conversation (concatenated across hooks). */
  additionalContext?: string
  /** Rewritten tool input (PreToolUse); the last hook that sets it wins. */
  updatedInput?: Record<string, unknown>
  /** A user-facing note (not shown to the model); concatenated across hooks. */
  systemMessage?: string
}

/**
 * Run the hooks matching this event/subject, sequentially, and fold their exit
 * codes and JSON directives into a single {@link HookOutcome}. `run` is injectable
 * for testing.
 */
export async function runHooks(
  hooks: Hook[] | undefined,
  event: HookEvent,
  ctx: HookContext,
  workspace: string,
  signal: AbortSignal,
  run: Runner = runSandboxed
): Promise<HookOutcome> {
  const matched = matchingHooks(hooks, event, ctx.tool)
  if (matched.length === 0) return { blocked: false, approved: false, message: '' }

  const blocking = BLOCKING_EVENTS.has(event)
  const reasons: string[] = []
  const contexts: string[] = []
  const systemMsgs: string[] = []
  let blocked = false
  let approved = false
  let updatedInput: Record<string, unknown> | undefined

  for (const hook of matched) {
    const res = await run({
      command: hook.command,
      cwd: workspace,
      workspace,
      allowNetwork: false,
      signal,
      env: hookEnv(event, ctx)
    })
    const directive = parseDirective(res.stdout)
    if (directive) {
      if (directive.reason) reasons.push(directive.reason)
      if (directive.additionalContext) contexts.push(directive.additionalContext)
      if (directive.systemMessage) systemMsgs.push(directive.systemMessage)
      if (directive.updatedInput) updatedInput = directive.updatedInput
      if (directive.decision === 'block') blocked = true
      else if (directive.decision === 'approve') approved = true
    } else {
      // Backward-compatible plain-text feedback (stdout + stderr).
      const out = [res.stdout?.trimEnd(), res.stderr?.trimEnd()].filter(Boolean).join('\n').trim()
      if (out) reasons.push(out)
    }
    // A non-zero exit still blocks a blocking event, regardless of any directive.
    if (blocking && res.exitCode !== 0) blocked = true
  }

  // A block always wins over an approve.
  if (blocked) approved = false

  return {
    blocked,
    approved,
    message: reasons.join('\n').trim(),
    ...(contexts.length ? { additionalContext: contexts.join('\n\n') } : {}),
    ...(updatedInput ? { updatedInput } : {}),
    ...(systemMsgs.length ? { systemMessage: systemMsgs.join('\n') } : {})
  }
}
