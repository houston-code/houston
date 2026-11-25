import { version as APP_VERSION } from '../../../package.json'
import { McpRpcError, type ElicitationWireResult } from './protocol'
import { McpUnsupportedProtocolError } from './version'

/**
 * MCP 2026-07-28, the stateless revision: what the stdio and streamable HTTP clients
 * share when a server speaks it.
 *
 * - No `initialize` handshake. Every request carries the protocol version and the
 *   client's capabilities (and identity) in `params._meta`. A client learns which era a
 *   server is with `server/discover`, and falls back to `initialize` for older servers.
 * - Results carry `resultType`. `"input_required"` (Multi Round-Trip Requests) replaces
 *   server-to-client requests: the server lists what it needs (an elicitation, say) and
 *   the client retries the original request with the answers.
 * - Over HTTP: no sessions, no GET stream, no resumable streams; `Mcp-Method` and
 *   `Mcp-Name` headers on every POST, `x-mcp-header` tool parameters mirrored into
 *   headers, and `subscriptions/listen` for change notifications.
 *
 * The legacy 2024-11-05 HTTP+SSE transport never speaks it.
 */

/** The stateless protocol version Houston speaks. */
export const MODERN_PROTOCOL_VERSION = '2026-07-28'

const META_VERSION = 'io.modelcontextprotocol/protocolVersion'
const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'

/** Error codes the 2026-07-28 revision defines (the range it reserves for itself). */
export const HEADER_MISMATCH = -32020
export const MISSING_REQUIRED_CLIENT_CAPABILITY = -32021
export const UNSUPPORTED_PROTOCOL_VERSION = -32022

/** What a request's `_meta` declares about this client. */
export interface ClientDeclaration {
  /** A responder for elicitation is wired, so form elicitation can be declared. */
  elicitation: boolean
}

/** The client capabilities a request declares. Only what is wired is declared. */
export function clientCapabilities(decl: ClientDeclaration): Record<string, unknown> {
  return decl.elicitation ? { elicitation: { form: {} } } : {}
}

/** The per-request `_meta` fields: protocol version, capabilities, and client identity. */
export function requestMeta(decl: ClientDeclaration): Record<string, unknown> {
  return {
    [META_VERSION]: MODERN_PROTOCOL_VERSION,
    [META_CLIENT_INFO]: { name: 'Houston', version: APP_VERSION },
    [META_CAPABILITIES]: clientCapabilities(decl)
  }
}

/** `params` with the per-request `_meta` merged in, keeping any `_meta` already there (a progress token). */
export function withRequestMeta(params: unknown, decl: ClientDeclaration): Record<string, unknown> {
  const base = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {}
  const existing = base._meta && typeof base._meta === 'object' ? (base._meta as Record<string, unknown>) : {}
  return { ...base, _meta: { ...existing, ...requestMeta(decl) } }
}

/**
 * A `server/discover` answer from a server that speaks 2026-07-28: its capabilities.
 * Null when the answer is not a discovery result, or lists no version Houston speaks
 * statelessly (the caller then falls back to `initialize`).
 */
export function readDiscoverResult(result: unknown): { capabilities: Record<string, unknown> } | null {
  if (!result || typeof result !== 'object') return null
  const r = result as { supportedVersions?: unknown; capabilities?: unknown }
  if (!Array.isArray(r.supportedVersions) || !r.supportedVersions.includes(MODERN_PROTOCOL_VERSION)) return null
  const caps = r.capabilities && typeof r.capabilities === 'object' ? (r.capabilities as Record<string, unknown>) : {}
  return { capabilities: caps }
}

/**
 * How a failed `server/discover` reads. A server that answers with one of the
 * revision's own errors speaks a modern version, so Houston must not fall back to
 * `initialize`: an UnsupportedProtocolVersion becomes {@link McpUnsupportedProtocolError}
 * naming what the server supports, and the other two are returned to be thrown as they
 * are. Any other error means a legacy server: null, fall back.
 */
export function modernDiscoverError(e: unknown): Error | null {
  if (!(e instanceof McpRpcError) || e.code === undefined) return null
  if (e.code === UNSUPPORTED_PROTOCOL_VERSION) {
    const supported = (e.data as { supported?: unknown } | undefined)?.supported
    const list = Array.isArray(supported) ? supported.filter((v): v is string => typeof v === 'string') : []
    return new McpUnsupportedProtocolError((list.join(', ') || 'an unknown version').slice(0, 64))
  }
  if (e.code === HEADER_MISMATCH || e.code === MISSING_REQUIRED_CLIENT_CAPABILITY) return e
  return null
}

