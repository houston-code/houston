import type { McpServerConfig } from './types'
import { sanitizeServerId } from './mcp'

/**
 * A small, static list of well-known MCP servers, offered in Settings > MCP Servers
 * as "Add from catalog". Shipped with the app (never fetched), each entry prefills a
 * server's command and arguments for the user to review; nothing is saved until they
 * add it, and it is added switched off unless they choose otherwise.
 *
 * `{project}` in an argument stands for the open project's folder, filled in when
 * the entry is opened for review (left as is, for the user to replace, with none open).
 */

export interface McpCatalogEntry {
  /** Suggested server id (the `mcp__<id>__` tool prefix). */
  id: string
  name: string
  description: string
  /** Who publishes it. */
  publisher: string
  transport: 'stdio' | 'http'
  command: string
  args: string[]
  url?: string
  /** Header names a remote server needs, with what to put in each. */
  headers?: Record<string, string>
  /** What has to be installed for the command to run. */
  needs?: string
  /** Anything to check or fill in before adding it. */
  note?: string
}

/** Placeholder for the open project's folder in an entry's arguments. */
export const PROJECT_PLACEHOLDER = '{project}'

const REFERENCE = 'MCP reference servers'

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read, write, search and move files in the folders you list.',
    publisher: REFERENCE,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', PROJECT_PLACEHOLDER],
    needs: 'Node.js (npx)',
    note: 'Every argument after the package name is a folder it may use. Add more on new lines.'
  },
  {
    id: 'git',
    name: 'Git',
    description: 'Read and work with a Git repository: status, diffs, logs, commits and branches.',
    publisher: REFERENCE,
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-git', '--repository', PROJECT_PLACEHOLDER],
    needs: 'uv (uvx)'
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'Fetch a web page and return it as Markdown.',
    publisher: REFERENCE,
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    needs: 'uv (uvx)',
    note: 'Its requests go straight to the web, outside Houston’s per-site approval for web_fetch.'
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'A knowledge graph the model can store facts in and recall across sessions.',
    publisher: REFERENCE,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    needs: 'Node.js (npx)'
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential thinking',
    description: 'A tool for working through a problem step by step, revising earlier steps.',
    publisher: REFERENCE,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    needs: 'Node.js (npx)'
  },
  {
    id: 'time',
    name: 'Time',
    description: 'The current time and conversions between time zones.',
    publisher: REFERENCE,
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    needs: 'uv (uvx)'
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Issues, pull requests, code search and repository actions on GitHub, hosted by GitHub.',
    publisher: 'GitHub',
    transport: 'http',
    command: '',
    args: [],
    url: 'https://api.githubcopilot.com/mcp/',
    headers: { Authorization: 'Bearer followed by a GitHub personal access token' },
    note: 'Needs a personal access token. Give it only the scopes you want the model to use.'
  },
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Drive a web browser: open pages, click, type and read what is on screen.',
    publisher: 'Microsoft',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    needs: 'Node.js (npx)'
  }
]

/** A catalog entry as a server config to review, with `{project}` filled in (or left empty). */
export function catalogServer(entry: McpCatalogEntry, workspace: string | null): McpServerConfig {
  const args = entry.args.map((a) => (a === PROJECT_PLACEHOLDER && workspace ? workspace : a))
  return {
    id: entry.id,
    transport: entry.transport,
    command: entry.command,
    args,
    ...(entry.url ? { url: entry.url } : {}),
    // Header values are the user's to supply: start them empty.
    ...(entry.headers ? { headers: Object.fromEntries(Object.keys(entry.headers).map((k) => [k, ''])) } : {}),
    enabled: false
  }
}

/** An id not taken by `taken`: the id itself, else `<id>-2`, `<id>-3`, ... */
export function freeServerId(id: string, taken: readonly string[]): string {
  const base = sanitizeServerId(id) || 'server'
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`
}

/** Why a reviewed server can't be added yet, or null when it can. */
export function serverProblem(server: McpServerConfig, taken: readonly string[]): string | null {
  if (!server.id) return 'Give it an id (letters, digits, - or _).'
  if (taken.includes(server.id)) return `There is already a server with the id ${server.id}.`
  const remote = server.transport === 'http' || server.transport === 'sse'
  if (remote) {
    if (!/^https?:\/\/\S+$/i.test(server.url ?? '')) return 'Enter the server’s http:// or https:// URL.'
    const empty = Object.entries(server.headers ?? {}).find(([, v]) => !v.trim())
    if (empty) return `Fill in the ${empty[0]} header.`
  } else {
    if (!server.command.trim()) return 'Enter the command to run.'
    if ((server.args ?? []).some((a) => a.includes(PROJECT_PLACEHOLDER))) return `Replace ${PROJECT_PLACEHOLDER} with a folder path.`
    if ((server.args ?? []).some((a) => !a.trim())) return 'Fill in every argument, or remove the empty ones.'
    const empty = Object.entries(server.env ?? {}).find(([, v]) => !v.trim())
    if (empty) return `Fill in the ${empty[0]} variable.`
  }
  return null
}

/**
 * Add pasted servers to the configured ones, switched off. A pasted id that is taken
 * is skipped rather than renamed, so the user can tell which one they already have.
 */
export function addPastedServers(
  current: readonly McpServerConfig[],
  pasted: readonly McpServerConfig[]
): { servers: McpServerConfig[]; added: string[]; skipped: string[] } {
  const servers = [...current]
  const added: string[] = []
  const skipped: string[] = []
  for (const s of pasted) {
    if (servers.some((x) => x.id === s.id)) {
      skipped.push(s.id)
      continue
    }
    servers.push({ ...s, enabled: false })
    added.push(s.id)
  }
  return { servers, added, skipped }
}
