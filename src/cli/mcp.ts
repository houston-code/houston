import type { McpServerConfig, McpServerStatus } from '@shared/types'
import type { Painter } from '../main/tui'
import { buildRemoteMcpServer, buildStdioMcpServer } from '../main/tui'
import { stripControlChars, stripControlCharsKeepLines } from '../main/tui-wrap'

/**
 * `houston mcp`: the interactive `/mcp` from a shell, for setup scripts and for
 * people who'd rather not open a session to add a server. It edits the same
 * `mcpServers` list in settings.json (shared with the desktop app) with the same
 * validation `/mcp add` uses (`buildStdioMcpServer`, `buildRemoteMcpServer`: http(s)
 * only, no credentials in a URL), and signs in with the same OAuth flow as
 * `/mcp login` (a loopback redirect; the sign-in URL is printed for when no browser
 * opens). Servers are named by id (or display name, or their `/mcp` number).
 *
 *   houston mcp [list]                              servers, each connected to see if it works
 *   houston mcp add <name> -- <command> [args...]   a local (stdio) server
 *   houston mcp add --url <url> [name] [--sse]      a remote server
 *   houston mcp remove <name>
 *   houston mcp login <name> / logout <name>
 *
 * Dependency-injected (settings, connections, sign-in, output), so it unit-tests with
 * no profile and no network; cli/run.ts wires the real ones.
 */

export const MCP_USAGE = `Usage:
  houston mcp [list]                              list servers and whether each connects
  houston mcp add <name> -- <command> [args...]   add a local (stdio) server
  houston mcp add --url <url> [name] [--sse]      add a remote server (http, or --sse)
  houston mcp remove <name>                       remove a server
  houston mcp login <name>                        sign in to a remote server that asks for it
  houston mcp logout <name>                       forget its sign-in
`

export interface McpCliDeps {
  servers: () => McpServerConfig[]
  save: (servers: McpServerConfig[]) => void
  /** Connect each enabled server and report how it went. */
  connect: (servers: McpServerConfig[]) => Promise<McpServerStatus[]>
  /** The OAuth sign-in (absent when this host can't store tokens). */
  login?: (server: McpServerConfig, onStatus: (message: string) => void) => Promise<void>
  logout?: (serverId: string) => void
  paint: Painter
  out: (s: string) => void
  err: (s: string) => void
  /** Progress while connecting (stderr, at a terminal); absent stays silent. */
  progress?: (message: string) => void
}

/** Route `houston mcp <verb> ...`. Returns the exit code. */
export async function runMcpCliCommand(args: string[], deps: McpCliDeps): Promise<number> {
  const [verb, ...rest] = args
  switch (verb ?? 'list') {
    case 'list':
    case 'ls':
      if (rest.length) return usageError(`mcp list takes no arguments`, deps)
      return listServers(deps)
    case 'add':
      return addServer(rest, deps)
    case 'remove':
    case 'rm':
      return removeServer(rest, deps)
    case 'login':
    case 'logout':
      return signInOrOut(verb as 'login' | 'logout', rest, deps)
    case '-h':
    case '--help':
      deps.out(MCP_USAGE)
      return 0
    default:
      return usageError(`unknown command: mcp ${clean(verb ?? '')}`, deps)
  }
}

function usageError(message: string, deps: McpCliDeps): number {
  deps.err(`houston: ${message}\n${MCP_USAGE}`)
  return 2
}

/** Argv echoed back: a terminal escape in a pasted argument must not reach the screen. */
function clean(s: string): string {
  return stripControlChars(s)
}

function transportOf(s: McpServerConfig): 'stdio' | 'http' | 'sse' {
  return s.transport ?? (s.url && !s.command ? 'http' : 'stdio')
}

/** A server by id, then display name, then its 1-based place in the list (as /mcp numbers them). */
export function findServer(servers: McpServerConfig[], ref: string): McpServerConfig | undefined {
  return (
    servers.find((s) => s.id === ref) ??
    servers.find((s) => s.name === ref) ??
    (/^[1-9]\d*$/.test(ref) ? servers[Number(ref) - 1] : undefined)
  )
}

