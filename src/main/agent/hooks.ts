import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { minimatch } from 'minimatch'
import type { Hook } from '@shared/types'
import { runSandboxed, type SandboxRunOptions, type SandboxRunResult } from '../sandbox'

/**
 * Lifecycle hooks: shell commands that run at points in the agent loop. They come
 * from the user's Settings and, once the user trusts the folder, from the project's
 * `.houston/settings.json` (see projectConfig.ts; the loop runs those after the
 * user's). Every hook runs through the same sandbox backend as run_shell (confined
 * to the workspace, no network, where the host's backend confines at all), so a
 * buggy hook can't escape the project there. Context is
 * passed via HOUSTON_* environment variables (never interpolated into the command,
 * so there's no injection). A payload too large for an environment variable is
 * written to a private temp file instead, named by the matching `*_FILE` variable
 * (see {@link prepareHookEnv}).
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

/**
 * Largest payload, in bytes, passed directly in an environment variable. The OS caps
 * them: Linux refuses any single variable over 128 KB, macOS refuses the whole
 * environment past about 1 MB, and Windows caps a variable at 32,767 characters.
 * Past those, the hook couldn't even be launched (`spawn E2BIG`), so a large write or
 * a long pasted prompt failed every matching hook. Kept well below all three, with
 * room for several payloads and the inherited environment.
 */
export const HOOK_ENV_PAYLOAD_MAX_BYTES = 16 * 1024

/** The payload variables, each with a `*_FILE` twin used when the payload is large. */
const PAYLOAD_VARS = ['HOUSTON_TOOL_INPUT', 'HOUSTON_TOOL_RESULT', 'HOUSTON_USER_PROMPT'] as const

/** A hook's environment, plus the cleanup for any payload files it references. */
interface PreparedHookEnv {
  env: NodeJS.ProcessEnv
  cleanup: () => Promise<void>
}

/**
 * Build the environment a hook runs with. Each payload (the tool input as JSON, the
 * tool result, the submitted prompt) is passed in its variable when it fits in
 * {@link HOOK_ENV_PAYLOAD_MAX_BYTES}. A larger one is written to a file in a private
 * temp directory (0700, the file 0600) and `<VAR>_FILE` names it, with `<VAR>` left
 * unset, so a hook reads whichever of the two is present. The temp dir is under the
 * OS temp dir, which every sandbox backend can read. Call `cleanup` once the hooks
 * have run. Exported for testing.
 */
export async function prepareHookEnv(event: HookEvent, ctx: HookContext): Promise<PreparedHookEnv> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOUSTON_HOOK_EVENT: event,
    HOUSTON_TOOL_NAME: ctx.tool
  }
  // Never pass along a payload inherited from the environment Houston itself was
  // launched with: a hook must only ever see this call's values.
  for (const name of PAYLOAD_VARS) {
    delete env[name]
    delete env[`${name}_FILE`]
  }
  const payloads: [(typeof PAYLOAD_VARS)[number], string][] = [
    ['HOUSTON_TOOL_INPUT', JSON.stringify(ctx.input ?? {})]
  ]
  if (ctx.result !== undefined) payloads.push(['HOUSTON_TOOL_RESULT', ctx.result])
  if (ctx.prompt !== undefined) payloads.push(['HOUSTON_USER_PROMPT', ctx.prompt])

  let dir: string | null = null
  const cleanup = async (): Promise<void> => {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  try {
    for (const [name, value] of payloads) {
      if (Buffer.byteLength(value, 'utf8') <= HOOK_ENV_PAYLOAD_MAX_BYTES) {
        env[name] = value
        continue
      }
      dir ??= await fs.mkdtemp(join(tmpdir(), 'houston-hook-'))
      const file = join(dir, `${name.toLowerCase()}.txt`)
      await fs.writeFile(file, value, { encoding: 'utf8', mode: 0o600 })
      env[`${name}_FILE`] = file
    }
  } catch (e) {
    await cleanup()
    throw e
  }
  return { env, cleanup }
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

  // A hook that can't be given its input, or can't be launched, never throws out of
  // here (that ended the whole turn). It counts as a failed hook instead: a blocking
  // event fails closed, so a guard hook that couldn't run never lets the action through.
  const failure = (what: string, e: unknown): HookOutcome => ({
    blocked: blocking,
    approved: false,
    message: `${what}: ${e instanceof Error ? e.message : String(e)}`
  })

  let prepared: PreparedHookEnv
  try {
    prepared = await prepareHookEnv(event, ctx)
  } catch (e) {
    return failure('Could not pass the hook its input', e)
  }

  try {
    for (const hook of matched) {
      let res: SandboxRunResult
      try {
        res = await run({
          command: hook.command,
          cwd: workspace,
          workspace,
          allowNetwork: false,
          signal,
          env: prepared.env
        })
      } catch (e) {
        if (blocking) blocked = true
        // The command itself stays out of the message: it can hold a token, and this
        // text can reach an error the user sees.
        reasons.push(`A ${event} hook could not be started: ${e instanceof Error ? e.message : String(e)}`)
        continue
      }
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
  } finally {
    await prepared.cleanup()
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
