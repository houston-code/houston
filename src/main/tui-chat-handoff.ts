import { resolve as resolvePath } from 'node:path'
import { reconcileSelectedModel } from '@shared/defaults'
import type { ProviderConfig } from '@shared/types'
import { shellQuote } from './sessionWorktree'

/**
 * The model a reopened chat runs on, reconciled the way the desktop app does
 * (`chatSettingsFor`): the chat's own model while it is still set up, else another
 * model of the same provider, else the session's current one. `note` says what
 * changed so the user is told instead of the chat quietly running on something else.
 * Null when the chat records no model (nothing to reconcile). Pure.
 */
export function reconcileChatModel(
  providers: ProviderConfig[],
  own: { providerId?: string; model?: string },
  session: { providerId: string; model: string }
): { providerId: string; model: string; note?: string } | null {
  if (!own.providerId || !own.model) return null
  const wanted = { providerId: own.providerId, model: own.model }
  const reconciled = reconcileSelectedModel(providers, wanted)
  if (reconciled && reconciled.providerId === wanted.providerId && reconciled.model === wanted.model) {
    return wanted
  }
  const next = reconciled ?? session
  const note = next.model
    ? `this chat's model (${own.model}) is no longer set up, so it now uses ${next.model}`
    : `this chat's model (${own.model}) is no longer set up: pick one with /model to continue`
  return { providerId: next.providerId, model: next.model, note }
}

/**
 * The lines printed on the way out that name how to reopen the chat. When the
 * session ran somewhere other than where it was started (a worktree, or a resumed
 * chat's own folder), the command names that folder, and `--continue` (which reads
 * the folder you are in) is left out. Pure.
 */
export function comeBackHint(conversationId: string, chatFolder: string, launchFolder?: string): string {
  const elsewhere = launchFolder !== undefined && resolvePath(launchFolder) !== resolvePath(chatFolder)
  if (elsewhere) {
    return `\nThis chat is saved. To come back to it:\n  houston --resume ${conversationId} -C ${shellQuote(chatFolder)}\n`
  }
  return `\nThis chat is saved. To come back to it:\n  houston --resume ${conversationId}\n  houston --continue   (the latest chat in this folder)\n`
}

/**
 * `/fork [n]`: bare forks the whole chat; `n` (a message number from `/rewind`'s list)
 * forks the chat as it was just before that message. Pure.
 */
export function parseForkArg(arg: string): { turn?: number; bad?: true } {
  const a = arg.trim()
  if (!a) return {}
  const n = Number(a)
  return Number.isInteger(n) && n >= 1 ? { turn: n - 1 } : { bad: true }
}
