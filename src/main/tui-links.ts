import { statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { safeHref } from '@shared/markdown'

/**
 * Where the terminal's rendered replies link to: a web link the reply wrote, or a file
 * in the workspace it named. The markdown renderer asks; each answer is a URL to wrap
 * the text in an OSC 8 hyperlink, or null to leave it plain. Built only when the
 * terminal shows links (a colour TTY, not screen-reader mode).
 */
export interface MarkdownLinks {
  /** A link's target as written (`[text](href)`). */
  href: (href: string) => string | null
  /** A path the reply mentioned, in inline code or prose. */
  path: (raw: string) => string | null
}

/** Longest URL put inside a hyperlink; past it the text stays plain. */
const MAX_URL = 2048

/**
 * A reply's web link as a hyperlink target: http(s) or mailto only, and only printable
 * ASCII without spaces, so nothing in it can end the escape sequence or need encoding.
 */
export function webLinkUrl(href: string): string | null {
  const h = safeHref(href)
  if (!h || h.startsWith('#') || h.length > MAX_URL) return null
  return /^[\x21-\x7e]+$/.test(h) ? h : null
}

/** "src/a.ts:10", "src/a.ts#L10-L20" as the file part alone. */
function withoutLine(raw: string): string {
  const hash = raw.indexOf('#')
  const p = hash >= 0 ? raw.slice(0, hash) : raw
  return p.replace(/:\d+(?::\d+)?$/, '')
}

/**
 * A path a reply wrote as a `file://` URL, when it names an existing file inside
 * `cwd`. Relative paths resolve against `cwd`; an absolute one must already be under
 * it. Anything with a scheme, a `..` climb out, or a control character is refused.
 */
export function workspaceFileUrl(
  raw: string,
  cwd: string,
  isFile: (abs: string) => boolean = (abs) => isLinkableFile(abs)
): string | null {
  const p = withoutLine(raw.trim())
  if (!p || p.length > 1024 || p.startsWith('//')) return null
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\x00-\x1f\x7f-\x9f]/.test(p)) return null
  // A colon left (past a Windows drive letter) is a scheme or a URL, not a path.
  const rest = /^[A-Za-z]:[\\/]/.test(p) ? p.slice(2) : p
  if (rest.includes(':')) return null
  const root = resolve(cwd)
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p)
  const rel = relative(root, abs)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  if (!isFile(abs)) return null
  return pathToFileURL(abs).href
}

/**
 * Files a click could run rather than open (the OS hands a `file://` URL to its
 * default handler): scripts, apps and installers. A reply naming one stays plain
 * text, as does any file with an execute bit set. Windows also runs plain script
 * files (`.js` through Windows Script Host, `.py` through the launcher) on open.
 */
const RUNNABLE_EXT =
  /\.(?:command|tool|terminal|app|sh|bash|zsh|fish|csh|ksh|exe|com|bat|cmd|ps1|psm1|vbs|vbe|wsf|wsh|jse|msi|msix|appx|scr|pif|cpl|hta|jar|scpt|applescript|workflow|action|pkg|mpkg|dmg|desktop|lnk|url|webloc|inetloc|reg|run|bin|appimage)$/i
const WINDOWS_RUNNABLE_EXT = /\.(?:js|mjs|cjs|py|pyw|pl|rb)$/i

/** Whether a click on a link to `abs` opens a document rather than running something. */
export function isLinkableFile(abs: string, platform: NodeJS.Platform = process.platform): boolean {
  if (RUNNABLE_EXT.test(abs) || (platform === 'win32' && WINDOWS_RUNNABLE_EXT.test(abs))) return false
  try {
    const st = statSync(abs)
    return st.isFile() && (platform === 'win32' || (st.mode & 0o111) === 0)
  } catch {
    return false
  }
}

/**
 * Path-shaped words in prose: at least one `/` and a file extension, optionally a
 * `:line`. Only these are looked up, so ordinary words never cost a file check.
 * A match never starts inside another path-shaped word (the lookbehind holds every
 * character a path word can hold): restarting after each `+` of a long `x+y/` run
 * made the scan quadratic.
 */
export const PROSE_PATH = /(?<![\w./@+-])((?:\.{1,2}\/)?(?:[\w@.+-]+\/)+[\w@.+-]*\w\.[A-Za-z0-9]+(?::\d+(?::\d+)?)?)(?![\w/])/g

/** The links a session's replies get: web links, and files that exist in `cwd`. Lookups are cached per path. */
export function markdownLinks(cwd: string, isFile: (abs: string) => boolean = (abs) => isLinkableFile(abs)): MarkdownLinks {
  const cache = new Map<string, string | null>()
  return {
    href: (href) => webLinkUrl(href) ?? (/^[a-z][a-z0-9+.-]*:/i.test(href.trim()) ? null : lookup(href)),
    path: (raw) => lookup(raw)
  }
  function lookup(raw: string): string | null {
    if (cache.has(raw)) return cache.get(raw) ?? null
    let decoded = raw
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      // keep it as written
    }
    const url = workspaceFileUrl(decoded, cwd, isFile)
    if (cache.size > 2000) cache.clear()
    cache.set(raw, url)
    return url
  }
}
