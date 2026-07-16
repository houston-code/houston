import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

/**
 * OAuth 2.1 client for remote MCP servers, per the MCP authorization spec
 * (2025-06-18). Most hosted MCP servers are OAuth-only — no static bearer token
 * to paste — so Houston acts as a full public OAuth client:
 *
 *   1. **Discovery** — elicit a 401 from the MCP endpoint and follow its
 *      `WWW-Authenticate: … resource_metadata="…"` to the protected-resource
 *      metadata (RFC 9728), which names the authorization server; fall back to
 *      the well-known paths, and finally to the server origin itself (the
 *      2025-03-26 spec's default). Authorization-server metadata comes from
 *      RFC 8414 / OpenID discovery, with the spec's default endpoint paths as a
 *      last resort.
 *   2. **Dynamic client registration** (RFC 7591) — register "Houston" as a
 *      public client on each sign-in, so no pre-provisioned client id is needed.
 *   3. **Authorization-code + PKCE (S256)** — a one-shot loopback HTTP server
 *      receives the redirect; the user's browser is opened to the authorize URL.
 *      The RFC 8707 `resource` indicator binds the tokens to this MCP server.
 *   4. **Refresh** — `refreshMcpOAuth` re-mints an expired access token from the
 *      stored refresh token without user interaction.
 *
 * This module is engine code: no Electron imports, and every side effect (fetch,
 * browser opening) is injectable for tests. Token persistence lives with the
 * host (see `agentHost.getMcpOAuth`/`setMcpOAuth`); this module only mints.
 */

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/**
 * A minted MCP OAuth token set, persisted per server id by the host. Carries the
 * client registration and token endpoint alongside the tokens so a refresh never
 * needs to re-run discovery. Every field except the metadata is secret-shaped;
 * the whole blob lives in the host's credential store, never in settings.json.
 */
export interface McpOAuthTokens {
  access: string
  refresh?: string
  /** Epoch ms when `access` expires; absent when the server didn't say. */
  expiresAt?: number
  /** Space-separated scopes actually granted, when reported. */
  scope?: string
  /** The registered (usually dynamically) OAuth client id. */
  clientId: string
  /** Client secret, when registration issued one (public clients get none). */
  clientSecret?: string
  /** Token endpoint used for the exchange — reused for refresh. */
  tokenEndpoint: string
  /** RFC 8707 resource indicator (the canonical MCP server URI), when sent. */
  resource?: string
}

/** Authorization-server + resource facts needed to run the interactive flow. */
export interface McpAuthServerInfo {
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
  /** Scopes advertised by the resource's metadata, requested verbatim. */
  scopes?: string[]
  /** Canonical resource URI of the MCP server (RFC 8707 `resource` value). */
  resource: string
}

export interface McpOAuthFlowDeps {
  fetchFn?: FetchFn
  /** Open a URL in the user's browser. Return false when nothing could open. */
  openUrl?: (url: string) => boolean | Promise<boolean>
  /** Progress sink (user-visible status lines, including the authorize URL). */
  onStatus?: (message: string) => void
  /** Whole-flow timeout waiting for the browser redirect (default 5 minutes). */
  timeoutMs?: number
}

const METADATA_TIMEOUT_MS = 10_000
const FLOW_TIMEOUT_MS = 5 * 60_000
/** Refresh when the access token is within this margin of expiry. */
export const EXPIRY_MARGIN_MS = 60_000

// ---- small pure helpers ------------------------------------------------------

/** Base64url without padding (RFC 4648 §5), as OAuth PKCE requires. */
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A fresh PKCE verifier/challenge pair (S256). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/**
 * The canonical resource URI for an MCP server URL (RFC 8707 via the MCP spec):
 * lowercased scheme + host, no fragment, and no bare trailing slash. The path is
 * kept — `https://host/mcp` and `https://host/other` are different resources.
 */
