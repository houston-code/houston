import type { McpServerConfig } from './types'
import { sanitizeServerId } from './mcp'

/**
 * A small, static list of well-known MCP servers, offered in Settings > MCP Servers
 * as "Recommended". Shipped with the app (never fetched), each entry prefills a
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

/** An environment variable or header a server needs, filled in on the review form. */
export interface McpDraftInput {
  kind: 'env' | 'header'
  name: string
  description: string
  required: boolean
  /** Shown masked while typed. Every value is stored encrypted either way. */
  secret: boolean
  /** The shape the publisher gives for the value (`Bearer {api_key}`), shown as a hint only. */
  format?: string
  /** What the server uses when it is left empty. */
  default?: string
}

/** A server to review before adding: the config to prefill plus what to tell the user. */
export interface McpDraft {
  /** Unique per draft in a list. */
  key: string
  name: string
  publisher: string
  note?: string
  needs?: string
  server: McpServerConfig
  /** Header names with what to put in each (catalog entries). */
  headerHints?: Record<string, string>
  /** Variables or headers to ask for one field each (registry entries). */
  inputs?: McpDraftInput[]
}

/** A catalog entry as a draft for the review form. */
export function catalogDraft(entry: McpCatalogEntry, workspace: string | null): McpDraft {
  return {
    key: entry.id,
    name: entry.name,
    publisher: entry.publisher,
    ...(entry.note ? { note: entry.note } : {}),
    ...(entry.needs ? { needs: entry.needs } : {}),
    server: catalogServer(entry, workspace),
    ...(entry.headers ? { headerHints: entry.headers } : {})
  }
}

/** The form key a draft input's value is held under. */
export function draftInputKey(input: Pick<McpDraftInput, 'kind' | 'name'>): string {
  return `${input.kind}:${input.name}`
}

/**
 * Put the values typed for a draft's inputs into its env or headers. A required one
 * is always kept (so an empty one is reported), an optional one only when filled in.
 */
export function applyDraftInputs(
  server: McpServerConfig,
  inputs: readonly McpDraftInput[],
  values: Readonly<Record<string, string>>
): McpServerConfig {
  if (!inputs.length) return server
  const pick = (kind: 'env' | 'header'): Record<string, string> | undefined => {
    const out: Record<string, string> = {}
    for (const i of inputs.filter((x) => x.kind === kind)) {
      const v = (values[draftInputKey(i)] ?? '').trim()
      if (v || i.required) out[i.name] = v
    }
    return Object.keys(out).length ? out : undefined
  }
  const rest: McpServerConfig = { ...server }
  delete rest.env
  delete rest.headers
  const env = pick('env')
  const headers = pick('header')
  return { ...rest, ...(env ? { env } : {}), ...(headers ? { headers } : {}) }
}

/** The first `{name}` placeholder in a string, or null. */
function placeholderIn(s: string): string | null {
  return /\{[^{}\s]+\}/.exec(s)?.[0] ?? null
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
    const inUrl = placeholderIn(server.url ?? '')
    if (inUrl) return `Replace ${inUrl} in the URL.`
    const empty = Object.entries(server.headers ?? {}).find(([, v]) => !v.trim())
    if (empty) return `Fill in the ${empty[0]} header.`
  } else {
    if (!server.command.trim()) return 'Enter the command to run.'
    if ((server.args ?? []).some((a) => a.includes(PROJECT_PLACEHOLDER))) return `Replace ${PROJECT_PLACEHOLDER} with a folder path.`
    if ((server.args ?? []).some((a) => !a.trim())) return 'Fill in every argument, or remove the empty ones.'
    const inArgs = (server.args ?? []).map(placeholderIn).find((x) => x !== null)
    if (inArgs) return `Replace ${inArgs} in the arguments.`
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
