import { randomBytes } from 'node:crypto'
import type { ReasoningEffort } from '@shared/agent'
import type { PermissionRule } from '@shared/types'

/**
 * The desktop app's per-turn custom-command options, held in the main process.
 *
 * A command's frontmatter can pick the model and effort its turn runs on and
 * pre-approve tools for it. The renderer starts the turn, but it must not be the
 * one to say which tools are pre-approved: a compromised or buggy renderer could
 * then approve anything. So `commandPrepare` keeps the options here under a random
 * token, the renderer only hands the token back with the send, and `agentStart`
 * takes the options from here. A token works once, for the workspace it was made
 * for, and only for a little while.
 */

export interface CommandGrant {
  /** The realpath of the workspace whose command made it. */
  workspace: string
  model?: { providerId: string; model: string }
  effort?: ReasoningEffort
  turnAllowRules?: PermissionRule[]
}

/** How long a prepared command waits to be sent. Sending is immediate; this only bounds a leak. */
export const GRANT_TTL_MS = 5 * 60_000
/** Most grants held at once; the oldest goes first. */
const MAX_GRANTS = 50

const grants = new Map<string, CommandGrant & { expires: number }>()

/** Keep `grant` and return its token. */
export function putCommandGrant(grant: CommandGrant, now: number = Date.now()): string {
  for (const [token, g] of grants) if (g.expires <= now) grants.delete(token)
  while (grants.size >= MAX_GRANTS) {
    const oldest = grants.keys().next().value
    if (oldest === undefined) break
    grants.delete(oldest)
  }
  const token = randomBytes(16).toString('hex')
  grants.set(token, { ...grant, expires: now + GRANT_TTL_MS })
  return token
}

/**
 * Take the grant for `token` (it can't be used again). Null when the token is
 * unknown, expired, or was made for another workspace.
 */
export function takeCommandGrant(token: unknown, workspace: string, now: number = Date.now()): CommandGrant | null {
  if (typeof token !== 'string' || !token) return null
  const g = grants.get(token)
  if (!g) return null
  grants.delete(token)
  if (g.expires <= now || g.workspace !== workspace) return null
  const { expires: _expires, ...grant } = g
  return grant
}
