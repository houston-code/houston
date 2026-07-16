import type { McpServerConfig, McpServerStatus } from '@shared/types'
import { mcpEnvScope, mcpHeaderScope } from '@shared/types'

export type { McpServerStatus }
import { mcpToolName, parseElicitationFields } from '@shared/mcp'
import type { ToolContext, ToolDef } from '../agent/tools'
import { getMcpOAuth, getSecretHeaders, setMcpOAuth } from '../agentHost'
import { McpClient, McpUnauthorizedError, type McpConnection } from './client'
import { McpHttpClient } from './http-client'
import { McpSseClient } from './sse-client'
import { canonicalResourceUri, refreshMcpOAuth, tokensNeedRefresh } from './oauth'
import { capMcpOutput, type ElicitationWireResult } from './protocol'
import { log } from '../logger'

/**
 * Manages connections to the configured MCP servers and exposes their tools to
 * the agent as ToolDefs (namespaced, kind "mcp"). Connections are cached for the
 * app session and reused across runs; a server whose config changed is
 * reconnected, and one that's removed/disabled is closed. A server that fails to
 * connect is logged and skipped — it just contributes no tools. The stdio
 * (spawned process), streamable-HTTP, and legacy HTTP+SSE (remote URL) transports
 * are all supported.
 *
 * Remote-server auth is either a static header the user configured or an OAuth
 * token set minted by the interactive sign-in (see `oauth.ts`) and stored by the
 * host. The manager injects the bearer at connect time, refreshes an expired
 * access token proactively (and once more reactively on a 401), and folds the
 * token into the config key so a refresh or sign-out reconnects the server.
 */

interface Connection {
  key: string
  client: McpConnection
}

const connections = new Map<string, Connection>()

const statuses = new Map<string, McpServerStatus>()

/** Last connect/health outcome per configured server, for the settings UIs and /mcp. */
export function getMcpStatuses(): McpServerStatus[] {
  return [...statuses.values()]
}

/** The configs of the last reconcile, so a mid-run reconnect can re-resolve them. */
let lastConfigs: McpServerConfig[] = []

/**
 * The elicitation responder of the tool call currently in flight per server —
 * set by callLive from the run's ToolContext and cleared when the call settles.
 * Connections outlive runs, so this is the bridge from a server's mid-call
 * question to the user of the run that asked. A server that elicits with no
 * call in flight (or from a context that can't ask, e.g. a subagent) gets a
 * decline, never a hang.
 */
const elicitors = new Map<string, NonNullable<ToolContext['elicitMcp']>>()

/**
 * The `onElicit` responder wired into a server's connection: parse the request
 * defensively (it crosses a trust boundary), route it to the in-flight call's
 * responder, and map the answer to the wire shape. Always resolves.
 */
function serverElicit(serverId: string): (params: unknown) => Promise<ElicitationWireResult> {
  return async (params) => {
    const elicit = elicitors.get(serverId)
    if (!elicit) return { action: 'decline' }
    const p = params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
    const message = typeof p.message === 'string' ? p.message.trim() : ''
    if (!message) return { action: 'decline' }
    try {
      const result = await elicit({
        serverId,
        message,
        fields: parseElicitationFields(p.requestedSchema)
      })
      if (result.action === 'accept') return { action: 'accept', content: result.content ?? {} }
      return { action: result.action }
    } catch {
      // The run was cancelled (or the responder failed): tell the server the
      // user cancelled rather than leaving it waiting.
      return { action: 'cancel' }
    }
  }
}

/** Test seam: how stdio MCP clients are constructed (overridable in tests). */
let createClient: () => McpClient = () => new McpClient()
export function _setMcpClientFactory(factory: (() => McpClient) | null): void {
  createClient = factory ?? (() => new McpClient())
}

/** Test seam: how HTTP MCP clients are constructed (overridable in tests). */
let createHttpClient: () => McpHttpClient = () => new McpHttpClient()
export function _setMcpHttpClientFactory(factory: (() => McpHttpClient) | null): void {
  createHttpClient = factory ?? (() => new McpHttpClient())
}

