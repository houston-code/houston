import { BlockList, isIP } from 'node:net'
import { Agent, Dispatcher1Wrapper, EnvHttpProxyAgent, type Dispatcher } from 'undici'
import { log } from './logger'

/**
 * Outbound HTTP(S) proxy for Houston's own API traffic: the model provider SDKs, MCP
 * http/sse servers (and their OAuth endpoints), and the web search APIs.
 *
 * Node's `fetch` ignores `HTTPS_PROXY` and friends, so on a network that only lets
 * traffic out through a proxy every provider call failed with a bare "Connection
 * error." while a browser on the same machine worked. This routes those requests
 * through the proxy the user named: the `proxyUrl` setting when set, otherwise the
 * conventional `HTTPS_PROXY` / `HTTP_PROXY` (either case) from the environment, with
 * `NO_PROXY` honoured either way (names, dot-suffixes, and CIDR ranges such as
 * `10.0.0.0/8`). The user's own machine and private network always go direct (see
 * {@link isLocalModelHost}): a remote proxy can't reach them, so a local or LAN model
 * server keeps working under a corporate proxy.
 *
 * Deliberately not routed here:
 *   - `web_fetch` connects directly to an address it has resolved and vetted (its SSRF
 *     guard pins the IP), and a proxy would resolve the name again on its side, so the
 *     pin would no longer mean anything. It uses its own transport, not this fetch.
 *   - Shell commands. The sandbox injects its own egress proxy into the child
 *     environment; nothing here reads or writes `process.env`.
 *
 * With no proxy configured, requests still go out through one shared agent of our own,
 * which differs from fetch's default only in how long it keeps an idle connection (see
 * {@link KEEP_ALIVE_TIMEOUT_MS}).
 *
 * The agents come from the `undici` package but are handed to the runtime's global
 * `fetch`, which is built on the undici bundled into Node (and so into Electron). Those
 * two need not share a version: undici 8 agents speak a newer handler API than the
 * bundled undici 7 fetch calls them with, and reject its requests outright. Each agent
 * is therefore wrapped in {@link legacyCompatible}, undici's own adapter for older
 * callers, which passes a handler already on the newer API through unchanged, so the
 * same code keeps working once the bundled fetch moves to undici 8.
 */

/**
 * How long an idle connection to a provider stays open for the next request. fetch's
 * default agent closes one after 4 s, and the model APIs send no Keep-Alive hint to
 * stretch that, so the first request of every turn, and every request after a tool
 * that ran longer than 4 s, paid a fresh TCP and TLS handshake (a quarter second to a
 * second on a distant link). The servers hold an idle connection far longer than this.
 * One they close first fails before any response and is retried like any other reset.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 60_000
/** The longest a server's own Keep-Alive hint may stretch {@link KEEP_ALIVE_TIMEOUT_MS} to. */
const KEEP_ALIVE_MAX_TIMEOUT_MS = 10 * 60_000
const KEEP_ALIVE = { keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS, keepAliveMaxTimeout: KEEP_ALIVE_MAX_TIMEOUT_MS }

/** Hosts that always go direct: a remote proxy can't reach this machine's loopback. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']

/**
 * Whether a base URL points at the user's own machine or private network: loopback,
 * `localhost` (and `*.localhost`), the unspecified address, a private IPv4 range, an
 * mDNS `.local` name, or an IPv6 unique-local address. That's where self-hosted model
 * servers (Ollama, LM Studio, vLLM, llama.cpp) live. A malformed URL is not local.
 */
export function isLocalModelHost(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  let host: string
  try {
    host = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  host = host.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (!v4) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
}

let cidrCache: { noProxy: string; list: BlockList } | null = null

/** The CIDR entries (`10.0.0.0/8`, `fd00::/8`) of a `NO_PROXY` list, as one matcher. */
function noProxyRanges(noProxy: string): BlockList {
  if (cidrCache?.noProxy === noProxy) return cidrCache.list
  const list = new BlockList()
  for (const entry of noProxy.split(',')) {
    const m = /^\[?([0-9a-fA-F:.]+)\]?\/(\d{1,3})$/.exec(entry.trim())
    if (!m) continue
    const family = isIP(m[1])
    const prefix = Number(m[2])
    if (!family || prefix > (family === 6 ? 128 : 32)) continue
    list.addSubnet(m[1], prefix, family === 6 ? 'ipv6' : 'ipv4')
  }
  cidrCache = { noProxy, list }
  return list
}

/**
 * Whether a request to `target` goes straight to its host under `config`: the user's
 * own machine or private network ({@link isLocalModelHost}), or an IP literal inside a
 * CIDR range of `NO_PROXY`. Names and dot-suffixes in `NO_PROXY` are left to the proxy
 * agent, which matches those itself. Exported for testing.
 */
export function bypassesProxy(target: string, config: OutboundProxyConfig): boolean {
  if (isLocalModelHost(target)) return true
  let host: string
  try {
    host = new URL(target).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  const family = isIP(host)
  if (!family) return false
  return noProxyRanges(config.noProxy).check(host, family === 6 ? 'ipv6' : 'ipv4')
}

export interface OutboundProxyConfig {
  /** Proxy for `http:` targets. */
  httpProxy: string
  /** Proxy for `https:` targets. */
  httpsProxy: string
  /** Comma-separated hosts that bypass the proxy, loopback included. */
  noProxy: string
  /** Where the proxy came from, for diagnostics. */
  source: 'setting' | 'environment'
}

type Env = Record<string, string | undefined>

function envVar(env: Env, name: string): string | undefined {
  const v = env[name.toLowerCase()] ?? env[name.toUpperCase()]
  const trimmed = v?.trim()
  return trimmed ? trimmed : undefined
}

/** True for a URL a proxy agent can use: `http:` or `https:` with a host. */
export function isValidProxyUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== ''
  } catch {
    return false
  }
}

