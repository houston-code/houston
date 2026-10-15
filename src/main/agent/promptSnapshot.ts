import type { PromptSnapshot } from '@shared/agent'

/**
 * The per-conversation slice of the system prompt that depends on the outside
 * world: today's date and the git/GitHub context. It is captured once and reused
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
 * persist it). `captureGit` runs only when a fresh snapshot is needed.
 */
export async function resolvePromptSnapshot(
  stored: PromptSnapshot | undefined,
  today: string,
  captureGit: () => Promise<string>
): Promise<{ snapshot: PromptSnapshot; fresh: boolean }> {
  if (stored && stored.date === today) return { snapshot: stored, fresh: false }
  return { snapshot: { date: today, gitStatus: await captureGit() }, fresh: true }
}

/** Render the snapshot as the system-prompt section. Pure. */
export function formatPromptSnapshot(snapshot: PromptSnapshot): string {
  const sections = [`Today's date: ${snapshot.date}.`]
  const git = snapshot.gitStatus.trim()
  if (git) {
    sections.push(
      `Git snapshot (taken earlier in this conversation and not updated as files change; run git status for the current state):\n${git}`
    )
  }
  return sections.join('\n\n')
}
