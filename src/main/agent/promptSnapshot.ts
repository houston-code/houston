import type { PromptSnapshot } from '@shared/agent'

/**
 * The per-conversation slice of the system prompt that depends on the outside
 * world: today's date, the git/GitHub context, and the index of saved memories
 * (memoryIndex.ts). It is captured once and reused
 * on every later run of the conversation so the system prompt stays
 * byte-identical between user turns.
 *
 * Why: providers cache the system prompt together with the message history behind
 * it (Anthropic sends it as one cached block), so a prompt that changes between
 * turns re-bills the whole history as a cache write instead of a cache read. The
 * live git status changes on nearly every turn in which the agent edits a file,
 * which made that the common case rather than the exception.
 *
 * The snapshot is retaken only when the local date has moved on, so the date the
 * model sees is always today's. That costs at most one cache miss per day, and a
 * day boundary usually falls in an idle gap longer than the cache lifetime anyway.
 */

/** Local calendar date as YYYY-MM-DD (the user's day, not UTC's). */
export function localDateStamp(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * The snapshot to build this run's prompt from: the stored one when it is still
 * from `today`, otherwise a fresh capture (`fresh: true` tells the caller to
 * persist it). `captureGit` and `captureMemory` run only when a fresh snapshot is
 * needed; without `captureMemory` (memory is off) a fresh snapshot holds no index.
 *
 * A stored snapshot from today is reused as-is even when it predates memory and
 * holds no index: the memories then appear from the next snapshot on, rather than
 * rewriting this conversation's prompt mid-day.
 */
export async function resolvePromptSnapshot(
  stored: PromptSnapshot | undefined,
  today: string,
  captureGit: () => Promise<string>,
  captureMemory?: () => string
): Promise<{ snapshot: PromptSnapshot; fresh: boolean }> {
  // The stored value comes from the conversation file on disk, which the load-time
  // shape check doesn't cover; a malformed one is retaken rather than trusted.
  if (isPromptSnapshot(stored) && stored.date === today) return { snapshot: stored, fresh: false }
  const gitStatus = await captureGit()
  const memory = captureMemory?.() ?? ''
  return { snapshot: { date: today, gitStatus, ...(memory ? { memory } : {}) }, fresh: true }
}

function isPromptSnapshot(v: unknown): v is PromptSnapshot {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.date === 'string' &&
    typeof o.gitStatus === 'string' &&
    (o.memory === undefined || typeof o.memory === 'string')
  )
}

/**
 * Render the snapshot as the system-prompt section. Pure. The memory index is left
 * out when `memory` is false, so turning memory off takes effect on the next run.
 * `tools` (the built-in tools the run offers; every tool when absent) keeps the
 * section from naming one the run can't call: the index, which says to read entries
 * with recall_memory, rides only with that tool, and the pointer to the current git
 * state names git_status, else the shell, else nothing.
 */
export function formatPromptSnapshot(
  snapshot: PromptSnapshot,
  opts: { memory?: boolean; tools?: readonly string[] } = {}
): string {
  const offers = (name: string): boolean => !opts.tools || opts.tools.includes(name)
  const sections: string[] = []
  const memory = opts.memory === false || !offers('recall_memory') ? '' : (snapshot.memory?.trim() ?? '')
  if (memory) sections.push(memory)
  sections.push(`Today's date: ${snapshot.date}.`)
  const git = snapshot.gitStatus.trim()
  if (git) {
    const current = offers('git_status')
      ? '; use git_status for the current state'
      : offers('run_shell')
        ? '; run `git status` for the current state'
        : ''
    sections.push(
      `Git snapshot (taken earlier in this conversation and not updated as files change${current}):\n${git}`
    )
  }
  return sections.join('\n\n')
}
