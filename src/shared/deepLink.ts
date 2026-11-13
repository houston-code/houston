/**
 * `houston://` links: the small set of actions another app, a web page or the
 * terminal (`houston open <dir>`) can ask the desktop app to take. Every link is
 * untrusted input, so this parser accepts only these exact shapes and drops
 * everything else:
 *
 *   houston://open?path=<absolute folder>   start a new chat in that folder
 *   houston://chat/<conversation id>        open an existing chat
 *   houston://settings[/<page>]             open Settings, at a page when named
 *
 * A link can never run a command, send a prompt, or change a setting. Opening a
 * folder the app hasn't seen asks the user first (see src/main/deepLinks.ts).
 *
 * Pure (no Node or Electron imports) so the standalone CLI can build links with it.
 */

export const DEEP_LINK_SCHEME = 'houston'

/** Longest link accepted; anything larger is not something Houston produced. */
export const MAX_DEEP_LINK_LENGTH = 4096

/** The Settings pages a link may open (the ids in the renderer's pageIds.ts). */
export const DEEP_LINK_SETTINGS_PAGES = [
  'models',
  'agent',
  'tools',
  'customize',
  'mcp',
  'hooks',
  'memory',
  'workspace',
  'general',
  'appearance',
  'keyboard',
  'permissions',
  'about'
] as const

export type DeepLinkSettingsPage = (typeof DEEP_LINK_SETTINGS_PAGES)[number]

export type DeepLink =
  | { type: 'open-folder'; path: string }
  | { type: 'open-chat'; conversationId: string }
  | { type: 'open-settings'; page?: DeepLinkSettingsPage }

const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Whether `p` is an absolute local path: POSIX `/…` or a Windows drive path
 * (`C:\…`). UNC and other network paths (`\\host\share`, `//host/share`) are
 * refused: on Windows, merely touching one can send the user's credentials to
 * that host.
 */
export function isAbsoluteLocalPath(p: string): boolean {
  if (p.startsWith('//') || p.startsWith('\\\\')) return false
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)
}

/** Control characters (including NUL) never belong in a path from a link. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/** Parse a `houston://` link, or return null for anything that isn't exactly a supported action. */
export function parseDeepLink(raw: unknown): DeepLink | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_DEEP_LINK_LENGTH) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null
  // Credentials or a port in a link mean it was not built by Houston.
  if (url.username || url.password || url.port) return null
  const action = url.hostname.toLowerCase()
  const segments = url.pathname.split('/').filter(Boolean)

  if (action === 'open') {
    if (segments.length > 0) return null
    const paths = url.searchParams.getAll('path')
    if (paths.length !== 1) return null
    const path = paths[0]
    if (!path || CONTROL_CHARS.test(path) || !isAbsoluteLocalPath(path)) return null
    return { type: 'open-folder', path }
  }

  if (action === 'chat') {
    if (segments.length !== 1 || url.search) return null
    const id = decodeSegment(segments[0])
    if (!id || !CONVERSATION_ID_RE.test(id)) return null
    return { type: 'open-chat', conversationId: id.toLowerCase() }
  }

  if (action === 'settings') {
    if (url.search || segments.length > 1) return null
    if (segments.length === 0) return { type: 'open-settings' }
    const page = decodeSegment(segments[0])?.toLowerCase()
    const known = DEEP_LINK_SETTINGS_PAGES.find((p) => p === page)
    return known ? { type: 'open-settings', page: known } : null
  }

  return null
}

function decodeSegment(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

/** The link that opens `absPath` as a new chat (built by `houston open`). */
export function folderDeepLink(absPath: string): string {
  return `${DEEP_LINK_SCHEME}://open?path=${encodeURIComponent(absPath)}`
}

/** The first argument that looks like a Houston link (Windows and Linux pass links on argv). */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  const prefix = `${DEEP_LINK_SCHEME}://`
  return argv.find((a) => typeof a === 'string' && a.toLowerCase().startsWith(prefix)) ?? null
}