/** The proxy URL with any credentials replaced, safe to log or show. */
export function redactProxyUrl(raw: string): string {
  try {
    const u = new URL(raw)
    if (u.username || u.password) {
      u.username = '***'
      u.password = ''
    }
    return u.toString().replace(/\/$/, '')
  } catch {
    return '(invalid proxy URL)'
  }
}

const warnedInvalid = new Set<string>()
function warnInvalid(raw: string, where: string): void {
  if (warnedInvalid.has(where + raw)) return
  warnedInvalid.add(where + raw)
  log.warn(`ignoring ${where} proxy ${redactProxyUrl(raw)}: only http:// and https:// proxy URLs are supported`)
}

/**
 * Work out which proxy, if any, Houston's own API requests should use. The setting
 * wins over the environment; `HTTPS_PROXY` falls back to `HTTP_PROXY` for https
 * targets, as most tools do. `NO_PROXY=*` turns the proxy off entirely.
 */
export function resolveOutboundProxy(setting: string | undefined, env: Env = process.env): OutboundProxyConfig | null {
  const rawNoProxy = envVar(env, 'no_proxy') ?? ''
  if (rawNoProxy === '*') return null
  const noProxy = [...rawNoProxy.split(/[,\s]+/).filter(Boolean), ...LOOPBACK_HOSTS].join(',')

  const fromSetting = setting?.trim()
  if (fromSetting) {
    if (isValidProxyUrl(fromSetting)) {
      return { httpProxy: fromSetting, httpsProxy: fromSetting, noProxy, source: 'setting' }
    }
    warnInvalid(fromSetting, 'the configured')
  }

  const valid = (name: string): string | undefined => {
    const v = envVar(env, name)
    if (v && !isValidProxyUrl(v)) {
      warnInvalid(v, `the ${name.toUpperCase()}`)
      return undefined
    }
    return v
  }
  const http = valid('http_proxy')
  const https = valid('https_proxy') ?? http
  if (!http && !https) return null
  // A target scheme with no proxy of its own goes direct: an empty string tells the
  // agent "no proxy" without it falling back to reading the environment itself.
  return { httpProxy: http ?? '', httpsProxy: https ?? '', noProxy, source: 'environment' }
}

let settingSource: () => string | undefined = () => undefined

/**
 * Tell the proxy where to read the `proxyUrl` setting. Called once at startup by each
 * entry point (the desktop app and the standalone CLI); until then only the
 * environment applies. The getter runs per request so a change in Settings takes
 * effect on the next call without a restart.
 */
export function configureOutboundProxy(getSetting: () => string | undefined): void {
  settingSource = getSetting
}

function currentConfig(): OutboundProxyConfig | null {
  let setting: string | undefined
  try {
    setting = settingSource()
  } catch {
    setting = undefined
  }
  return resolveOutboundProxy(setting)
}

let cached: { key: string; dispatcher: Dispatcher } | null = null
let direct: Dispatcher | null = null

/**
 * An agent the global fetch can drive whatever undici version it bundles (see the
 * module comment). The adapter keeps requests on HTTP/1.1, which is all the bundled
 * fetch ever asked for, and forwards `close()` to the agent it wraps.
 */
function legacyCompatible(dispatcher: Dispatcher): Dispatcher {
  return new Dispatcher1Wrapper(dispatcher)
}

/** The agent for requests that go straight to their host, created on first use. */
function directDispatcher(): Dispatcher {
  direct ??= legacyCompatible(new Agent(KEEP_ALIVE))
  return direct
}

/** The dispatcher for the current configuration: the proxy agent, or the direct one. */
export function outboundDispatcher(config: OutboundProxyConfig | null = currentConfig()): Dispatcher {
  if (!config) {
    if (cached) retire(cached.dispatcher)
    cached = null
    return directDispatcher()
  }
  const key = `${config.httpProxy}\n${config.httpsProxy}\n${config.noProxy}`
  if (cached?.key === key) return cached.dispatcher
  if (cached) retire(cached.dispatcher)
  // Empty strings (not undefined) so the agent never reads the environment on its own:
  // what it does must match what resolveOutboundProxy decided.
  const dispatcher = legacyCompatible(
    new EnvHttpProxyAgent({
      ...KEEP_ALIVE,
      // A plain-http target is forwarded to the proxy, as curl and browsers do, rather
      // than tunnelled with CONNECT, which proxies commonly refuse for ports other than 443.
      // https targets are always tunnelled.
      proxyTunnel: false,
      httpProxy: config.httpProxy,
      httpsProxy: config.httpsProxy,
      noProxy: config.noProxy
    })
  )
  cached = { key, dispatcher }
  log.info(`outbound proxy (${config.source}): ${redactProxyUrl(config.httpsProxy || config.httpProxy)}`)
  return dispatcher
}

/** Close a superseded agent once its in-flight requests finish. */
function retire(d: Dispatcher): void {
  d.close().catch(() => {})
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * `fetch` for Houston's own API calls: the global fetch, sent through the configured
 * proxy when there is one and through the long keep-alive agent otherwise. A drop-in
 * for `globalThis.fetch`.
 */
export const outboundFetch: Fetch = (input, init) => {
  const config = currentConfig()
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const dispatcher = config && bypassesProxy(target, config) ? directDispatcher() : outboundDispatcher(config)
  // `dispatcher` is Node's fetch extension, absent from the DOM RequestInit type.
  return globalThis.fetch(input, { ...init, dispatcher } as RequestInit)
}