export function canonicalResourceUri(serverUrl: string): string {
  const u = new URL(serverUrl)
  u.hash = ''
  let s = u.toString()
  if (u.pathname === '/' && !u.search) s = s.replace(/\/$/, '')
  return s
}

/**
 * Pull the `resource_metadata` URL out of a `WWW-Authenticate` challenge
 * (RFC 9728 §5.1). Returns null when the header doesn't carry one.
 */
export function parseResourceMetadataUrl(header: string | null): string | null {
  if (!header) return null
  const m = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header)
  return m ? m[1] : null
}

/**
 * Well-known URLs to try for protected-resource metadata (RFC 9728), given the
 * MCP server URL: the path-inserted form first, then the root form.
 */
export function protectedResourceMetadataUrls(serverUrl: string): string[] {
  const u = new URL(serverUrl)
  const path = u.pathname.replace(/\/$/, '')
  const urls = new Set<string>()
  if (path && path !== '/') urls.add(`${u.origin}/.well-known/oauth-protected-resource${path}`)
  urls.add(`${u.origin}/.well-known/oauth-protected-resource`)
  return [...urls]
}

/**
 * Well-known URLs to try for authorization-server metadata, given the issuer
 * URL: RFC 8414 (path-inserted, then root) before OpenID discovery (path-inserted,
 * then issuer-appended) — the MCP spec's priority order.
 */
export function authServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer)
  const path = u.pathname.replace(/\/$/, '')
  const urls = new Set<string>()
  if (path && path !== '/') {
    urls.add(`${u.origin}/.well-known/oauth-authorization-server${path}`)
    urls.add(`${u.origin}/.well-known/oauth-authorization-server`)
    urls.add(`${u.origin}/.well-known/openid-configuration${path}`)
    urls.add(`${u.origin}${path}/.well-known/openid-configuration`)
  } else {
    urls.add(`${u.origin}/.well-known/oauth-authorization-server`)
    urls.add(`${u.origin}/.well-known/openid-configuration`)
  }
  return [...urls]
}

/**
 * Endpoint URLs the flow will hit (or send the browser to) must be https, or
 * plain http only on a loopback host — anything else (a downgrade, a custom
 * scheme from hostile metadata) is refused before credentials or the user's
 * browser ever touch it.
 */
export function isAllowedEndpointUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:') return true
    if (u.protocol !== 'http:') return false
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1'
  } catch {
    return false
  }
}

/** True when the access token is missing an expiry or within the refresh margin. */
export function tokensNeedRefresh(tokens: McpOAuthTokens, now = Date.now()): boolean {
  if (!tokens.expiresAt) return false
  return now >= tokens.expiresAt - EXPIRY_MARGIN_MS
}

// ---- metadata fetching -------------------------------------------------------

/** GET a JSON document, or null on any failure (non-2xx, timeout, non-JSON). */
async function fetchJson(url: string, fetchFn: FetchFn): Promise<Record<string, unknown> | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS)
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal
    })
    if (!res.ok) return null
    const parsed = (await res.json()) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function asStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined
}

/**
 * Probe the MCP endpoint unauthenticated to elicit its `WWW-Authenticate`
 * challenge (a minimal JSON-RPC POST — servers answer 401 before reading the
 * body). Returns the advertised resource-metadata URL, or null.
 */
async function probeResourceMetadataUrl(serverUrl: string, fetchFn: FetchFn): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS)
  try {
    const res = await fetchFn(serverUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
      signal: controller.signal
    })
    await res.text().catch(() => '')
    return parseResourceMetadataUrl(res.headers.get('www-authenticate'))
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Discover the authorization server for an MCP endpoint. Never throws for a
 * merely metadata-less server — per the spec's fallbacks it degrades to default
 * endpoint paths on the issuer origin — but does throw when the discovered
 * endpoints are unusable (non-https, unparseable).
 */
