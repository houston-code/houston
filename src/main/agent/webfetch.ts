/**
 * Network fetch for the agent's `web_fetch` tool.
 *
 * Runs in the main process (outside the Seatbelt sandbox), so the approval flow
 * is the primary control: the user sees and approves the exact URL on each call.
 * On top of that we apply SSRF guards, re-applied on every redirect hop: an
 * http(s)-only scheme allowlist, and a private/loopback/link-local/metadata block
 * covering both a private *literal* IP in the URL and a hostname that *resolves*
 * to one (so a public-looking DNS name pointing at metadata — e.g.
 * `169.254.169.254.nip.io` — is refused).
 *
 * The address we vet is also the address we connect to: {@link resolveAndPin}
 * resolves the host once, vets every answer, and {@link pinnedTransport} connects
 * to exactly those addresses instead of letting the network stack re-resolve. That
 * closes the DNS-rebinding TOCTOU, where a name resolves public for the check and
 * private for the connect a moment later.
 */

import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { LookupFunction } from 'node:net'

const MAX_REDIRECTS = 5
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BYTES = 5_000_000

/**
 * If `h` is an IPv4-mapped / -compatible / NAT64 IPv6 literal, return the embedded
 * dotted-quad IPv4; otherwise null. Covers both the textual `::ffff:1.2.3.4` form
 * and the hex-compressed `::ffff:0102:0304` form that the WHATWG URL parser emits
 * (e.g. `new URL('http://[::ffff:169.254.169.254]').hostname` === `[::ffff:a9fe:a9fe]`).
 * `h` must already be lowercased and IPv6-bracket-stripped.
 */
export function embeddedIPv4(h: string): string | null {
  const dotted = h.match(/^(?:::ffff:|::|64:ff9b::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (dotted) return dotted[1]
  const hex = h.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
  }
  return null
}

/** True for hosts that must never be fetched (loopback, private ranges, cloud metadata). */
export function isPrivateHost(hostname: string): boolean {
  let h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '') // strip IPv6 brackets
  if (h.endsWith('.')) h = h.slice(0, -1) // trailing-dot FQDN: "localhost." -> "localhost"
  if (h === '' || h === 'localhost' || h.endsWith('.localhost')) return true

  // Unwrap IPv4-mapped/-compatible/NAT64 IPv6 to the embedded IPv4 and re-classify,
  // so e.g. `[::ffff:169.254.169.254]` (cloud metadata) and `[::ffff:127.0.0.1]`
  // (loopback) can't slip past the IPv6 string checks below.
  const v4 = embeddedIPv4(h)
  if (v4) return isPrivateHost(v4)

  // IPv6 loopback / unspecified / unique-local (fc00::/7) / link-local (fe80::/10,
  // i.e. fe80–febf) / deprecated site-local (fec0::/10, i.e. fec0–feff).
  if (h === '::1' || h === '::') return true
  if (/^f[cd][0-9a-f]*:/.test(h) || /^fe[89ab][0-9a-f]*:/.test(h) || /^fe[c-f][0-9a-f]*:/.test(h)) {
    return true
  }

  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])]
    if (a > 255 || b > 255) return false
    if (a === 0 || a === 127) return true // this-host / loopback
    if (a === 10) return true // private
    if (a === 172 && b >= 16 && b <= 31) return true // private
    if (a === 192 && b === 168) return true // private
    if (a === 192 && b === 0 && c === 0) return true // IETF protocol block (192.0.0.0/24) incl. Oracle legacy metadata 192.0.0.192
    if (a === 169 && b === 254) return true // link-local incl. 169.254.169.254 metadata
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT (100.64.0.0/10)
  }
  return false
}

