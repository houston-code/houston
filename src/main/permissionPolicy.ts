import type { FolderTrustState, McpServerConfig, PermissionPolicyView } from '@shared/types'
import { loadManagedPolicy, type ManagedPolicy } from './agent/managedPolicy'
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

/** The real sources: the system managed-policy file and the project's own config. */
export function defaultPolicyDeps(trustFor: PolicyDeps['trustFor']): PolicyDeps {
  return { loadManaged: () => loadManagedPolicy(), loadProject: loadProjectConfig, trustFor }
}
