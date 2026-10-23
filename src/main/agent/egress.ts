import { randomBytes } from 'node:crypto'
import { getSettings } from '../agentHost'
import { startEgressProxy } from '../sandbox'
import type { EgressCheck, EgressProxyEndpoints, EgressProxyHandle } from '../sandbox'
import { evaluateEgress, normalizeEgressHost, resolveEgressMode } from '@shared/egress'
import type { SandboxEgressSettings } from '@shared/egress'
import { isPrivateHost } from './webfetch'

/**
 * App-level seam between the settings-driven egress policy (@shared/egress) and
 * the enforcing proxy (src/main/sandbox/egress-proxy.ts).
 *
 * The proxy is started lazily, once per process, and shared by every run: it
 * holds no per-run state, and its policy callback reads the CURRENT settings on
 * every request — so adding a domain in Settings takes effect for the very next
 * command, mid-run, without a restart.
 */

/**
 * One run's view of the egress policy beyond the settings: the hosts the user allowed
 * for its chat, and where to report a host the policy refused so the user can be
 * asked about it. Registered under a run token (see {@link registerEgressRun}).
 */
export interface EgressRunScope {
  /** Whether the user allowed this exact (normalized) host for the run's chat. */
  allowed(host: string): boolean
  /**
   * A host refused only for not being listed, so allowing it for the chat would let
   * it through. Never called for a deny-list entry or a private address: no answer
   * can open those.
   */
  onRefused(host: string): void
}

const runScopes = new Map<string, EgressRunScope>()

/**
 * Register a run's scope and return the token its commands carry to the proxy (see
 * egressProxyUrl). Random, so one chat's commands can't present another's; release
 * it when the run ends.
 */
export function registerEgressRun(scope: EgressRunScope): { token: string; release(): void } {
  const token = randomBytes(16).toString('hex')
  runScopes.set(token, scope)
  return { token, release: () => void runScopes.delete(token) }
}

/**
 * The per-request policy: may a network-granted sandbox command reach `host`?
 *
 * Private/loopback/metadata IP *literals* are refused before the allowlist is
 * consulted: the proxy runs OUTSIDE the sandbox, so tunneling to them would make
 * it an SSRF pivot with more reach than the sandbox itself (loopback needs no
 * proxy — NO_PROXY keeps it direct where the profile allows it). A corp registry
 * named by an internal HOSTNAME (that merely resolves privately) still works
 * once allowlisted — this guards literals, same stance as web_fetch.
 *
 * Then the settings decide, deny entries first. A host they merely don't list is
 * let through when the requesting run's chat allowed it, and otherwise reported to
 * that run so the user can be asked (a request without a known token gets the
 * settings alone).
 */
export function checkEgressHost(
  host: string,
  settings: { sandboxEgress?: SandboxEgressSettings } = getSettings(),
  scope?: EgressRunScope
): EgressCheck {
  if (isPrivateHost(host)) {
    return { allowed: false, reason: 'private, loopback, and metadata addresses are never proxied' }
  }
  const decision = evaluateEgress(host, settings.sandboxEgress)
  if (decision.allowed) return { allowed: true }
  if (decision.rule === 'deny-entry') return { allowed: false, reason: 'the domain is on the deny list' }
  const h = normalizeEgressHost(host)
  // Only plain DNS names are worth asking about: a public IP literal or anything
  // stranger stays refused without a question, and the name shown on the card is
  // exactly the one the grant will match.
  if (scope && EGRESS_ASKABLE_HOST.test(h)) {
    if (scope.allowed(h)) return { allowed: true }
    scope.onRefused(h)
  }
  return { allowed: false, reason: 'not on the allowlist' }
}

/** A DNS hostname with at least one dot, as the proxy's normalized form spells it. */
const EGRESS_ASKABLE_HOST = /^(?=.{1,253}$)(?!\d+(?:\.\d+)*$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/

/** The scope a request's token names, if it names a live run. */
function scopeForToken(token: string | undefined): EgressRunScope | undefined {
  return token ? runScopes.get(token) : undefined
}

let sharedProxy: Promise<EgressProxyHandle> | undefined

/** Test seam: close and forget the shared proxy. */
export async function resetEgressProxyForTests(): Promise<void> {
  const p = sharedProxy
  sharedProxy = undefined
  if (p) await (await p).close().catch(() => {})
}

export interface EgressDeps {
  settings?: () => { sandboxEgress?: SandboxEgressSettings }
  platform?: NodeJS.Platform
  start?: typeof startEgressProxy
}

/**
 * Resolve the egress-proxy endpoints for a run, or undefined when the user chose
 * egress mode 'all' (legacy unrestricted network — no proxy involved).
 *
 * MUST fail closed: if the proxy cannot start, this throws, and the caller keeps
 * the run's shell network OFF — granting unrestricted egress because the
 * restriction machinery broke would silently reopen the exfiltration channel.
 */
export async function egressEndpointsForRun(
  deps: EgressDeps = {}
): Promise<EgressProxyEndpoints | undefined> {
  const settings = (deps.settings ?? getSettings)()
  if (resolveEgressMode(settings.sandboxEgress) === 'all') return undefined
  if (!sharedProxy) {
    const start = deps.start ?? startEgressProxy
    const settingsNow = deps.settings ?? getSettings
    sharedProxy = start({
      checkHost: (host, token) => checkEgressHost(host, settingsNow(), scopeForToken(token)),
      // The unix-socket + forwarder transport exists for bubblewrap's network
      // namespace; other platforms address the proxy over loopback TCP.
      listenUnix: (deps.platform ?? process.platform) === 'linux'
    }).catch((e) => {
      // A failed start must not wedge every future run on the rejected promise.
      sharedProxy = undefined
      throw e
    })
  }
  return (await sharedProxy).endpoints
}
