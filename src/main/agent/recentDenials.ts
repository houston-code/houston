import { existsSync } from 'node:fs'
import { resolve as resolveFsPath } from 'node:path'
import type { PermissionRule, RecentDenial } from '@shared/types'
import { sanitizeApprovalNote } from '@shared/agent'
import { alreadyAllowedAsRule, matchRule, permissionSubject, persistedRules } from './permissions'
import type { ToolKind } from './tools'

/**
 * The calls the user refused at an approval prompt this session, newest first, so a
 * denial that turns out to have been wrong (or one the agent keeps running into) can be
 * turned into an allow rule from `/permissions` or Settings > Permissions instead of
 * being re-approved by hand every time.
 *
 * In memory only, for the life of the process: a denial says something about one
 * moment, and keeping the arguments (a command, a path) on disk would be a second
 * transcript nobody asked for. Bounded, and a call denied again replaces its earlier
 * entry rather than filling the list with one repeated command.
 */
export const MAX_RECENT_DENIALS = 20

interface Entry extends RecentDenial {
  /** The call's arguments, so "Allow this" saves what "Always allow" would have. */
  args: Record<string, unknown>
  /** The run's roots: the rule is built and deduped against the same anchors the gate used. */
  roots: string[]
}

let entries: Entry[] = []
let seq = 0

/** Note a call the user denied at its approval prompt. */
export function recordDenial(
  d: { tool: string; kind: ToolKind; args: Record<string, unknown>; roots: string[]; reason?: string },
  now = Date.now()
): void {
  const subject = permissionSubject(d.tool, d.args)
  const reason = sanitizeApprovalNote(d.reason)
  entries = entries.filter((e) => !(e.tool === d.tool && e.subject === subject))
  entries.unshift({
    id: `d${++seq}`,
    at: now,
    tool: d.tool,
    kind: d.kind,
    subject,
    ...(reason ? { reason } : {}),
    args: { ...d.args },
    roots: [...d.roots]
  })
  if (entries.length > MAX_RECENT_DENIALS) entries.length = MAX_RECENT_DENIALS
}

/** The recent denials, newest first, without the arguments they were recorded with. */
export function listRecentDenials(): RecentDenial[] {
  return entries.map(({ id, at, tool, kind, subject, reason }) => ({
    id,
    at,
    tool,
    kind,
    subject,
    ...(reason ? { reason } : {})
  }))
}

/** What allowing a recent denial would save. */
export interface DenialAllowRules {
  /** The allow rules to save: what "Always allow" saves for the call, minus any already covered. */
  rules: PermissionRule[]
  /** A deny rule in `existing` matches the call, and a matching deny wins over any allow. */
  deniedByRule: boolean
}

/**
 * The allow rules that would let a recently denied call run unasked, built the way the
 * approval prompt's "Always allow" builds them (see persistedRules: a shell command
 * saved as per-command prefixes unless it trips a guard, a path or URL exact), and
 * skipping any that `existing` already allows. Null for an id that is no longer listed.
 */
export function allowRulesForDenial(id: string, existing: PermissionRule[]): DenialAllowRules | null {
  const e = entries.find((x) => x.id === id)
  if (!e) return null
  const pathExists = (p: string): boolean =>
    e.roots.some((base) => {
      try {
        return existsSync(resolveFsPath(base, p))
      } catch {
        return false
      }
    })
  const rules = persistedRules('allow', e.tool, e.args, e.roots, pathExists).filter(
    (r) => !alreadyAllowedAsRule(existing, e.tool, r.match, e.roots, pathExists)
  )
  return { rules, deniedByRule: matchRule(existing, e.tool, e.subject, e.roots) === 'deny' }
}

/** Drop one entry (once it has been allowed). */
export function forgetDenial(id: string): void {
  entries = entries.filter((e) => e.id !== id)
}

/** Test seam. */
export function resetRecentDenials(): void {
  entries = []
  seq = 0
}