/** Test seam: how SSE MCP clients are constructed (overridable in tests). */
let createSseClient: () => McpSseClient = () => new McpSseClient()
export function _setMcpSseClientFactory(factory: (() => McpSseClient) | null): void {
  createSseClient = factory ?? (() => new McpSseClient())
}

type Transport = 'stdio' | 'http' | 'sse'

/**
 * The transport a server uses: honor an explicit `transport`, else infer from the
 * shape — a `url` with no `command` means a remote server (streamable HTTP).
 */
function transportOf(c: McpServerConfig): Transport {
  if (c.transport === 'sse') return 'sse'
  if (c.transport === 'http') return 'http'
  if (c.transport === 'stdio') return 'stdio'
  return !c.command && c.url ? 'http' : 'stdio'
}

// The real header values live in the encrypted secrets store, not on the config
// (which carries masked values). Resolve them for both the change-detection signature
// and the actual connect, so editing a header value still triggers a reconnect.
// A trusted folder's project server is the exception: its config IS the source of
// truth (the values are plaintext in the repo by its author's choice), and its id
// must never read the user's secret scopes.
function resolveHeaders(c: McpServerConfig): Record<string, string> {
  return c.origin === 'project' ? { ...(c.headers ?? {}) } : getSecretHeaders(mcpHeaderScope(c.id))
}

/** Whether the user configured an explicit Authorization header (any casing). */
function hasAuthorizationHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')
}

/**
 * Whether the server's current URL still matches the resource the token set was
 * minted for (RFC 8707). A token is audience-bound at sign-in; if the URL is
 * later edited to a different resource — innocently or by a compromised
 * renderer rewriting settings — the bearer must NOT follow it to the new host.
 * A token set without a recorded binding (imported by hand) is not gated.
 */
function boundResourceMatches(url: string | undefined, resource: string | undefined): boolean {
  if (!resource) return true
  if (!url) return false
  try {
    return canonicalResourceUri(url) === resource
  } catch {
    return false
  }
}

/**
 * The `Authorization: Bearer` header from a server's stored OAuth token set,
 * refreshing (and re-persisting) the set first when the access token is expired
 * or `force` says the server just rejected it. `{}` when the server has never
 * been signed in, or when its URL no longer matches the resource the tokens are
 * bound to (the server then surfaces as needs-auth instead of leaking the
 * bearer). A failed refresh falls back to the stored access token — the connect
 * attempt will then surface the 401 and its sign-in hint.
 */
async function oauthBearer(c: McpServerConfig, force = false): Promise<Record<string, string>> {
  let tokens = getMcpOAuth(c.id)
  if (!tokens) return {}
  if (!boundResourceMatches(c.url, tokens.resource)) {
    log.warn(
      `MCP server "${c.id}": its URL no longer matches the resource its OAuth tokens were minted for; not sending them. Sign in again for the new URL.`
    )
    return {}
  }
  if ((force || tokensNeedRefresh(tokens)) && tokens.refresh) {
    try {
      tokens = await refreshMcpOAuth(tokens)
      setMcpOAuth(c.id, tokens)
    } catch (e) {
      log.warn(`MCP server "${c.id}": OAuth token refresh failed: ${(e as Error).message}`)
    }
  }
  return { authorization: `Bearer ${tokens.access}` }
}

// Like headers, stdio env VALUES live in the secrets store (scope mcp-env:<id>) —
// except for a project server, whose config carries them verbatim (see above).
function resolveEnv(c: McpServerConfig): Record<string, string> {
  return c.origin === 'project' ? { ...(c.env ?? {}) } : getSecretHeaders(mcpEnvScope(c.id))
}

function configKey(
  c: McpServerConfig,
  headers: Record<string, string>,
  env: Record<string, string>
): string {
  return JSON.stringify([transportOf(c), c.command, c.args ?? [], c.cwd, env, c.url, headers, c.enabled])
}

