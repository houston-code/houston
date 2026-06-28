import { shell } from 'electron'
import { log } from './logger'

/**
 * Scheme allowlist for anything handed to `shell.openExternal`. That sink can
 * launch the OS handler for arbitrary schemes — `file:`, `smb:`, custom app
 * URLs — so external opens must be restricted to web/mail links.
 *
 * Callers already pre-filter (markdown's safeHref, the terminal's web-links
 * addon), but this is the single trust boundary where every external open lands,
 * so the guard lives here too: a future linkified surface can't accidentally
 * route a dangerous scheme through `openExternal`.
 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** Whether `url` is safe to open in the user's external browser/mail client. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return false // unparseable / relative / scheme-relative
  }
}

/** Open `url` externally only if its scheme is allowlisted; otherwise drop it
 * (and log). Returns whether it was opened. */
export function openExternalSafely(url: string): boolean {
  if (!isSafeExternalUrl(url)) {
    log.warn(`Blocked external open of disallowed URL: ${url}`)
    return false
  }
  void shell.openExternal(url)
  return true
}
