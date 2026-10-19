/**
 * Path display helpers for the renderer, which has no `node:path`. Workspace and
 * tool paths arrive in the host OS's form, so on Windows they use backslashes
 * (`C:\Users\me\proj`). Splitting on `/` alone left the whole path as the "name",
 * so labels like the project folder in the control bar showed the full path.
 */

const SEP = /[\\/]/

/** The last segment of a path, ignoring trailing separators; the input when it has none. */
export function baseName(p: string): string {
  const parts = p.split(SEP).filter(Boolean)
  return parts[parts.length - 1] || p
}

/**
 * The last `segments` segments of a path behind an ellipsis, joined with the path's
 * own separator, or the path unchanged when it is already that short.
 */
export function shortenPath(p: string, segments = 2): string {
  const parts = p.split(SEP).filter(Boolean)
  if (parts.length <= segments) return p
  const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/'
  return `…${sep}${parts.slice(-segments).join(sep)}`
}
