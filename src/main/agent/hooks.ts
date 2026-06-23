import { minimatch } from 'minimatch'
import type { Hook } from '@shared/types'
import { runSandboxed, type SandboxRunOptions, type SandboxRunResult } from '../sandbox'

/**
 * Tool-use hooks: user-configured shell commands that run around every tool call.
 *
 * - PreToolUse runs before the tool. A non-zero exit BLOCKS the call (the hook's
 *   output is fed back to the agent as the reason) — e.g. forbid edits to a path,
 *   or require a clean lint first.
 * - PostToolUse runs after the tool; its output is appended to the tool result so
 *   the agent sees it — e.g. auto-format the file, or run the tests.
 *
 * Hooks are user-authored (configured in Settings, not by the project) but still
 * run inside the same Seatbelt sandbox as run_shell — confined to the workspace,
 * no network — so a buggy hook can't escape the project. The tool call's context
 * is passed via HOUSTON_* environment variables (never interpolated into the
 * command, so there's no injection).
 */

export type HookEvent = Hook['event']

export interface HookContext {
  tool: string
  input: Record<string, unknown>
  /** Present for PostToolUse: the tool's output. */
  result?: string
}

/** Hooks for this event whose matcher matches the tool name. */
export function matchingHooks(hooks: Hook[] | undefined, event: HookEvent, tool: string): Hook[] {
  if (!hooks?.length) return []
  return hooks.filter((h) => {
    if (h.event !== event) return false
    const m = (h.matcher ?? '').trim()
    if (!m || m === '*') return true
    return m === tool || minimatch(tool, m)
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
  return env
}

export interface HookOutcome {
  /** True if a PreToolUse hook blocked the call (non-zero exit). */
  blocked: boolean
  /** Combined hook output (stdout/stderr), for the agent to see. */
  message: string
}

/**
 * Run the hooks matching this event/tool, sequentially. For PreToolUse, a non-zero
 * exit blocks the call. `run` is injectable for testing.
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
  if (matched.length === 0) return { blocked: false, message: '' }

  const parts: string[] = []
  let blocked = false

  for (const hook of matched) {
    const res = await run({
      command: hook.command,
      cwd: workspace,
      workspace,
      allowNetwork: false,
      signal,
      env: hookEnv(event, ctx)
    })
    const out = [res.stdout?.trimEnd(), res.stderr?.trimEnd()].filter(Boolean).join('\n').trim()
    if (out) parts.push(out)
    if (event === 'PreToolUse' && res.exitCode !== 0) blocked = true
  }

  return { blocked, message: parts.join('\n').trim() }
}
