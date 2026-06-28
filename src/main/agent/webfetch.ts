/**
 * Network fetch for the agent's `web_fetch` tool.
 *
 * Runs in the main process (outside the Seatbelt sandbox), so the approval flow
 * is the primary control: the user sees and approves the exact URL on each call.
 * On top of that we apply best-effort SSRF guards — an http(s)-only scheme
 * allowlist and a private/loopback/link-local host block re-checked on every
 * redirect hop. (DNS-rebinding via IP pinning is deferred — see ROADMAP.md.)
 */

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
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a > 255 || b > 255) return false
    if (a === 0 || a === 127) return true // this-host / loopback
    if (a === 10) return true // private
    if (a === 172 && b >= 16 && b <= 31) return true // private
    if (a === 192 && b === 168) return true // private
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

export interface FetchOptions {
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * Fetch a URL and return a readable text summary (status line + body). HTML is
 * converted to text; other text/JSON bodies are returned as-is. Redirects are
 * followed manually so each hop's target is re-validated against the SSRF guard.
 */
export async function fetchUrlAsText(raw: string, opts: FetchOptions = {}): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch
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
      const res = await doFetch(current, {
        signal: ac.signal,
        redirect: 'manual',
        headers: {
          'user-agent': 'Houston-Agent/0.1 (+https://github.com/piyushvijay/houston)',
          accept: 'text/*, application/json, application/xhtml+xml'
        }
      })

      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop === MAX_REDIRECTS) throw new Error('Too many redirects.')
        current = validateFetchUrl(new URL(location, current).toString())
        continue
      }

      const contentType = res.headers.get('content-type') ?? ''
      const buf = Buffer.from(await res.arrayBuffer())
      const truncated = buf.length > maxBytes
      const body = buf.subarray(0, maxBytes).toString('utf8')
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