/** One line per server: id, transport, what it runs or where, and its state. Never headers or env values. */
export function renderMcpCliList(servers: McpServerConfig[], statuses: McpServerStatus[], paint: Painter): string {
  if (!servers.length) {
    return `${paint('No MCP servers configured.', 'dim')}\nAdd one with: houston mcp add <name> -- <command> [args...]  or  houston mcp add --url <url>\n`
  }
  const byId = new Map(statuses.map((s) => [s.id, s]))
  const width = Math.max(...servers.map((s) => s.id.length))
  const lines = servers.map((s) => {
    const t = transportOf(s)
    const target = t === 'stdio' ? [s.command, ...(s.args ?? [])].join(' ') : (s.url ?? '')
    const st = byId.get(s.id)
    let state: string
    if (!s.enabled) state = paint('disabled', 'dim')
    else if (st?.state === 'connected') state = paint(`connected, ${st.tools ?? 0} tool${st.tools === 1 ? '' : 's'}`, 'green')
    else if (st?.state === 'needs-auth') state = paint(`needs sign-in: houston mcp login ${s.id}`, 'yellow')
    else if (st?.state === 'error') {
      const why = clean(st.error ?? 'failed to connect').replace(/\s+/g, ' ').trim()
      state = paint(`failed: ${why.length > 160 ? `${why.slice(0, 159)}…` : why}`, 'red')
    } else state = paint('not checked', 'dim')
    const auth = t !== 'stdio' && s.hasOAuth ? ' (signed in)' : ''
    return `  ${s.id.padEnd(width)}  [${t}]  ${clean(target)}${auth}\n  ${' '.repeat(width)}  ${state}`
  })
  return `${lines.join('\n')}\n`
}

async function listServers(deps: McpCliDeps): Promise<number> {
  const servers = deps.servers()
  const enabled = servers.filter((s) => s.enabled)
  let statuses: McpServerStatus[] = []
  if (enabled.length) {
    deps.progress?.(`Connecting to ${enabled.length} MCP server${enabled.length === 1 ? '' : 's'}...`)
    try {
      statuses = await deps.connect(enabled)
    } catch (e) {
      deps.err(`houston: couldn't check the servers: ${clean((e as Error).message)}\n`)
    }
  }
  deps.out(renderMcpCliList(servers, statuses, deps.paint))
  // A server that fails to connect is the thing a script running this wants to know.
  return statuses.some((s) => s.state === 'error') ? 1 : 0
}

/** Split `add`'s words at `--`: Houston's own flags before it, the server's command after. */
export function parseMcpAddArgs(
  rest: string[]
): { kind: 'remote'; url: string; name: string; sse: boolean } | { kind: 'stdio'; name: string; command: string; args: string[] } | { error: string } {
  const dd = rest.indexOf('--')
  const head = dd >= 0 ? rest.slice(0, dd) : rest
  const tail = dd >= 0 ? rest.slice(dd + 1) : []
  let url: string | undefined
  let sse = false
  const words: string[] = []
  for (let i = 0; i < head.length; i++) {
    const a = head[i]
    if (a === '--url') {
      if (head[i + 1] === undefined) return { error: '--url needs a URL' }
      url = head[++i]
    } else if (a.startsWith('--url=')) url = a.slice('--url='.length)
    else if (a === '--sse') sse = true
    else if (a.startsWith('-')) return { error: `unknown option for mcp add: ${clean(a)}` }
    else words.push(a)
  }
  if (url !== undefined) {
    if (tail.length) return { error: 'a remote server (--url) takes no command after --' }
    if (words.length > 1) return { error: `unexpected argument: ${clean(words[1])}` }
    return { kind: 'remote', url, name: words[0] ?? '', sse }
  }
  if (sse) return { error: '--sse goes with --url <url>' }
  if (!words.length) return { error: 'name the server: houston mcp add <name> -- <command> [args...]' }
  if (words.length > 1 || dd < 0) {
    return { error: `put the server's command after --: houston mcp add ${clean(words[0])} -- <command> [args...]` }
  }
  if (!tail.length) return { error: 'a command to spawn is required after -- (e.g. npx)' }
  return { kind: 'stdio', name: words[0], command: tail[0], args: tail.slice(1) }
}

