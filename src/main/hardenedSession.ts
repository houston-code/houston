import { isBlockedSubresourceHost } from './agent/loopback'
import type { Cdp } from './cdp'

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
 *
 * The hidden capture window adds one per-page guard on top, {@link blockFileChoosers}:
 * no one is watching that window, so any file picker its page opens is cancelled
 * (and, for the same reason, localhostCapture.ts disables its alert/confirm dialogs).
 * The Preview dock takes neither. There the user clicks, so choosing a file to
 * upload into their own app is theirs to do, and its dialogs are theirs to answer.
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

/**
 * Cancel every native file picker a page opens: `<input type=file>` (clicked,
 * reached through its `<label>`, or opened with `showPicker()`) and the
 * `showOpenFilePicker` / `showSaveFilePicker` / `showDirectoryPicker` APIs.
 *
 * For the hidden `view_localhost` window. Its steps run with user activation, so
 * a click on a label, or on a button whose handler calls `input.click()`, opens a
 * picker even though the target isn't a file input. Electron shows that picker
 * detached, on the user's screen (and un-hides the capture window behind it): a
 * prompt Houston didn't ask for, whose chosen file the page could then send to
 * any public host. Electron has no event to veto a file chooser, so this turns on
 * DevTools' file-chooser interception through the window's protocol client (see
 * cdp.ts), which cancels the picker in the browser process before any dialog
 * exists; the page sees an aborted pick. Each intercepted picker is reported
 * through `onBlocked`. The interception holds across the page's navigations.
 *
 * Resolves true once the interception is in force, false if the page refused it.
 * Never hand the page user activation unless it resolved true.
 */
export async function blockFileChoosers(cdp: Pick<Cdp, 'send' | 'on'>, onBlocked: () => void): Promise<boolean> {
  cdp.on((method) => {
    if (method === 'Page.fileChooserOpened') onBlocked()
  })
  try {
    // Interception only fires with the Page domain enabled; `cancel` dismisses the
    // pick for the page (an input's `cancel` event, an AbortError) instead of
    // leaving it pending forever.
    await cdp.send('Page.enable')
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true, cancel: true })
    return true
  } catch {
    return false
  }
}