// Serialize reconciliation so overlapping runs can't interleave on the shared
// `connections` map (one run closing/replacing a connection mid-reconcile).
let ensureLock: Promise<void> = Promise.resolve()
function ensureConnections(configs: McpServerConfig[]): Promise<void> {
  ensureLock = ensureLock.catch(() => undefined).then(() => reconcileConnections(configs))
  return ensureLock
}

async function reconcileConnections(configs: McpServerConfig[]): Promise<void> {
  lastConfigs = configs
  const enabled = configs.filter((c) => c.enabled && c.id && (c.command || c.url))
  const wanted = new Set(enabled.map((c) => c.id))

  // Close connections for servers that are gone or disabled.
  for (const [id, conn] of connections) {
    if (!wanted.has(id)) {
      conn.client.close()
      connections.delete(id)
    }
  }
  for (const id of statuses.keys()) {
    if (!wanted.has(id)) statuses.delete(id)
  }

  for (const c of enabled) {
    const existing = connections.get(c.id)
    const transport = transportOf(c)
    const staticHeaders = resolveHeaders(c)
    const env = resolveEnv(c)
    // OAuth sign-in supplies the bearer for remote servers; an explicit static
    // Authorization header (the user's own token) takes precedence over it.
    const useOAuth = transport !== 'stdio' && !hasAuthorizationHeader(staticHeaders)
    let headers = useOAuth ? { ...staticHeaders, ...(await oauthBearer(c)) } : staticHeaders
    let key = configKey(c, headers, env)
    // Reuse only a live connection with the same config; reconnect if the config
    // changed (including a refreshed/removed OAuth token) or the cached client has
    // since died (so calls don't hang on it).
    if (existing && existing.key === key && !existing.client.isClosed) {
      statuses.set(c.id, {
        id: c.id,
        state: 'connected',
        tools: existing.client.tools.length,
        toolNames: existing.client.tools.map((t) => t.name)
      })
      continue
    }
    if (existing) existing.client.close()

    const connectOnce = async (): Promise<McpConnection> => {
      const client: McpConnection =
        transport === 'http' ? createHttpClient() : transport === 'sse' ? createSseClient() : createClient()
      const onElicit = serverElicit(c.id)
      try {
        if (transport === 'http') await (client as McpHttpClient).connect({ url: c.url ?? '', headers, onElicit })
        else if (transport === 'sse') await (client as McpSseClient).connect({ url: c.url ?? '', headers, onElicit })
        else await (client as McpClient).connect({ command: c.command, args: c.args, env, cwd: c.cwd, onElicit })
        return client
      } catch (e) {
        client.close()
        throw e
      }
    }

    try {
      let client: McpConnection
      try {
        client = await connectOnce()
      } catch (e) {
        // A 401 despite a stored refresh token usually means the access token
        // outlived its expiry since the last refresh: re-mint once and retry.
        if (!(e instanceof McpUnauthorizedError) || !useOAuth || !getMcpOAuth(c.id)?.refresh) throw e
        headers = { ...staticHeaders, ...(await oauthBearer(c, true)) }
        key = configKey(c, headers, env)
        client = await connectOnce()
      }
      connections.set(c.id, { key, client })
      statuses.set(c.id, {
        id: c.id,
        state: 'connected',
        tools: client.tools.length,
        toolNames: client.tools.map((t) => t.name)
      })
    } catch (e) {
      connections.delete(c.id)
      if (e instanceof McpUnauthorizedError && transport !== 'stdio') {
        statuses.set(c.id, { id: c.id, state: 'needs-auth', error: (e as Error).message })
        log.warn(
          `MCP server "${c.id}" requires sign-in (HTTP 401). Sign in from Settings > MCP servers (desktop) or with /mcp login (terminal), or configure an Authorization header.`
        )
      } else {
        statuses.set(c.id, { id: c.id, state: 'error', error: (e as Error).message })
        log.warn(`MCP server "${c.id}" failed to connect: ${(e as Error).message}`)
      }
    }
  }
}

