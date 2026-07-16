/**
 * Sandbox egress policy — the pure allow/deny model for *which hosts* a
 * network-granted shell command may reach.
 *
 * Granting the sandbox "network" used to be all-or-nothing: full-auto (or an
 * "Allow for run" on a shell command) opened unrestricted egress, so a
 * prompt-injected command could POST anything it could read to any domain. The
 * egress policy closes that: granted network is routed through a loopback proxy
 * owned by the main process (see src/main/sandbox/egress-proxy.ts), and the
 * proxy consults this policy per request. No TLS interception is needed — the
 * proxy sees the target *hostname* (HTTP CONNECT / absolute-form URI), which is
 * exactly the granularity a domain allowlist wants.
 *
 * This module is pure string matching so it can be unit-tested exhaustively and
 * shared with the Settings UI. Enforcement (the proxy, the per-OS sandbox
 * profiles) lives in the main process.
 */

/** User-configurable egress policy, persisted in settings as `sandboxEgress`. */
export interface SandboxEgressSettings {
  /**
   * `allowlist` (the default when unset): granted network is restricted to the
   * built-in allowlist plus `allow` entries, minus `deny` entries.
   * `all`: legacy unrestricted egress — the sandbox gets the full network when
   * network is granted. The explicit escape hatch, never the default.
   */
  mode?: 'allowlist' | 'all'
  /** Extra hosts to allow (each entry also matches its subdomains). */
  allow?: string[]
  /** Hosts to deny. Deny wins over every allow source, including the defaults. */
  deny?: string[]
}

/**
 * Hosts granted by default in allowlist mode: the package registries, VCS hosts,
 * and toolchain download hosts a dev-loop command legitimately needs. Each entry
 * matches the apex and all subdomains (so `golang.org` covers `proxy.golang.org`).
 *
 * Deliberately NOT here: broad cloud-storage apexes (an "anyone can create a
 * bucket" host is an arbitrary-write exfiltration channel) and paste/file-drop
 * sites. Collaborative hosts that do accept writes (github.com et al.) stay,
 * because blocking them would break the core dev loop — that residual channel is
 * authenticated, attributable, and revocable, and is documented in
 * docs/sandboxing.md.
 */
export const DEFAULT_EGRESS_ALLOWLIST: readonly string[] = [
  // JavaScript / TypeScript
  'npmjs.org',
  'yarnpkg.com',
  'nodejs.org',
  'deno.land',
  'jsr.io',
  // Python
  'pypi.org',
  'pythonhosted.org',
  // Rust
  'crates.io',
  'rust-lang.org',
  // Ruby
  'rubygems.org',
  // JVM
  'maven.apache.org',
  'maven.org',
  'gradle.org',
  // Go
  'golang.org',
  // PHP
  'packagist.org',
  // .NET
  'nuget.org',
  // Version control hosts
  'github.com',
  'githubusercontent.com',
  'gitlab.com',
  'bitbucket.org'
]

/**
 * Normalize a hostname for matching: lowercase, strip IPv6 brackets and a
 * trailing FQDN dot. Returns '' for a host that is nothing but decoration.
 */
export function normalizeEgressHost(host: string): string {
  let h = host.trim().toLowerCase()
  h = h.replace(/^\[/, '').replace(/\]$/, '')
  if (h.endsWith('.')) h = h.slice(0, -1)
  return h
}

/**
 * Normalize one user-entered policy entry to a matchable host, or null when the
 * entry is empty/unusable. Accepts the forms people paste: a bare host, a
 * `*.host` wildcard (equivalent to the bare host — every entry already matches
 * subdomains), or a URL/`host:port` (scheme, path, and port are dropped; the
 * policy is per-host by design).
 */
export function parseEgressEntry(raw: string): string | null {
  let e = raw.trim().toLowerCase()
  if (!e) return null
  e = e.replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // scheme
  e = e.replace(/[/?#].*$/, '') // path/query/fragment
  e = e.replace(/^\*\./, '') // `*.host` — subdomains already match
  // `host:port` — strip the port. A bracketed IPv6 literal keeps its colons; a bare
  // IPv6 literal (multiple colons, no bracket) is left intact.
  const bracketed = e.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketed) e = bracketed[1]
  else if ((e.match(/:/g) ?? []).length === 1) e = e.replace(/:\d+$/, '')
  e = normalizeEgressHost(e)
  return e || null
}

/** True when `host` is `entry` or a subdomain of it (label-boundary suffix). */
export function hostMatchesEntry(host: string, entry: string): boolean {
  if (entry === '*') return true
  return host === entry || host.endsWith(`.${entry}`)
}

/** True when the (normalized) host matches any of the raw policy entries. */
export function hostMatchesAny(host: string, entries: readonly string[]): boolean {
  for (const raw of entries) {
    const entry = parseEgressEntry(raw)
    if (entry && hostMatchesEntry(host, entry)) return true
  }
  return false
}

/** The effective mode: `allowlist` unless the user explicitly chose `all`. */
export function resolveEgressMode(s: SandboxEgressSettings | undefined): 'allowlist' | 'all' {
  return s?.mode === 'all' ? 'all' : 'allowlist'
}

/** Why an egress decision came out the way it did (surfaced in deny messages/logs). */
export type EgressRule =
  | 'mode-all' // unrestricted mode — everything allowed
  | 'deny-entry' // matched a user deny entry
  | 'allow-entry' // matched a user allow entry
  | 'default-allowlist' // matched the built-in allowlist
  | 'not-listed' // matched nothing → denied

export interface EgressDecision {
  allowed: boolean
  rule: EgressRule
}

/**
 * Decide whether a network-granted sandbox command may reach `host`. Deny
 * entries win over every allow source; user allow entries and the built-in
 * allowlist are additive. An unparseable/empty host is never allowed.
 */
export function evaluateEgress(
  host: string,
  settings: SandboxEgressSettings | undefined
): EgressDecision {
  const h = normalizeEgressHost(host)
  if (resolveEgressMode(settings) === 'all') return { allowed: true, rule: 'mode-all' }
  if (!h) return { allowed: false, rule: 'not-listed' }
  if (hostMatchesAny(h, settings?.deny ?? [])) return { allowed: false, rule: 'deny-entry' }
  if (hostMatchesAny(h, settings?.allow ?? [])) return { allowed: true, rule: 'allow-entry' }
  if (hostMatchesAny(h, DEFAULT_EGRESS_ALLOWLIST)) {
    return { allowed: true, rule: 'default-allowlist' }
  }
  return { allowed: false, rule: 'not-listed' }
}
