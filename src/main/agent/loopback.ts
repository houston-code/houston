/**
 * Pure loopback-host classification + URL helpers, shared by the agent's
 * `view_localhost` screenshot tool (viewlocalhost.ts) and the live Preview dock
 * (preview.ts). Kept free of any Electron import so both the host classifier and
 * the dev-server URL detector can be unit-tested in plain Node, and so the
 * background-shell registry (shells.ts) can detect server URLs without pulling
 * Electron into its module graph.
 *
 * The security contract is the inverse of webfetch's: only loopback is allowed
 * here (localhost / 127.0.0.0/8 / ::1 / 0.0.0.0), never the wider private/LAN
 * ranges or cloud metadata — so a localhost-only surface can't be repurposed to
 * reach the user's network.
 */

import { embeddedIPv4, isPrivateHost } from './webfetch'

/**
 * True for loopback hosts a local dev server binds to — the only hosts the
 * preview surfaces will load. Deliberately narrower than webfetch's
 * `isPrivateHost` block: 10/8, 172.16/12, 192.168/16 and link-local are NOT
 * loopback and are rejected, so these tools can't reach the LAN or cloud
 * metadata.
 */
export function isLoopbackHost(hostname: string): boolean {
  let h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '') // strip IPv6 brackets
  if (h.endsWith('.')) h = h.slice(0, -1) // trailing-dot FQDN
  // Recognize an IPv4-mapped IPv6 loopback (e.g. [::ffff:127.0.0.1]) as loopback by
  // re-classifying its embedded IPv4, so the subresource filter (isPrivateHost &&
  // !isLoopbackHost) doesn't wrongly block the dev server's own mapped-loopback.
  const v4 = embeddedIPv4(h)
  if (v4) h = v4
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  // IPv6 loopback / unspecified (a server bound to "all" is reachable via loopback).
  if (h === '::1' || h === '::' || h === '0:0:0:0:0:0:0:1') return true

  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    if (m.slice(1).some((p) => Number(p) > 255)) return false
    if (Number(m[1]) === 127) return true // 127.0.0.0/8 loopback
    if (h === '0.0.0.0') return true // unspecified — reaches loopback from the same host
  }
  return false
}

/** Parse + validate a URL for a loopback surface; throws on a bad scheme or non-loopback host. */
export function validateLocalhostUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Invalid URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https URLs are allowed (got "${url.protocol}").`)
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new Error(
      `Only loopback addresses (localhost, 127.0.0.1, ::1) are allowed. Refusing: ${
        url.hostname || raw
      }.`
    )
  }
  return url
}

/**
 * True for a *subresource* host a loopback capture/preview window must not reach:
 * the private/LAN/link-local/metadata ranges webfetch blocks, EXCEPT loopback
 * (the dev server and its own assets are allowed) and public hosts (CDNs, allowed
 * so pages still render). This closes the residual where a localhost page's own JS
 * could `fetch('http://169.254.169.254/...')` or a LAN service and leak it. An
 * empty host (data:/blob:/about:) is not network egress and is allowed. Like
 * webfetch, this matches on the URL's host literal, so a DNS name resolving to a
 * private IP is a known gap (deferred — see ROADMAP.md).
 */
export function isBlockedSubresourceHost(hostname: string): boolean {
  if (!hostname) return false
  return isPrivateHost(hostname) && !isLoopbackHost(hostname)
}

/** Strip trailing punctuation a log line tends to glue onto a URL (e.g. "…:5173/."). */
function trimUrlTail(raw: string): string {
  return raw.replace(/[.,;:!?)\]}'"]+$/, '')
}

/**
 * Find the first loopback dev-server URL printed in a chunk of process output, or
 * undefined. Dev servers announce themselves with lines like `Local:
 * http://localhost:5173/` or `running at http://0.0.0.0:8000` — we scan for any
 * http(s) URL and keep the first whose host is loopback. A server bound to
 * `0.0.0.0`/`::` is rewritten to `127.0.0.1`/`[::1]` because browsers can't always
 * connect to the unspecified address; the chosen port is preserved.
 */
export function detectLocalUrl(text: string): string | undefined {
  const matches = text.match(/https?:\/\/[^\s'"<>`]+/gi)
  if (!matches) return undefined
  for (const candidate of matches) {
    let url: URL
    try {
      url = new URL(trimUrlTail(candidate))
    } catch {
      continue
    }
    if (!isLoopbackHost(url.hostname)) continue
    // Rewrite "listen on all interfaces" addresses to a concrete loopback the
    // browser can actually reach, keeping the port.
    if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1'
    else if (url.hostname === '::' || url.hostname === '[::]') url.hostname = '[::1]'
    return url.toString()
  }
  return undefined
}