export async function discoverAuthServer(serverUrl: string, fetchFn: FetchFn = fetch): Promise<McpAuthServerInfo> {
  const resource = canonicalResourceUri(serverUrl)

  // 1. Protected-resource metadata (RFC 9728): the 401 challenge's URL first,
  //    then the well-known locations.
  const candidates = [
    ...(await probeResourceMetadataUrl(serverUrl, fetchFn).then((u) => (u ? [u] : []))),
    ...protectedResourceMetadataUrls(serverUrl)
  ]
  let issuers: string[] = []
  let scopes: string[] | undefined
  for (const url of candidates) {
    if (!isAllowedEndpointUrl(url)) continue
    const meta = await fetchJson(url, fetchFn)
    const servers = meta && asStringArray(meta.authorization_servers)
    if (servers?.length) {
      issuers = servers
      scopes = asStringArray(meta!.scopes_supported)
      break
    }
  }
  // No resource metadata anywhere: the pre-RFC 9728 default is that the MCP
  // server's own origin is the authorization server.
  if (issuers.length === 0) issuers = [new URL(serverUrl).origin]

  // 2. Authorization-server metadata (RFC 8414 / OpenID discovery) from the
  //    first issuer that yields a usable document.
  for (const issuer of issuers) {
    if (!isAllowedEndpointUrl(issuer)) continue
    for (const url of authServerMetadataUrls(issuer)) {
      const meta = await fetchJson(url, fetchFn)
      const authorizationEndpoint = meta && asString(meta.authorization_endpoint)
      const tokenEndpoint = meta && asString(meta.token_endpoint)
      if (!authorizationEndpoint || !tokenEndpoint) continue
      if (!isAllowedEndpointUrl(authorizationEndpoint) || !isAllowedEndpointUrl(tokenEndpoint)) {
        throw new Error(`The authorization server for ${resource} advertises non-https endpoints; refusing to continue.`)
      }
      const registrationEndpoint = asString(meta.registration_endpoint)
      return {
        authorizationEndpoint,
        tokenEndpoint,
        registrationEndpoint: registrationEndpoint && isAllowedEndpointUrl(registrationEndpoint) ? registrationEndpoint : undefined,
        scopes: scopes ?? asStringArray(meta.scopes_supported),
        resource
      }
    }
  }

  // 3. No metadata at all: the MCP spec's default endpoint paths on the issuer.
  const origin = new URL(issuers[0]).origin
  if (!isAllowedEndpointUrl(origin)) {
    throw new Error(`Cannot discover an OAuth authorization server for ${resource}.`)
  }
  return {
    authorizationEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/token`,
    registrationEndpoint: `${origin}/register`,
    scopes,
    resource
  }
}

// ---- dynamic client registration ---------------------------------------------

/**
 * Register Houston as a public OAuth client (RFC 7591). Registration is per
 * sign-in: the loopback redirect port is ephemeral, so the registered
 * `redirect_uris` must match this run's callback URL exactly.
 */
export async function registerClient(
  info: McpAuthServerInfo,
  redirectUri: string,
  fetchFn: FetchFn = fetch
): Promise<{ clientId: string; clientSecret?: string }> {
  if (!info.registrationEndpoint) {
    throw new Error(
      'This server\'s authorization server does not offer dynamic client registration. ' +
        'Houston cannot register itself as an OAuth client; if the service issues static credentials ' +
        'or API tokens, configure them as an Authorization header instead.'
    )
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetchFn(info.registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Houston',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(info.scopes?.length ? { scope: info.scopes.join(' ') } : {})
      }),
      signal: controller.signal
    })
  } catch (e) {
    throw new Error(`OAuth client registration failed: ${(e as Error).message}`, { cause: e })
  } finally {
    clearTimeout(timer)
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok || !body) {
    const detail = body && asString(body.error_description ?? body.error)
    throw new Error(`OAuth client registration failed: HTTP ${res.status}${detail ? ` (${detail})` : ''}`)
  }
  const clientId = asString(body.client_id)
  if (!clientId) throw new Error('OAuth client registration returned no client_id.')
  return { clientId, clientSecret: asString(body.client_secret) }
}

// ---- token requests ------------------------------------------------------------

interface TokenResponse {
  access: string
  refresh?: string
  expiresAt?: number
  scope?: string
}

/** POST an x-www-form-urlencoded grant to the token endpoint and parse the token set. */
async function tokenRequest(
  tokenEndpoint: string,
  params: Record<string, string>,
  fetchFn: FetchFn
): Promise<TokenResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetchFn(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal
    })
  } catch (e) {
    throw new Error(`OAuth token request failed: ${(e as Error).message}`, { cause: e })
  } finally {
    clearTimeout(timer)
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok || !body) {
    const detail = body && asString(body.error_description ?? body.error)
    throw new Error(`OAuth token request failed: HTTP ${res.status}${detail ? ` (${detail})` : ''}`)
  }
  const access = asString(body.access_token)
  if (!access) throw new Error('OAuth token response carried no access_token.')
  const tokenType = asString(body.token_type)
  if (tokenType && tokenType.toLowerCase() !== 'bearer') {
    throw new Error(`OAuth token response has unsupported token_type "${tokenType}".`)
  }
  const expiresIn = Number(body.expires_in)
  return {
    access,
    refresh: asString(body.refresh_token),
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
    scope: asString(body.scope)
  }
}

/**
 * Mint a fresh access token from a stored refresh token. Throws when the token
 * set has no refresh token (the user must sign in again interactively). Keeps
 * the old refresh token when the server doesn't rotate it.
 */
export async function refreshMcpOAuth(tokens: McpOAuthTokens, fetchFn: FetchFn = fetch): Promise<McpOAuthTokens> {
  if (!tokens.refresh) throw new Error('No refresh token stored; sign in again.')
  const minted = await tokenRequest(
    tokens.tokenEndpoint,
    {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh,
      client_id: tokens.clientId,
      ...(tokens.clientSecret ? { client_secret: tokens.clientSecret } : {}),
      ...(tokens.resource ? { resource: tokens.resource } : {})
    },
    fetchFn
  )
  return {
    ...tokens,
    access: minted.access,
    refresh: minted.refresh ?? tokens.refresh,
    expiresAt: minted.expiresAt,
    scope: minted.scope ?? tokens.scope
  }
}

// ---- loopback redirect + interactive flow --------------------------------------

/** Tiny page shown in the browser tab after the redirect lands. */
function callbackHtml(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Houston</title><body style="font-family: system-ui; margin: 4rem auto; max-width: 26rem; text-align: center"><h2>${message}</h2><p>You can close this tab and return to Houston.</p></body>`
}

interface CallbackServer {
  redirectUri: string
  /** Resolves with the authorization code once the redirect lands. */
  waitForCode: Promise<string>
  close(): void
}

/**
 * One-shot loopback HTTP server for the OAuth redirect. Binds 127.0.0.1 on an
 * ephemeral port; answers exactly one GET /callback (validating `state`), then
 * every later request 404s. The caller must `close()` it on every path.
 */
function startCallbackServer(expectedState: string): Promise<CallbackServer> {
  return new Promise((resolveServer, rejectServer) => {
    let done: ((code: string) => void) | null = null
    let fail: ((e: Error) => void) | null = null
    const waitForCode = new Promise<string>((resolve, reject) => {
      done = resolve
      fail = reject
    })
    // The flow may error out (registration, timeout) before anything awaits this
    // promise; close() then rejects it, which must not become an unhandled rejection.
    waitForCode.catch(() => {})
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method !== 'GET' || url.pathname !== '/callback' || !done) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
        return
      }
      const err = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (err) {
        res.writeHead(200, { 'content-type': 'text/html' }).end(callbackHtml('Sign-in was not completed.'))
        fail?.(new Error(`Authorization failed: ${url.searchParams.get('error_description') ?? err}`))
      } else if (!code || state !== expectedState) {
        res.writeHead(400, { 'content-type': 'text/html' }).end(callbackHtml('Sign-in could not be verified.'))
        fail?.(new Error('Authorization redirect was missing a valid code/state.'))
      } else {
        res.writeHead(200, { 'content-type': 'text/html' }).end(callbackHtml('Signed in.'))
        done(code)
      }
      done = null
      fail = null
    })
    server.on('error', (e) => rejectServer(e))
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        rejectServer(new Error('Could not bind the OAuth callback listener.'))
        return
      }
      resolveServer({
        redirectUri: `http://127.0.0.1:${addr.port}/callback`,
        waitForCode,
        close: () => {
          server.close()
          // A close before the redirect landed must not leave the flow hanging.
          fail?.(new Error('OAuth sign-in was cancelled.'))
          done = null
          fail = null
        }
      })
    })
  })
}