/** Connect the configured servers (best effort) and return their tools as ToolDefs. */
export async function getMcpToolDefs(configs: McpServerConfig[] | undefined): Promise<ToolDef[]> {
  // Reconcile even with no configs when connections are still open, so removing
  // (or disabling) every server actually closes them instead of leaking to quit.
  if (!configs?.length && connections.size === 0) return []
  await ensureConnections(configs ?? [])

  const defs: ToolDef[] = []
  for (const [serverId, conn] of connections) {
    for (const t of conn.client.tools) {
      const fullName = mcpToolName(serverId, t.name)
      const original = t.name
      defs.push({
        kind: 'mcp',
        summarize: () => `${serverId}: ${original}`,
        schema: {
          name: fullName,
          description: t.description ?? `MCP tool "${original}" from server "${serverId}".`,
          parameters:
            t.inputSchema && typeof t.inputSchema === 'object'
              ? t.inputSchema
              : { type: 'object', properties: {} }
        },
        // Resolve the live connection at call time so a reconnect (or removal)
        // between building the tool list and the call doesn't hit a stale client.
        execute: (args, ctx) => callLive(serverId, ctx, (client) => client.callTool(original, args))
      })
    }
  }

  // If any connected server exposes resources or prompts, add meta-tools so the
  // agent can discover and fetch them. Listing is local + side-effect-free (kind
  // 'read'); fetching hits the external server, so it's gated like an MCP call.
  if ([...connections.values()].some((c) => c.client.resources.length > 0)) {
    defs.push(...resourceMetaTools())
  }
  if ([...connections.values()].some((c) => c.client.prompts.length > 0)) {
    defs.push(...promptMetaTools())
  }
  return defs
}

/**
 * Run one call against a server's live connection, capping the (external,
 * unbounded) output before it reaches the context window. If the connection
 * turns out to have died (process exit, stream drop, expired HTTP session),
 * reconnect it now and tell the agent to retry, rather than silently re-running
 * a call that may already have executed server-side.
 *
 * While the call is in flight its run's elicitation responder (when the context
 * has one) is registered for the server, so a server that asks the user for
 * input mid-call reaches the right conversation. MCP-kind calls are sequential
 * within a run, so one slot per server suffices.
 */
async function callLive(
  serverId: string,
  ctx: ToolContext | undefined,
  fn: (client: McpConnection) => Promise<string>
): Promise<string> {
  const live = connections.get(serverId)
  if (!live) return `[MCP server "${serverId}" is no longer connected]`
  const elicit = ctx?.elicitMcp
  if (elicit) elicitors.set(serverId, elicit)
  try {
    return capMcpOutput(await fn(live.client))
  } catch (e) {
    if (!live.client.isClosed) throw e
    await ensureConnections(lastConfigs).catch(() => {})
    const revived = connections.get(serverId)
    const hint =
      revived && !revived.client.isClosed
        ? ' The server has been reconnected; retry the call.'
        : ''
    return `[MCP server "${serverId}" connection was lost mid-call: ${(e as Error).message}.${hint}]`
  } finally {
    if (elicit && elicitors.get(serverId) === elicit) elicitors.delete(serverId)
  }
}

