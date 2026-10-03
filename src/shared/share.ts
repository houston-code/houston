/**
 * "Share Houston" invite, shared by every surface that offers it: the sidebar
 * button, the native menu item, the command palette, and the TUI's `/share`.
 *
 * Compile-time constants on purpose, like `DOWNLOAD_URL`: nothing the user typed,
 * no setting, and no remote payload can change where a share points. The link is
 * the plain site URL, with no referral or tracking parameter.
 */

/** The page a shared invite links to. */
export const SHARE_URL = 'https://houstoncode.ai'

/** The invite's lead-in, without the link (the macOS share sheet adds the URL itself). */
export const SHARE_BLURB = 'Houston, we have a coding agent. Try it'

/** The full invite as one line of text: what lands on the clipboard. */
export const SHARE_MESSAGE = `${SHARE_BLURB}: ${SHARE_URL}`

/** What the Windows/Linux share popover offers: copy the invite again, or email it. */
export type ShareTarget = 'copy' | 'email'

/** The `mailto:` link that opens a new email with the invite prefilled. */
export function shareEmailUrl(): string {
  return `mailto:?subject=${encodeURIComponent('Try Houston')}&body=${encodeURIComponent(SHARE_MESSAGE)}`
}

/**
 * Outcome of a share request: the macOS share menu opened (it carries its own
 * Copy item), or the invite was copied to the clipboard.
 */
export type ShareResult = 'sheet' | 'copied'