/** Default browser opener: the platform's URL handler, detached, best-effort. */
function openWithSystemHandler(url: string): boolean {
  try {
    const [cmd, args] =
      process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]]
          : ['xdg-open', [url]]
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * Run the full interactive sign-in for a remote MCP server: discovery, dynamic
 * client registration, browser authorization with PKCE, and the code-for-token
 * exchange. Resolves to the minted token set (the caller persists it); rejects
 * with a user-readable error on any failure or on timeout.
 */
export async function runMcpOAuthFlow(serverUrl: string, deps: McpOAuthFlowDeps = {}): Promise<McpOAuthTokens> {
  const fetchFn = deps.fetchFn ?? fetch
  const openUrl = deps.openUrl ?? openWithSystemHandler
  const onStatus = deps.onStatus ?? ((): void => {})
  if (!/^https?:\/\//i.test(serverUrl)) throw new Error(`Not a remote MCP server URL: ${serverUrl}`)

  onStatus('Discovering the OAuth authorization server...')
  const info = await discoverAuthServer(serverUrl, fetchFn)

  const state = b64url(randomBytes(16))
  const { verifier, challenge } = pkcePair()
  const callback = await startCallbackServer(state)
  try {
    onStatus('Registering Houston as an OAuth client...')
    const client = await registerClient(info, callback.redirectUri, fetchFn)

    const authorizeUrl = new URL(info.authorizationEndpoint)
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('client_id', client.clientId)
    authorizeUrl.searchParams.set('redirect_uri', callback.redirectUri)
    authorizeUrl.searchParams.set('state', state)
    authorizeUrl.searchParams.set('code_challenge', challenge)
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')
    authorizeUrl.searchParams.set('resource', info.resource)
    if (info.scopes?.length) authorizeUrl.searchParams.set('scope', info.scopes.join(' '))

    const opened = await openUrl(authorizeUrl.toString())
    onStatus(
      opened
        ? `Complete the sign-in in your browser. If it did not open, visit:\n${authorizeUrl}`
        : `Open this URL in your browser to sign in:\n${authorizeUrl}`
    )

    const timeoutMs = deps.timeoutMs ?? FLOW_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const code = await Promise.race([
      callback.waitForCode,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for the browser sign-in (${Math.round(timeoutMs / 60000)} min).`)),
          timeoutMs
        )
      })
    ]).finally(() => clearTimeout(timer))

    onStatus('Exchanging the authorization code for tokens...')
    const minted = await tokenRequest(
      info.tokenEndpoint,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: callback.redirectUri,
        client_id: client.clientId,
        ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
        code_verifier: verifier,
        resource: info.resource
      },
      fetchFn
    )
    return {
      access: minted.access,
      refresh: minted.refresh,
      expiresAt: minted.expiresAt,
      scope: minted.scope,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      tokenEndpoint: info.tokenEndpoint,
      resource: info.resource
    }
  } finally {
    callback.close()
  }
}
