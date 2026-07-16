import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { EgressProxyEndpoints, SandboxBackend, ShellLaunch } from './contract'
import { egressProxyEnv } from './egress-proxy'

/**
 * macOS Seatbelt backend.
 *
 * Commands run under `sandbox-exec` with a generated SBPL profile that denies
 * everything by default, allows reading the whole filesystem, allows writing only
 * inside the workspace/roots and temp dirs, and gates network per the policy. This
 * is the OS-native sandbox mechanism on macOS.
 *
 * Network has three modes:
 *  - `none`   — no network (the default when the run has no network grant).
 *  - `loopback` — proxied egress: outbound only to loopback, where the egress
 *    proxy (and any local dev server) listens; the proxy enforces the per-domain
 *    allowlist. Loopback bind/inbound stay allowed so dev servers keep working.
 *    DNS stays blocked (the proxy resolves; and DNS is itself an exfil channel).
 *  - `full`   — unrestricted (the user chose egress mode 'all').
 *
 * DNS blocking in the confined modes is made explicit, not left to chance: on
 * macOS, `getaddrinfo` resolves through the `com.apple.mDNSResponder` mach
 * service (and `com.apple.dnssd.service`), which lives outside the sandbox — so
 * a plain "restrict sockets to loopback" would still leave DNS-tunnel
 * exfiltration open IF the OS delivered the resolver's answer without a gated
 * socket. Empirically current macOS already fails `getaddrinfo` for external
 * names under the loopback-only socket policy, but rather than depend on that
 * quirk we DENY the resolver mach services in the confined modes. `localhost`
 * still resolves (via `/etc/hosts` / the numeric fast path, no daemon), and the
 * proxy resolves public names for the toolchain, so nothing legitimate breaks.
 */

export type SeatbeltNetworkMode = 'none' | 'loopback' | 'full'

/** The resolver mach services `getaddrinfo` uses — denied in the confined modes. */
const DNS_MACH_SERVICES = ['com.apple.mDNSResponder', 'com.apple.dnssd.service']

/** Escape a path for safe embedding inside an SBPL double-quoted literal. */
function sbplPath(p: string): string {
  let real = p
  try {
    real = realpathSync(p)
  } catch {
    // Path may not exist yet; fall back to the raw path.
  }
  return real.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Deny the DNS resolver mach services. Placed AFTER the profile body's blanket
 * `(allow mach-lookup)` so it scopes only these services out (SBPL is
 * last-match-wins), cutting the `getaddrinfo`/mDNSResponder DNS side channel in
 * the confined modes without touching the many other mach services the toolchain
 * needs (dyld, configd, …).
 */
function denyResolverStanza(): string {
  const names = DNS_MACH_SERVICES.map((n) => `(global-name "${n}")`).join(' ')
  return `(deny mach-lookup ${names})`
}

/** The SBPL network stanza for a given mode (see {@link SeatbeltNetworkMode}). */
function networkStanza(mode: SeatbeltNetworkMode): string {
  // `full` (egress mode 'all') keeps DNS: unrestricted network implies resolution.
  if (mode === 'full') return '(allow network*)'
  if (mode === 'loopback') {
    return [
      '; proxied egress: loopback only — the egress proxy is the sole road out',
      '(allow network-outbound (remote ip "localhost:*"))',
      '(allow network-bind (local ip "localhost:*"))',
      '(allow network-inbound (local ip "localhost:*"))',
      denyResolverStanza()
    ].join('\n')
  }
  return ['; network denied', denyResolverStanza()].join('\n')
}

export function buildSeatbeltProfile(
  roots: string | string[],
  network: SeatbeltNetworkMode | boolean
): string {
  // Boolean compat: older call sites (and tests) pass allowNetwork as a boolean.
  const mode: SeatbeltNetworkMode =
    network === true ? 'full' : network === false ? 'none' : network
  const rootList = (Array.isArray(roots) ? roots : [roots]).filter(Boolean)
  const tmp = sbplPath(tmpdir())
  const writableRoots = rootList.map((r) => `  (subpath "${sbplPath(r)}")`).join('\n')

  return `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow file-read*)
(allow file-write*
${writableRoots}
  (subpath "${tmp}")
  (subpath "/private/tmp")
  (subpath "/private/var/tmp"))
(allow file-write-data
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (literal "/dev/dtracehelper")
  (literal "/dev/urandom")
  (literal "/dev/random"))
${networkStanza(mode)}
`
}

/** Resolve the effective network mode from the launch options. */
export function seatbeltNetworkMode(
  allowNetwork: boolean,
  egressProxy: EgressProxyEndpoints | undefined
): SeatbeltNetworkMode {
  if (!allowNetwork) return 'none'
  return egressProxy ? 'loopback' : 'full'
}

export const SeatbeltBackend: SandboxBackend = {
  id: 'seatbelt',
  sandboxed: true,
  confinesNetwork: true,
  supportsSession: true,
  buildLaunch({ command, roots, allowNetwork, egressProxy }): ShellLaunch {
    const mode = seatbeltNetworkMode(allowNetwork, egressProxy)
    const profile = buildSeatbeltProfile(roots, mode)
    return {
      file: 'sandbox-exec',
      args: ['-p', profile, '/bin/bash', '-c', command],
      detached: true,
      windowsHide: false,
      supportsSession: true,
      // Proxied mode: point the toolchain at the egress proxy on the host's
      // loopback, which the loopback-only profile permits reaching directly.
      ...(mode === 'loopback' && egressProxy
        ? { env: egressProxyEnv(`http://127.0.0.1:${egressProxy.tcpPort}`) }
        : {})
    }
  }
}