/** Parse + validate a URL for fetching; throws on a disallowed scheme or host. */
export function validateFetchUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Invalid URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https URLs are allowed (got "${url.protocol}").`)
  }
  if (isPrivateHost(url.hostname)) {
    throw new Error(`Refusing to fetch a private or loopback address: ${url.hostname}`)
  }
  return url
}

/** Resolve a hostname to its IP addresses. Injectable so the SSRF check is testable. */
export type HostResolver = (hostname: string) => Promise<string[]>

const defaultResolveHost: HostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true })
  return records.map((r) => r.address)
}

/** An address that passed the SSRF vet, pinned so the connection can't re-resolve. */
export interface PinnedAddress {
  address: string
  family: number
}

/**
 * Resolve `hostname`, vet every address it maps to, and return that vetted set for the
 * connection to pin to.
 *
 * Vetting the name closes the DNS-name SSRF variant, where a public-looking name (e.g.
 * a wildcard-DNS host like `169.254.169.254.nip.io`) points at metadata. *Pinning* is
 * what closes DNS rebinding on top of that: checking a name and then handing the name
 * back to the network stack is a TOCTOU — the attacker answers public for our lookup
 * and private for the connect microseconds later. Returning the addresses means the
 * caller connects to the ones we vetted, so there is no second resolution to poison.
 *
 * Fails closed: a host we can't resolve gets no pin, so it doesn't get fetched.
 */
export async function resolveAndPin(
  hostname: string,
  resolveHost: HostResolver
): Promise<PinnedAddress[]> {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '') // strip IPv6 brackets

  // An IP literal is its own resolution — there's no DNS step to rebind.
  const literal = isIP(host)
  if (literal) {
    if (isPrivateHost(host)) {
      throw new Error(`Refusing to fetch a private or loopback address: ${host}`)
    }
    return [{ address: host, family: literal }]
  }

  let addresses: string[]
  try {
    addresses = await resolveHost(host)
  } catch (e) {
    throw new Error(`Refusing to fetch ${host}: its address could not be resolved.`, { cause: e })
  }
  if (addresses.length === 0) {
    throw new Error(`Refusing to fetch ${host}: it resolves to no addresses.`)
  }
  return addresses.map((address) => {
    if (isPrivateHost(address)) {
      throw new Error(
        `Refusing to fetch ${host}: it resolves to a private or loopback address (${address}).`
      )
    }
    const family = isIP(address)
    if (!family) {
      throw new Error(`Refusing to fetch ${host}: it resolved to a non-address (${address}).`)
    }
    return { address, family }
  })
}

/** Collapse an HTML document into readable plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#3?9;|&apos;/gi, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The parts of a response the fetcher needs. Satisfied by {@link pinnedTransport} and test fakes. */
export interface TransportResponse {
  status: number
  statusText: string
  headers: { get(name: string): string | null }
  body: Buffer
}

export interface TransportRequest {
  url: URL
  headers: Record<string, string>
  signal: AbortSignal
  /** Vetted addresses. The connection must go to one of these and never re-resolve. */
  pin: PinnedAddress[]
  /** Hard cap on bytes read off the wire; the transport stops reading past it. */
  readLimit: number
}

/**
 * Performs one request. A seam rather than the global `fetch` because `fetch` gives no
 * way to pin the address it connects to (that needs a custom `lookup`, which only the
 * `node:http(s)` layer exposes), and because tests need a transport with no real socket.
 */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>

/**
 * The real transport: an http(s) request whose DNS is replaced by the pre-vetted
 * {@link TransportRequest.pin}, so the address we vetted is the address we connect to.
 *
 * The hostname is still passed as the host, so the `Host` header, TLS SNI, and
 * certificate validation all remain against the name the user approved — only the
 * address lookup is overridden.
 *
 * `agent: false` gives each request its own throwaway agent, which is load-bearing
 * rather than tidiness: a pooled keep-alive socket gets reused *without* consulting
 * `lookup`, so a shared agent would hand a later request a connection whose address
 * was never vetted, quietly defeating the pin.
 */
export const pinnedTransport: Transport = (req) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const { url, pin, readLimit, signal, headers } = req
    const secure = url.protocol === 'https:'
    const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '')

    // Ignore the name we're handed: the vetted addresses are the only allowed answer.
    // Node asks with `all: true` when Happy Eyeballs is on (the default), and with
    // `all` unset otherwise, so answer in whichever shape was requested.
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options?.all) callback(null, pin)
      else callback(null, pin[0].address, pin[0].family)
    }

    const send = secure ? httpsRequest : httpRequest
    const clientReq = send(
      {
        hostname,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers,
        lookup: pinnedLookup,
        // SNI can't carry an IP literal.
        servername: secure && !isIP(hostname) ? hostname : undefined,
        agent: false,
        signal
      },
      (res) => {
        const chunks: Buffer[] = []
        let read = 0
        let settled = false

        const finish = (): void => {
          if (settled) return
          settled = true
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers: {
              get: (name) => {
                const v = res.headers[name.toLowerCase()]
                if (v === undefined) return null
                return Array.isArray(v) ? v.join(', ') : v
              }
            },
            body: Buffer.concat(chunks)
          })
        }

        res.on('data', (chunk: Buffer) => {
          const room = readLimit - read
          if (chunk.length >= room) {
            chunks.push(chunk.subarray(0, room))
            read += room
            // Past the cap the rest is bytes we'd only discard — stop pulling them.
            // 'close' follows and settles the promise with what we have.
            res.destroy()
            return
          }
          chunks.push(chunk)
          read += chunk.length
        })
        res.on('end', finish)
        res.on('close', finish) // also covers the destroy() above
        res.on('error', (e) => {
          if (!settled) reject(e)
        })
      }
    )
    clientReq.on('error', reject)
    clientReq.end()
  })

export interface FetchOptions {
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
  /** Injectable for tests. Defaults to {@link pinnedTransport}. */
  transport?: Transport
  /** Injectable for tests. Defaults to a real DNS lookup. */
  resolveHost?: HostResolver
}

/**
 * Fetch a URL and return a readable text summary (status line + body). HTML is
 * converted to text; other text/JSON bodies are returned as-is. Redirects are
 * followed manually so each hop's target is re-validated against the SSRF guard.
 */
export async function fetchUrlAsText(raw: string, opts: FetchOptions = {}): Promise<string> {
  const transport = opts.transport ?? pinnedTransport
  const resolveHost = opts.resolveHost ?? defaultResolveHost
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES

  const ac = new AbortController()
  const onAbort = (): void => ac.abort()
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => ac.abort(), timeoutMs)

  try {
    let current = validateFetchUrl(raw)
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // Vet and pin per hop: a redirect target is a fresh host, chosen by the server.
      const pin = await resolveAndPin(current.hostname, resolveHost)
      const res = await transport({
        url: current,
        signal: ac.signal,
        headers: {
          'user-agent': 'Houston-Agent/0.1 (+https://github.com/piyushvijay/houston)',
          accept: 'text/*, application/json, application/xhtml+xml'
        },
        pin,
        // One byte past the cap, so a body of exactly maxBytes isn't called truncated.
        readLimit: maxBytes + 1
      })

      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop === MAX_REDIRECTS) throw new Error('Too many redirects.')
        current = validateFetchUrl(new URL(location, current).toString())
        continue
      }

      const contentType = res.headers.get('content-type') ?? ''
      const truncated = res.body.length > maxBytes
      const body = res.body.subarray(0, maxBytes).toString('utf8')
      const isHtml = /text\/html|application\/xhtml/i.test(contentType)
      const text = isHtml ? htmlToText(body) : body
      const header = `HTTP ${res.status} ${res.statusText} · ${contentType || 'unknown type'} · ${current.toString()}`
      return `${header}\n\n${text}${truncated ? `\n[truncated at ${maxBytes} bytes]` : ''}`
    }
    throw new Error('Too many redirects.')
  } catch (e) {
    if (ac.signal.aborted) throw new Error('Fetch timed out or was cancelled.', { cause: e })
    throw e
  } finally {
    clearTimeout(timer)
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
  }
}
