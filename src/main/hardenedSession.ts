import { isBlockedSubresourceHost } from './agent/loopback'

/**
 * Lock down an Electron session that loads UNTRUSTED pages — the local dev
 * servers the agent started, rendered both offscreen for the model
 * (`view_localhost`, see localhostCapture.ts) and interactively for the user
 * (the live Preview dock, see preview.ts).
 *
 * A dev-server page is attacker-influenced output: a prompt-injected agent can
 * start a server, and the page it serves can carry arbitrary HTML/JS. Three
 * session-level guards apply to every such page, so both surfaces share one
 * definition and can't drift apart (they did once — the interactive preview
 * pane was missing the download + permission denials the offscreen capture had):
 *
 *  1. **Subresource egress filter** — a page's own `fetch`/`<img>`/… requests to
 *     private, LAN, link-local, or cloud-metadata hosts are cancelled (loopback
 *     and public hosts pass, so the dev server and real CDNs still load). This is
 *     the per-request counterpart to the top-frame loopback pin the callers add.
 *  2. **No downloads** — a page must never save a file to the user's disk; the
 *     agent reaches the filesystem through its own gated tools, not a drive-by
 *     download from a page it rendered.
 *  3. **No device/notification permissions** — camera, microphone, geolocation,
 *     notifications, and the like are all denied. An interactive preview would
 *     otherwise let an untrusted page raise an OS permission prompt that looks
 *     like it came from Houston.
 *
 * The host filter matches on the URL's host literal (like webfetch), so a DNS
 * name resolving to a private IP is a known, deferred gap — see ROADMAP.md.
 */

/**
 * Minimal slice of Electron's `Session` these guards touch, kept narrow so the
 * hardening is unit-testable with a fake. The real `Session` satisfies it.
 */
export interface LockableSession {
  webRequest: {
    onBeforeRequest(
      listener: (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void
    ): void
  }
  on(event: 'will-download', listener: (event: { preventDefault: () => void }) => void): void
  setPermissionRequestHandler(
    handler: ((wc: unknown, permission: string, callback: (granted: boolean) => void) => void) | null
  ): void
}

/** Install the three untrusted-page guards (see the module docs) on `ses`. */
export function hardenUntrustedSession(ses: LockableSession): void {
  ses.webRequest.onBeforeRequest((details, callback) => {
    let hostname = ''
    try {
      hostname = new URL(details.url).hostname
    } catch {
      /* unparseable (data:/blob:/about:) — no network egress, allow */
    }
    callback({ cancel: isBlockedSubresourceHost(hostname) })
  })
  // A click or redirect in an untrusted page must never land a file on disk.
  ses.on('will-download', (event) => event.preventDefault())
  // Deny every device/notification permission an untrusted page might request.
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
}