function addServer(rest: string[], deps: McpCliDeps): number {
  const parsed = parseMcpAddArgs(rest)
  if ('error' in parsed) return usageError(parsed.error, deps)
  const servers = deps.servers()
  const ids = servers.map((s) => s.id)
  let built: McpServerConfig | { error: string }
  if (parsed.kind === 'remote') {
    built = buildRemoteMcpServer(ids, parsed.url, parsed.name, parsed.sse)
  } else {
    // The interactive form splits a typed line on spaces; here the shell already split
    // the words, so an argument with a space in it stays one argument.
    built = buildStdioMcpServer(ids, parsed.name, parsed.command, '')
    if (!('error' in built) && parsed.args.length) built = { ...built, args: parsed.args }
  }
  if ('error' in built) {
    // The /mcp wording points at /mcp login; from a shell it is `houston mcp login`.
    deps.err(`houston: ${built.error.replace('/mcp login', 'houston mcp login <name>')}\n`)
    return 2
  }
  deps.save([...servers, built])
  const where =
    transportOf(built) === 'stdio' ? [built.command, ...(built.args ?? [])].join(' ') : `${built.url} (${built.transport})`
  deps.out(`Added MCP server "${built.id}": ${clean(where)}\nIt connects at the start of your next message in any session.\n`)
  if (transportOf(built) !== 'stdio') deps.out(`If it asks you to sign in, run: houston mcp login ${built.id}\n`)
  return 0
}

function oneServer(rest: string[], verb: string, deps: McpCliDeps): McpServerConfig | number {
  if (rest.length !== 1) return usageError(`mcp ${verb} takes one server name`, deps)
  const servers = deps.servers()
  const server = findServer(servers, rest[0])
  if (!server) {
    deps.err(
      `houston: no MCP server "${clean(rest[0])}"${servers.length ? ` (servers: ${servers.map((s) => s.id).join(', ')})` : ''}\n`
    )
    return 1
  }
  return server
}

function removeServer(rest: string[], deps: McpCliDeps): number {
  const server = oneServer(rest, 'remove', deps)
  if (typeof server === 'number') return server
  deps.save(deps.servers().filter((s) => s.id !== server.id))
  deps.out(`Removed MCP server "${server.id}".\n`)
  return 0
}

async function signInOrOut(verb: 'login' | 'logout', rest: string[], deps: McpCliDeps): Promise<number> {
  const server = oneServer(rest, verb, deps)
  if (typeof server === 'number') return server
  if (transportOf(server) === 'stdio' || !server.url) {
    deps.err(`houston: "${server.id}" is a local stdio server; sign-in applies to remote (http/sse) servers\n`)
    return 1
  }
  if (!deps.login || !deps.logout) {
    deps.err('houston: OAuth sign-in is unavailable here\n')
    return 1
  }
  if (verb === 'logout') {
    if (!server.hasOAuth) {
      deps.out(`"${server.id}" has no stored sign-in.\n`)
      return 0
    }
    deps.logout(server.id)
    deps.out(`Signed out of "${server.id}".\n`)
    return 0
  }
  try {
    // The flow's own messages include the sign-in URL, for when no browser opens.
    await deps.login(server, (message) => deps.out(`${stripControlCharsKeepLines(message)}\n`))
  } catch (e) {
    deps.err(`houston: sign-in failed: ${clean((e as Error).message)}\n`)
    return 1
  }
  deps.out(`Signed in to "${server.id}".\n`)
  return 0
}
