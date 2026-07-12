import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { APP_NAME } from '@shared/constants'
import type { PermissionRule } from '@shared/types'
import { parseTightenOnlyRules } from './permissions'

/**
 * Admin-locked managed policy — an organization-distributed guardrail file that
 * sits ABOVE both the project's `.houston/settings.json` and the user's own global
 * Settings. It lets a device administrator (via MDM, a provisioning script, or a
 * config-management tool) enforce guardrails every user and repo on the machine
 * must obey.
 *
 * Where it lives — a machine-wide, root/Administrators-owned location an
 * unprivileged user cannot write, distinct from the per-user data dir:
 *   - macOS:   /Library/Application Support/Houston/managed-settings.json
 *   - Windows: %PROGRAMDATA%\Houston\managed-settings.json   (C:\ProgramData\…)
 *   - Linux:   /etc/houston/managed-settings.json
 *
 * SECURITY — this deliberately extends the proven project "tighten-only" model
 * (see projectConfig.ts), adding the administrator as a tier ABOVE the user:
 *
 *  - Tighten-only. Exactly like the project file, a managed policy may only add
 *    `deny`/`ask` permission rules; `allow` rules (and hooks / MCP servers) are
 *    dropped. So the worst a malformed — or even hostile — managed file can ever do
 *    is make the agent MORE cautious; it can never auto-approve a dangerous action.
 *    That is why the tier is safe to trust without verifying the file's provenance
 *    in-process, and why a non-root user who somehow could write it would only be
 *    able to restrict themselves, never escalate.
 *  - Highest precedence. Its rules are checked before the project's and before the
 *    user's, and matching is first-match-wins, so an admin `deny`/`ask` overrides
 *    any user `allow`. The user cannot loosen it from within the app: the Settings
 *    editor only ever writes the user's own `settings.json`, never this file.
 *  - Locked by the filesystem, not by us. The "lock" is the OS permissions on the
 *    system path above (writable only by root / Administrators). Houston reads that
 *    fixed path with NO environment or config override, so a user cannot redirect it
 *    to an empty file to opt out.
 *
 * Loaded fresh on each run (a tiny, best-effort read that never throws), so an
 * administrator pushing an updated policy takes effect on the next turn without an
 * app restart.
 */

export const MANAGED_SETTINGS_FILE = 'managed-settings.json'

/**
 * Cap on the number of managed rules honored. Higher than the project cap: this
 * file comes from a trusted administrator (a large org policy is legitimate), where
 * the project cap guards against an untrusted repo. Still bounded as a DoS backstop.
 */
const MAX_MANAGED_RULES = 1000

/** Test seam: override the platform used to resolve the managed-policy path. */
export interface ManagedPathDeps {
  platform?: NodeJS.Platform
}

/**
 * The machine-wide path the managed policy is read from, per platform.
 *
 * Every path is a fixed system location resolved WITHOUT any environment variable —
 * on purpose. Reading e.g. `%PROGRAMDATA%` would let a user relaunch with that var
 * repointed at an empty file and silently opt out of the admin lock, so we hardcode
 * `C:\ProgramData` (its standard value) instead. `deps` exists only for tests.
 */
export function resolveManagedPolicyPath(deps: ManagedPathDeps = {}): string {
  const platform = deps.platform ?? process.platform
  if (platform === 'darwin') {
    return join('/Library', 'Application Support', APP_NAME, MANAGED_SETTINGS_FILE)
  }
  if (platform === 'win32') {
    return join('C:\\ProgramData', APP_NAME, MANAGED_SETTINGS_FILE)
  }
  // Linux / other POSIX: the conventional lowercase name under /etc.
  return join('/etc', APP_NAME.toLowerCase(), MANAGED_SETTINGS_FILE)
}

export interface ManagedPolicy {
  /** Admin guardrail rules (deny/ask only), checked before project + user rules. */
  permissionRules: PermissionRule[]
}

/**
 * Read + validate the admin managed policy. Never throws — a missing or malformed
 * file yields an empty policy (no rules), so the machine simply behaves as if no
 * administrator policy were present. `path` defaults to the fixed system location;
 * tests pass an explicit path.
 */
export async function loadManagedPolicy(
  path: string = resolveManagedPolicyPath()
): Promise<ManagedPolicy> {
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(path, 'utf8'))
  } catch {
    return { permissionRules: [] } // missing or malformed — no managed policy
  }
  return { permissionRules: parseTightenOnlyRules(raw, MAX_MANAGED_RULES) }
}