/** A result's `resultType`; an older server's result without one is `"complete"`. */
export function resultTypeOf(result: unknown): string {
  const t = result && typeof result === 'object' ? (result as { resultType?: unknown }).resultType : undefined
  return typeof t === 'string' ? t : 'complete'
}

/** Most rounds of input one request may ask for before Houston gives up on it. */
export const MAX_INPUT_ROUNDS = 8

/** Most input requests in one round. */
const MAX_INPUT_REQUESTS = 16

/** Whether an elicitation request is form mode (`mode` absent or `"form"`). */
function isFormElicitation(params: unknown): boolean {
  const mode = params && typeof params === 'object' ? (params as { mode?: unknown }).mode : undefined
  return mode === undefined || mode === 'form'
}

/**
 * Run a request under the Multi Round-Trip Requests pattern: send it, and while the
 * server answers `input_required`, gather what it asked for and send the request again
 * (a new request, so a new id) with `inputResponses`, echoing the server's
 * `requestState` exactly. Houston declares only form elicitation, so that is all it
 * answers, through the same responder (so the same dialog in every client) that a
 * server-sent `elicitation/create` uses. Anything else a server asks for fails the
 * request, since it was never declared. Bounded at {@link MAX_INPUT_ROUNDS} rounds; a
 * stopped run (`signal`) ends it between rounds. Returns the final, complete result.
 */
export async function runWithInputs(
  send: (params: Record<string, unknown>) => Promise<unknown>,
  params: Record<string, unknown>,
  opts: {
    method: string
    onElicit?: (params: unknown) => Promise<ElicitationWireResult>
    signal?: AbortSignal
  }
): Promise<unknown> {
  let current = params
  for (let round = 0; ; round++) {
    const result = await send(current)
    const type = resultTypeOf(result)
    if (type === 'complete') return result
    if (type !== 'input_required') {
      throw new Error(`MCP ${opts.method} returned a result of an unknown type (${JSON.stringify(type).slice(0, 40)})`)
    }
    if (round + 1 >= MAX_INPUT_ROUNDS) {
      throw new Error(`MCP ${opts.method} asked for more input ${MAX_INPUT_ROUNDS} times; Houston stopped asking`)
    }
    const r = result as { inputRequests?: unknown; requestState?: unknown }
    const asked =
      r.inputRequests && typeof r.inputRequests === 'object' && !Array.isArray(r.inputRequests)
        ? Object.entries(r.inputRequests as Record<string, unknown>)
        : []
    if (asked.length > MAX_INPUT_REQUESTS) {
      throw new Error(`MCP ${opts.method} asked for ${asked.length} inputs at once; the limit is ${MAX_INPUT_REQUESTS}`)
    }
    const inputResponses: Record<string, unknown> = {}
    for (const [key, req] of asked) {
      const { method, params: reqParams } = (req && typeof req === 'object' ? req : {}) as {
        method?: unknown
        params?: unknown
      }
      if (method !== 'elicitation/create' || !opts.onElicit || !isFormElicitation(reqParams)) {
        const what = typeof method === 'string' ? method.slice(0, 60) : 'an unknown request'
        throw new Error(`MCP ${opts.method} asked for ${what}, which Houston does not offer`)
      }
      // A failed responder (the run stopped) is a cancel, as with a server-sent request.
      inputResponses[key] = await opts.onElicit(reqParams).catch((): ElicitationWireResult => ({ action: 'cancel' }))
    }
    if (opts.signal?.aborted) throw new Error(`MCP ${opts.method} was cancelled`)
    // Only this round's answers and state go back; an earlier round's never carry over.
    const original = { ...current }
    delete original.inputResponses
    delete original.requestState
    current = {
      ...original,
      ...(asked.length ? { inputResponses } : {}),
      ...(typeof r.requestState === 'string' ? { requestState: r.requestState } : {})
    }
  }
}

// ---- Streamable HTTP request headers ----

const SENTINEL = /^=\?base64\?.*\?=$/

/**
 * A header value for `Mcp-Name` or `Mcp-Param-*`: the value itself when it is plain
 * visible ASCII with no surrounding space, else the revision's Base64 form
 * (`=?base64?...?=`, of the UTF-8 bytes). A plain value that looks like that form is
 * encoded too, so it can't be misread.
 */
