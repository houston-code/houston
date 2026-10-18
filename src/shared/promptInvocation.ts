/**
 * Turns whose text Houston wrote, not the user.
 *
 * `/review`, the Changes panel's ship button, `/agent`, and a session the agent
 * spawned all send a long, instruction-shaped prompt as the user turn. Shown
 * verbatim that prompt reads as something the user typed and pushes the actual
 * work off screen, so the turn carries an `invokedAs` record of what the user
 * actually did ("/review", "Create PR") and the clients render that instead, with
 * the prompt one click away. The prompt itself is still what the model receives.
 *
 * Every first-party prompt goes through one of the constructors below, which is
 * what keeps a new built-in template command or ship action covered without
 * anyone remembering to tag it. `promptVisibility.guard.test.ts` fails when a new
 * send path appears that bypasses them.
 */
import { agentInvocationPrompt, expandTemplate, parseAgentInvocation, type Command } from './commands'
import type { ShipAction } from './shipAction'

export type PromptInvocationKind = 'command' | 'action' | 'spawned'

export interface PromptInvocation {
  kind: PromptInvocationKind
  /** The chip's title: "/review", "/agent reviewer", "Create PR", "Handed-off task". */
  label: string
  /** Secondary text: the command's description, the user's own task, an action hint. */
  detail?: string
  /**
   * The slash command line exactly as the user typed it. Composer history recall
   * and the placeholder chat title use it, so recalling a `/review` turn gives back
   * `/review` and not the prompt it expanded to.
   */
  typed?: string
}

/** A user turn plus the record of what produced it. */
export interface InvokedTurn {
  text: string
  invokedAs: PromptInvocation
}

/** Caps on the record at the IPC boundary. It's display text, never instructions. */
const MAX_LABEL = 120
const MAX_DETAIL = 500
const MAX_TYPED = 4000
const KINDS: readonly PromptInvocationKind[] = ['command', 'action', 'spawned']

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  if (!v) return undefined
  return v.length > max ? `${v.slice(0, max - 1)}…` : v
}

/**
 * Validate an `invokedAs` that crossed a process boundary (renderer → main, or a
 * conversation file read back from disk). Anything malformed is dropped, so the
 * worst a bad record can do is render the turn as plain text again.
 */
export function sanitizeInvocation(raw: unknown): PromptInvocation | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  if (!KINDS.includes(o.kind as PromptInvocationKind)) return undefined
  const label = clip(o.label, MAX_LABEL)
  if (!label) return undefined
  const detail = clip(o.detail, MAX_DETAIL)
  const typed = clip(o.typed, MAX_TYPED)
  return {
    kind: o.kind as PromptInvocationKind,
    label,
    ...(detail ? { detail } : {}),
    ...(typed ? { typed } : {})
  }
}

/** The text a turn should be recalled or titled as: what the user typed, else the label. */
export function invocationText(inv: PromptInvocation): string {
  return inv.typed ?? inv.label
}

/**
 * A template slash command run as a turn: `/review` in either client, or a custom
 * `.houston/commands` command the terminal runs directly. `typed` is the line the
 * user entered. Null when `cmd` has no template (an action command, not a turn).
 */
export function commandTurn(cmd: Command, args: string, typed: string): InvokedTurn | null {
  if (cmd.template === undefined) return null
  return {
    text: expandTemplate(cmd.template, args),
    invokedAs: {
      kind: 'command',
      label: `/${cmd.name}`,
      ...(cmd.description ? { detail: cmd.description } : {}),
      typed: typed.trim()
    }
  }
}

/**
 * `/agent <name> <task>`: the dispatch prompt, labelled with the agent and the
 * user's own task. Null when `arg` doesn't name an agent.
 */
export function agentTurn(arg: string, typed: string): InvokedTurn | null {
  const inv = parseAgentInvocation(arg)
  if (!inv) return null
  return {
    text: agentInvocationPrompt(inv.name, inv.task),
    invokedAs: {
      kind: 'command',
      label: `/agent ${inv.name}`,
      ...(inv.task ? { detail: inv.task } : {}),
      typed: typed.trim()
    }
  }
}

/** A Changes-panel ship button (Create PR, Publish to GitHub, Commit and push, ...). */
export function shipTurn(action: ShipAction): InvokedTurn {
  return {
    text: action.prompt,
    invokedAs: { kind: 'action', label: action.label, detail: action.hint }
  }
}

/**
 * The brief that seeds a session another chat's agent started. The chat already
 * opens with a "Handoff from …" banner naming where it came from, so the chip
 * carries the brief's opening line: enough to say what the session is for.
 */
export function spawnedTurn(prompt: string): InvokedTurn {
  const firstLine = prompt.trim().split('\n')[0]?.trim() ?? ''
  const detail = clip(firstLine, 160)
  return {
    text: prompt,
    invokedAs: { kind: 'spawned', label: 'Handed-off task', ...(detail ? { detail } : {}) }
  }
}
