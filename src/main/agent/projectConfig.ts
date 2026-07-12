import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { PermissionRule } from '@shared/types'
import { parseTightenOnlyRules } from './permissions'

/**
 * Per-project config from `.houston/settings.json` in the workspace.
 *
 * SECURITY: this file is part of the project, so it is attacker-controlled when
 * you open an untrusted repo. It may therefore only *tighten* — a project can add
 * `deny`/`ask` permission rules (guardrails) but NOT `allow` rules, hooks, or MCP
 * servers, which would let a cloned repo auto-approve dangerous actions or spawn
 * processes. Loosening stays in the user's own global Settings. (A "trusted
 * folders" prompt to opt into project hooks/MCP/allow-rules is on the roadmap.)
 *
 * The same tighten-only shape is reused, one tier up, by the admin-locked managed
 * policy (see managedPolicy.ts), which outranks both this file and the user.
 */

export const PROJECT_CONFIG = '.houston/settings.json'
const MAX_PROJECT_RULES = 100

/**
 * Validate untrusted project JSON into safe permission rules: well-formed entries
 * whose action is `deny` or `ask` only (`allow` and anything malformed dropped).
 * Pure + exported for testing.
 */
export function parseProjectRules(raw: unknown): PermissionRule[] {
  return parseTightenOnlyRules(raw, MAX_PROJECT_RULES)
}

export interface ProjectConfig {
  /** Project-scoped guardrail rules (deny/ask only), checked before global rules. */
  permissionRules: PermissionRule[]
}

/** Read + validate the workspace's `.houston/settings.json`. Never throws. */
export async function loadProjectConfig(workspace: string): Promise<ProjectConfig> {
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(join(workspace, PROJECT_CONFIG), 'utf8'))
  } catch {
    return { permissionRules: [] } // missing or malformed — no project config
  }
  return { permissionRules: parseProjectRules(raw) }
}