export function headerValue(value: string): string {
  const plain = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(value) && !SENTINEL.test(value)
  return plain ? value : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/** The methods whose `Mcp-Name` header carries `params.name` or `params.uri`. */
const NAMED_METHODS: Record<string, 'name' | 'uri'> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri'
}

/** The version, `Mcp-Method` and (where the revision requires it) `Mcp-Name` headers for one request. */
export function standardRequestHeaders(method: string, params: unknown): Record<string, string> {
  const out: Record<string, string> = { 'mcp-protocol-version': MODERN_PROTOCOL_VERSION, 'mcp-method': method }
  const field = NAMED_METHODS[method]
  const value = field && params && typeof params === 'object' ? (params as Record<string, unknown>)[field] : undefined
  if (typeof value === 'string') out['mcp-name'] = headerValue(value)
  return out
}

/** An HTTP field-name token (RFC 9110 `tchar`s). */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** One `x-mcp-header` annotation: the header name part and the property path it reads. */
export interface HeaderParam {
  name: string
  path: string[]
}

/**
 * The `x-mcp-header` annotations of a tool's input schema, or why the tool must be
 * rejected. An annotation must be a token, unique ignoring case, on a string, integer or
 * boolean property reached only through `properties` keys from the root. One anywhere
 * else (inside `items`, a combinator, a `$ref`) makes the definition invalid, and the
 * spec requires such a tool to be left out of the list.
 */
export function xMcpHeaderParams(schema: unknown): { params: HeaderParam[] } | { problem: string } {
  const params: HeaderParam[] = []
  const seen = new Set<string>()
  let problem: string | null = null
  const walk = (node: unknown, path: string[], reachable: boolean, depth: number): void => {
    if (problem || !node || typeof node !== 'object' || depth > 32) return
    if (Array.isArray(node)) {
      for (const n of node) walk(n, path, false, depth + 1)
      return
    }
    const obj = node as Record<string, unknown>
    if ('x-mcp-header' in obj) {
      const name = obj['x-mcp-header']
      const where = path.join('.') || '(root)'
      if (!reachable || path.length === 0) {
        problem = `the x-mcp-header on "${where}" is not on a property reachable through properties alone`
        return
      }
      if (typeof name !== 'string' || !TOKEN.test(name)) {
        problem = `the x-mcp-header on "${where}" is not a valid header name`
        return
      }
      if (!['string', 'integer', 'boolean'].includes(obj.type as string)) {
        problem = `the x-mcp-header on "${where}" is on a property that is not a string, integer or boolean`
        return
      }
      if (seen.has(name.toLowerCase())) {
        problem = `the x-mcp-header "${name}" is used more than once`
        return
      }
      seen.add(name.toLowerCase())
      params.push({ name, path })
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [prop, sub] of Object.entries(value as Record<string, unknown>)) walk(sub, [...path, prop], reachable, depth + 1)
      } else if (key !== 'x-mcp-header') {
        walk(value, path, false, depth + 1)
      }
    }
  }
  walk(schema, [], true, 0)
  return problem ? { problem } : { params }
}

/** The `Mcp-Param-*` headers for a call with `args`, from the tool's annotated parameters. */
export function mcpParamHeaders(params: readonly HeaderParam[], args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { name, path } of params) {
    let value: unknown = args
    for (const key of path) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
    if (value === undefined || value === null) continue
    let text: string
    if (typeof value === 'string') text = value
    else if (typeof value === 'boolean') text = value ? 'true' : 'false'
    else if (typeof value === 'number' && Number.isSafeInteger(value)) text = String(value)
    else continue // not a type the annotation allows: no header, and the server rejects the call if it needs one
    out[`mcp-param-${name.toLowerCase()}`] = headerValue(text)
  }
  return out
}

/** The `subscriptions/listen` filter for the lists a server declared. */
export function listenFilter(capable: { tools: boolean; resources: boolean; prompts: boolean }): Record<string, boolean> {
  return {
    ...(capable.tools ? { toolsListChanged: true } : {}),
    ...(capable.prompts ? { promptsListChanged: true } : {}),
    ...(capable.resources ? { resourcesListChanged: true } : {})
  }
}

/** The `_meta` key a `subscriptions/listen` stream tags its notifications with. */
export const SUBSCRIPTION_ID_META = 'io.modelcontextprotocol/subscriptionId'
