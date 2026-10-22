import { realpathSync } from 'node:fs'
import type {
  FolderTrustState,
  McpServerConfig,
  PermissionPolicyView,
  PermissionRule,
  PermissionTestResult
} from '@shared/types'
import { loadManagedPolicy, type ManagedPolicy } from './agent/managedPolicy'
import { matchRule } from './agent/permissions'
import { loadProjectConfig, type ProjectConfig } from './agent/projectConfig'

/** What the policy view reads, injectable so tests need no files on disk. */
export interface PolicyDeps {
  loadManaged: () => Promise<ManagedPolicy>
  loadProject: (workspace: string) => Promise<ProjectConfig>
  trustFor: (workspace: string, elevatedHash: string) => FolderTrustState
}

/** A project MCP server as Settings shows it: what it runs or reaches, no secrets. */
function describeServer(sv: McpServerConfig): { id: string; transport: 'stdio' | 'http' | 'sse'; target: string } {
  const transport = sv.transport ?? (sv.url && !sv.command ? 'http' : 'stdio')
  const target =
    transport === 'stdio' ? [sv.command, ...(sv.args ?? [])].filter(Boolean).join(' ') : (sv.url ?? '')
  return { id: sv.id, transport, target }
}

/**
 * The managed policy and the open project's permission config, for Settings to
 * show beside the user's own rules. Never throws: an unreadable file reads as
 * absent, exactly as the agent loop treats it.
 */
export async function describePermissionPolicy(
  workspace: string | null | undefined,
  deps: PolicyDeps
): Promise<PermissionPolicyView> {
  const managed = (await deps.loadManaged()).permissionRules
  if (typeof workspace !== 'string' || workspace === '') return { managed, project: null }
  const cfg = await deps.loadProject(workspace)
  const { allowRules, hooks, mcpServers } = cfg.elevated
  if (cfg.permissionRules.length === 0 && !cfg.elevatedHash) return { managed, project: null }
  return {
    managed,
    project: {
      rules: cfg.permissionRules,
      allowRules,
      hooks,
      mcpServers: mcpServers.map(describeServer),
      trust: cfg.elevatedHash ? deps.trustFor(workspace, cfg.elevatedHash) : 'none'
    }
  }
}

/** A path's real location, or the path as given when it does not resolve. */
function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Test one call against every permission tier, the way the agent's gate does: the
 * tiers are concatenated in the loop's order (admin, project guardrails, the given
 * user rules, then a trusted project's allow rules) and matched as one list, so a
 * compound shell command or a multi-file patch resolves exactly as it would at run
 * time. `userRules` is the Settings working copy, so unsaved edits are tested.
 *
 * Rules only: the approval mode and the gate's other checks (a write outside the
 * project, a sensitive file, plan mode) are outside what this reports.
 */
export async function testPermission(
  input: { workspace: string | null; userRules: PermissionRule[]; tool: string; subject: string; additionalRoots: string[] },
  deps: PolicyDeps
): Promise<PermissionTestResult> {
  const { tool, subject } = input
  const roots: string[] = []
  for (const dir of [input.workspace, ...input.additionalRoots]) {
    if (typeof dir !== 'string' || dir === '') continue
    const r = real(dir)
    if (!roots.includes(r)) roots.push(r)
  }
  const managed = (await deps.loadManaged()).permissionRules
  const cfg = input.workspace ? await deps.loadProject(input.workspace) : null
  const projectRules = cfg?.permissionRules ?? []
  const trusted =
    cfg !== null && input.workspace !== null && cfg.elevatedHash !== '' && deps.trustFor(input.workspace, cfg.elevatedHash) === 'trusted'
  const projectAllow = trusted && cfg ? cfg.elevated.allowRules : []
  const valid = (r: PermissionRule): boolean =>
    !!r && typeof r.match === 'string' && (r.action === 'allow' || r.action === 'deny' || r.action === 'ask')
  const user = input.userRules.filter(valid)
  const decision = matchRule([...managed, ...projectRules, ...user, ...projectAllow], tool, subject, roots)
  // Indices into the caller's list (malformed entries skipped, not renumbered).
  const userMatches = input.userRules.flatMap((r, i) =>
    valid(r) && matchRule([r], tool, subject, roots) !== null ? [i] : []
  )
  // The first tier that reaches a verdict on its own, which (the tiers being matched in
  // order) is the one that decided.
  const tiers: Array<[NonNullable<PermissionTestResult['tier']>, PermissionRule[]]> = [
    ['managed', managed],
    ['project', projectRules],
    ['user', user],
    ['project-allow', projectAllow]
  ]
  let tier: PermissionTestResult['tier'] = null
  if (decision !== null) {
    for (const [name, rules] of tiers) {
      if (rules.length > 0 && matchRule(rules, tool, subject, roots) !== null) {
        tier = name
        break
      }
    }
  }
  return { decision, tier, userMatches }
}

/** The real sources: the system managed-policy file and the project's own config. */
export function defaultPolicyDeps(trustFor: PolicyDeps['trustFor']): PolicyDeps {
  return { loadManaged: () => loadManagedPolicy(), loadProject: loadProjectConfig, trustFor }
}
