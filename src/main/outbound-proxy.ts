import { EnvHttpProxyAgent, type Dispatcher } from 'undici'
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
 * `NO_PROXY` honoured either way. Loopback hosts always go direct, so a local model
 * server keeps working under a corporate proxy.
 *
 * Deliberately not routed here:
 *   - `web_fetch` connects directly to an address it has resolved and vetted (its SSRF
 *     guard pins the IP), and a proxy would resolve the name again on its side, so the
 *     pin would no longer mean anything. It uses its own transport, not this fetch.
 *   - Shell commands. The sandbox injects its own egress proxy into the child
 *     environment; nothing here reads or writes `process.env`.
 *
 * Nothing changes when no proxy is configured: requests use the global `fetch` with
 * its default dispatcher, exactly as before.
 */

/** Hosts that always go direct: a remote proxy can't reach this machine's loopback. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']

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

/** The dispatcher for the current configuration, or null to use fetch's default. */
export function outboundDispatcher(config: OutboundProxyConfig | null = currentConfig()): Dispatcher | null {
  if (!config) {
    if (cached) retire(cached.dispatcher)
    cached = null
    return null
  }
  const key = `${config.httpProxy}\n${config.httpsProxy}\n${config.noProxy}`
  if (cached?.key === key) return cached.dispatcher
  if (cached) retire(cached.dispatcher)
  // Empty strings (not undefined) so the agent never reads the environment on its own:
  // what it does must match what resolveOutboundProxy decided.
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: config.httpProxy,
    httpsProxy: config.httpsProxy,
    noProxy: config.noProxy
  })
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
 * proxy when there is one. A drop-in for `globalThis.fetch`.
 */
export const outboundFetch: Fetch = (input, init) => {
  const dispatcher = outboundDispatcher()
  if (!dispatcher) return globalThis.fetch(input, init)
  // `dispatcher` is Node's fetch extension, absent from the DOM RequestInit type.
  return globalThis.fetch(input, { ...init, dispatcher } as RequestInit)
}
