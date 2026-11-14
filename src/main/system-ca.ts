// The module object itself, not a namespace import: deferTrustSystemCertificates swaps
// its `connect`, and a bundled namespace import is a read-only copy.
import tls from 'node:tls'
import { log } from './logger'

/**
 * Trust the operating system's certificate store for outbound TLS, in addition to
 * Node's bundled Mozilla roots.
 *
 * Node (and so Electron's main process, where every provider SDK runs) verifies TLS
 * against its own bundled CA list and ignores the Windows certificate store, the
 * macOS keychain, and the distro's CA bundle. On a network that inspects TLS (a
 * corporate proxy or endpoint-security product re-signing traffic with a root CA the
 * IT department installed into the OS store), every API call then fails certificate
 * verification, which the SDKs report as a bare "Connection error." A browser on the
 * same machine works, because it reads the OS store. Adding the system roots makes
 * Houston agree with the browser.
 *
 * Additive only: the current defaults (bundled roots plus any NODE_EXTRA_CA_CERTS)
 * stay trusted, so nothing that verified before can stop verifying. The API needs
 * Node 22.19+/24.5+; on an older standalone-CLI runtime this is a no-op.
 *
 * Returns how many system roots were added (0 when there was nothing to add).
 */
export function trustSystemCertificates(api: CaApi = tls): number {
  if (typeof api.getCACertificates !== 'function' || typeof api.setDefaultCACertificates !== 'function') {
    return 0
  }
  try {
    const current = new Set(api.getCACertificates('default'))
    const added = api.getCACertificates('system').filter((c) => !current.has(c))
    if (added.length === 0) return 0
    api.setDefaultCACertificates([...current, ...added])
    return added.length
  } catch (e) {
    // An unreadable store must not stop startup; the bundled roots still apply.
    log.warn(`could not load system CA certificates: ${String(e)}`)
    return 0
  }
}

/** The slice of `node:tls` this needs, optional so older runtimes degrade to a no-op. */
export interface CaApi {
  getCACertificates?: (type: 'default' | 'system') => string[]
  setDefaultCACertificates?: (certs: string[]) => void
}

/** {@link CaApi} plus the `connect` every TLS client in the process opens its sockets with. */
export interface DeferredCaApi extends CaApi {
  connect: (...args: never[]) => unknown
}

/**
 * {@link trustSystemCertificates}, moved off the start-up path without letting any TLS
 * connection start before it. Reading the store takes tens of milliseconds, which an
 * interactive client would rather spend after its prompt is on screen; it calls the
 * returned function then. Until that call, the first `tls.connect()` runs it before
 * connecting: fetch, `node:https`, HTTP/2 and WebSockets all open their sockets through
 * `tls.connect`, so no request can reach a server ahead of the system roots. Runs once;
 * the wrapper puts `connect` back as soon as it has.
 *
 * `api` must be the `node:tls` module object itself (or a stand-in), not a namespace
 * import's read-only copy.
 */
export function deferTrustSystemCertificates(api: DeferredCaApi = tls as unknown as DeferredCaApi): () => void {
  const connect = api.connect
  let trusted = false
  const trustNow = (): void => {
    if (trusted) return
    trusted = true
    if (api.connect === gated) api.connect = connect
    trustSystemCertificates(api)
  }
  const gated = function (this: unknown, ...args: never[]): unknown {
    trustNow()
    return connect.apply(this, args)
  }
  api.connect = gated
  return trustNow
}
