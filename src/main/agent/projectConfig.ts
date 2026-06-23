import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { PermissionRule } from '@shared/types'

/**
 * Per-project config from `.houston/settings.json` in the workspace.
 *
 * SECURITY: this file is part of the project, so it is attacker-controlled when
 * you open an untrusted repo. It may therefore only *tighten* — a project can add
 * `deny`/`ask` permission rules (guardrails) but NOT `allow` rules, hooks, or MCP
 * servers, which would let a cloned repo auto-approve dangerous actions or spawn
 * processes. Loosening stays in the user's own global Settings. (A "trusted
 * folders" prompt to opt into project hooks/MCP/allow-rules is on the roadmap.)
 */

export const PROJECT_CONFIG = '.houston/settings.json'
const MAX_PROJECT_RULES = 100

/**
 * Validate untrusted project JSON into safe permission rules: well-formed entries
 * whose action is `deny` or `ask` only (`allow` and anything malformed dropped).
 * Pure + exported for testing.
 */
export function parseProjectRules(raw: unknown): PermissionRule[] {
  const rules = (raw as { permissionRules?: unknown })?.permissionRules
  if (!Array.isArray(rules)) return []
  const out: PermissionRule[] = []
  for (const r of rules) {
    if (out.length >= MAX_PROJECT_RULES) break
    if (typeof r !== 'object' || r === null) continue
    const { action, tool, match } = r as Record<string, unknown>
    if (action !== 'deny' && action !== 'ask') continue // never honor project `allow`
    if (typeof tool !== 'string' || typeof match !== 'string') continue
    out.push({ action, tool, match })
  }
  return out
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
