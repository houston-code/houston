import { realpathSync } from 'node:fs'
import { mergeCommands, type Command } from '@shared/commands'
import { folderTrustState, type AppSettings, type McpServerConfig } from '@shared/types'
import { getMcpPromptText, listMcpPrompts } from '../mcp/manager'
import { loadSlashCommands } from './commands'
import { mcpPromptCommands, type McpPromptFetch } from './mcpPromptCommands'
import { loadProjectConfig, mergeProjectMcpServers, mergeRunMcpServers } from './projectConfig'

/**
 * The MCP servers a chat in `workspace` runs with: the user's enabled servers, a
 * trusted folder's project servers (`proj-<id>`), and a session's own (`run-<id>`, an
 * editor's over ACP). The same configs the run loop connects, so a prompt command is
 * offered exactly when the chat's turns could call that server, on the same connection.
 */
export async function workspaceMcpServers(
  workspace: string,
  settings: AppSettings,
  extra?: McpServerConfig[]
): Promise<McpServerConfig[]> {
  let configs = settings.mcpServers ?? []
  try {
    const cfg = await loadProjectConfig(workspace)
    let path = workspace
    try {
      path = realpathSync(workspace)
    } catch {
      // Keep the raw path; trust records normalize the same way.
    }
    if (cfg.elevatedHash && folderTrustState(settings.trustedFolders, path, cfg.elevatedHash) === 'trusted') {
      configs = mergeProjectMcpServers(configs, cfg.elevated.mcpServers)
    }
  } catch {
    // An unreadable project config contributes no servers.
  }
  const merged = mergeRunMcpServers(configs, extra) ?? []
  return merged.filter((c) => c.enabled && c.id && (c.command || c.url))
}

/** The ids of {@link workspaceMcpServers}. */
export async function workspaceMcpServerIds(
  workspace: string,
  settings: AppSettings,
  extra?: McpServerConfig[]
): Promise<Set<string>> {
  return new Set((await workspaceMcpServers(workspace, settings, extra)).map((c) => c.id))
}

/** The prompt commands for a chat in `workspace` (see {@link workspaceMcpServers}). */
export async function workspaceMcpPromptCommands(
  workspace: string,
  settings: AppSettings,
  extra?: McpServerConfig[]
): Promise<Command[]> {
  return mcpPromptCommands(listMcpPrompts(await workspaceMcpServers(workspace, settings, extra)))
}

/** Fetch a prompt for a chat in `workspace`, refusing any server outside its own. */
export function workspaceMcpPromptFetch(workspace: string, settings: AppSettings, extra?: McpServerConfig[]): McpPromptFetch {
  return async (server, prompt, args) => getMcpPromptText(await workspaceMcpServers(workspace, settings, extra), server, prompt, args)
}

/**
 * Everything a client offers after a slash beyond its built-ins: the custom commands
 * and skills ({@link loadSlashCommands}), then the connected MCP servers' prompts. A
 * custom command or skill wins a name clash with a prompt.
 */
export async function loadWorkspaceSlashCommands(
  workspace: string,
  settings: AppSettings,
  extra?: McpServerConfig[]
): Promise<Command[]> {
  const [commands, prompts] = await Promise.all([
    loadSlashCommands(workspace),
    workspaceMcpPromptCommands(workspace, settings, extra).catch((): Command[] => [])
  ])
  return mergeCommands(commands, prompts)
}
