import { getSettings } from '../agentHost'
import { startEgressProxy } from '../sandbox'
import type { EgressCheck, EgressProxyEndpoints, EgressProxyHandle } from '../sandbox'
import { evaluateEgress, resolveEgressMode } from '@shared/egress'
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
 * The per-request policy: may a network-granted sandbox command reach `host`?
 *
 * Private/loopback/metadata IP *literals* are refused before the allowlist is
 * consulted: the proxy runs OUTSIDE the sandbox, so tunneling to them would make
 * it an SSRF pivot with more reach than the sandbox itself (loopback needs no
 * proxy — NO_PROXY keeps it direct where the profile allows it). A corp registry
 * named by an internal HOSTNAME (that merely resolves privately) still works
 * once allowlisted — this guards literals, same stance as web_fetch.
 */
export function checkEgressHost(
  host: string,
  settings: { sandboxEgress?: SandboxEgressSettings } = getSettings()
): EgressCheck {
  if (isPrivateHost(host)) {
    return { allowed: false, reason: 'private, loopback, and metadata addresses are never proxied' }
  }
  const decision = evaluateEgress(host, settings.sandboxEgress)
  if (decision.allowed) return { allowed: true }
  return {
    allowed: false,
    reason: decision.rule === 'deny-entry' ? 'the domain is on the deny list' : 'not on the allowlist'
  }
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
      checkHost: (host) => checkEgressHost(host, settingsNow()),
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