/** The `mcp_list_resources` / `mcp_read_resource` meta-tools (added only when some server has resources). */
function resourceMetaTools(): ToolDef[] {
  return [
    {
      kind: 'read',
      summarize: () => 'List MCP resources',
      schema: {
        name: 'mcp_list_resources',
        description:
          'List the resources exposed by connected MCP servers — each with its server id, uri, and description. Read one with mcp_read_resource({ server, uri }).',
        parameters: { type: 'object', properties: {} }
      },
      execute: () => {
        const lines: string[] = []
        for (const [id, conn] of connections) {
          for (const r of conn.client.resources) {
            const bits = [`server="${id}"`, `uri="${r.uri}"`]
            if (r.name) bits.push(`name="${r.name}"`)
            if (r.mimeType) bits.push(`mime="${r.mimeType}"`)
            lines.push(`- ${bits.join(' ')}${r.description ? ` — ${r.description}` : ''}`)
          }
        }
        return Promise.resolve(lines.length ? lines.join('\n') : 'No MCP resources are available.')
      }
    },
    {
      kind: 'mcp',
      summarize: (a) => `Read MCP resource: ${typeof a.uri === 'string' ? a.uri : '?'}`,
      schema: {
        name: 'mcp_read_resource',
        description:
          "Read the contents of a resource exposed by a connected MCP server. Use mcp_list_resources first to find a resource's server id and uri.",
        parameters: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'The MCP server id (from mcp_list_resources).' },
            uri: { type: 'string', description: 'The resource uri to read.' }
          },
          required: ['server', 'uri']
        }
      },
      execute: (args, ctx) => {
        const server = typeof args.server === 'string' ? args.server : ''
        const uri = typeof args.uri === 'string' ? args.uri : ''
        if (!server || !uri) return Promise.resolve('Both "server" and "uri" are required.')
        return callLive(server, ctx, (client) => client.readResource(uri))
      }
    }
  ]
}

/** The `mcp_list_prompts` / `mcp_get_prompt` meta-tools (added only when some server has prompts). */
function promptMetaTools(): ToolDef[] {
  return [
    {
      kind: 'read',
      summarize: () => 'List MCP prompts',
      schema: {
        name: 'mcp_list_prompts',
        description:
          'List the prompt templates exposed by connected MCP servers, each with its server id, name, and arguments. Fetch one with mcp_get_prompt({ server, name, arguments }).',
        parameters: { type: 'object', properties: {} }
      },
      execute: () => {
        const lines: string[] = []
        for (const [id, conn] of connections) {
          for (const p of conn.client.prompts) {
            const bits = [`server="${id}"`, `name="${p.name}"`]
            const args = (p.arguments ?? [])
              .map((a) => `${a.name}${a.required ? '' : '?'}`)
              .join(', ')
            if (args) bits.push(`arguments=(${args})`)
            lines.push(`- ${bits.join(' ')}${p.description ? ` — ${p.description}` : ''}`)
          }
        }
        return Promise.resolve(lines.length ? lines.join('\n') : 'No MCP prompts are available.')
      }
    },
    {
      kind: 'mcp',
      summarize: (a) => `Get MCP prompt: ${typeof a.name === 'string' ? a.name : '?'}`,
      schema: {
        name: 'mcp_get_prompt',
        description:
          "Fetch a prompt template from a connected MCP server, with its arguments filled in. Use mcp_list_prompts first to find a prompt's server id, name, and arguments.",
        parameters: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'The MCP server id (from mcp_list_prompts).' },
            name: { type: 'string', description: 'The prompt name.' },
            arguments: {
              type: 'object',
              description: 'Prompt arguments as string values (see mcp_list_prompts).',
              additionalProperties: { type: 'string' }
            }
          },
          required: ['server', 'name']
        }
      },
      execute: (args, ctx) => {
        const server = typeof args.server === 'string' ? args.server : ''
        const name = typeof args.name === 'string' ? args.name : ''
        if (!server || !name) return Promise.resolve('Both "server" and "name" are required.')
        const promptArgs: Record<string, string> = {}
        if (args.arguments && typeof args.arguments === 'object') {
          for (const [k, v] of Object.entries(args.arguments as Record<string, unknown>)) {
            promptArgs[k] = typeof v === 'string' ? v : JSON.stringify(v)
          }
        }
        return callLive(server, ctx, (client) => client.getPrompt(name, promptArgs))
      }
    }
  ]
}

/** Close every MCP connection (wired on app shutdown). */
export function disconnectAllMcp(): void {
  for (const conn of connections.values()) conn.client.close()
  connections.clear()
  statuses.clear()
}
