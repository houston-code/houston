/**
 * Turning a path the agent wrote (a tool argument, a receipt entry, a relative link
 * in a reply) into a workspace file the app can preview. Pure, so the containment
 * rules are unit-tested without a DOM. The main process re-checks every read against
 * the real workspace (resolving symlinks), so this is the first gate, not the only one.
 */

/** A workspace file to open, with the line to show when one is known. */
export interface FileTarget {
  /** Workspace-relative, forward slashes, no `.` or `..` segments. */
  path: string
  /** 1-based. */
  line?: number
}

const DRIVE = /^[A-Za-z]:\//

/** Collapse `.` and `..`, or null when `..` climbs above the start. */
function collapse(segments: string[]): string[] | null {
  const out: string[] = []
  for (const s of segments) {
    if (s === '' || s === '.') continue
    if (s === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(s)
  }
  return out
}

/**
 * The workspace-relative form of `raw`, or null when it is empty, names the workspace
 * itself, or lands outside it (a `..` climb, an absolute path elsewhere, another
 * drive). Windows paths compare case-insensitively.
 */
export function workspaceRelative(raw: string, workspace: string): string | null {
  const p = raw.replace(/\\/g, '/')
  const absolute = p.startsWith('/') || DRIVE.test(p)
  if (!absolute) {
    const rel = collapse(p.split('/'))
    return rel && rel.length ? rel.join('/') : null
  }
  const root = collapse(workspace.replace(/\\/g, '/').split('/'))
  const abs = collapse(p.split('/'))
  if (!root || !abs || !root.length || abs.length <= root.length) return null
  const windows = DRIVE.test(p)
  const same = (a: string, b: string): boolean => (windows ? a.toLowerCase() === b.toLowerCase() : a === b)
  for (let i = 0; i < root.length; i++) if (!same(root[i], abs[i])) return null
  return abs.slice(root.length).join('/')
}

const positive = (s: string | undefined): number | undefined => {
  if (!s) return undefined
  const n = Number(s)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/**
 * Split a written path into the path and a line: `a.ts#L10`, `a.ts#L10-L20`,
 * `a.ts:10`, `a.ts:10:5`. Anything else after `#` (a heading anchor) is dropped.
 */
export function splitLine(raw: string): { path: string; line?: number } {
  let p = raw.trim()
  let line: number | undefined
  const hash = p.indexOf('#')
  if (hash >= 0) {
    const m = /^L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i.exec(p.slice(hash + 1))
    line = positive(m?.[1])
    p = p.slice(0, hash)
  }
  const colon = /^(.*?):(\d+)(?::\d+)?$/.exec(p)
  if (colon && !/^[A-Za-z]$/.test(colon[1])) {
    p = colon[1]
    line ??= positive(colon[2])
  }
  return line ? { path: p, line } : { path: p }
}

/**
 * A relative (or in-workspace absolute) link from a reply as a file to open, or null
 * for anything that isn't a plain path in the workspace: URLs and other schemes
 * (`javascript:`, `file:`, `data:`), a bare `#anchor`, and paths outside it.
 */
export function fileTargetFromHref(href: string, workspace: string | null): FileTarget | null {
  if (!workspace) return null
  let h = href.trim()
  if (!h || h.startsWith('#') || h.startsWith('//')) return null
  const q = h.indexOf('?')
  if (q >= 0) {
    const hash = h.indexOf('#', q)
    h = h.slice(0, q) + (hash >= 0 ? h.slice(hash) : '')
  }
  try {
    h = decodeURIComponent(h)
  } catch {
    return null
  }
  // Control characters never belong in a path someone means to open.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(h)) return null
  const { path, line } = splitLine(h)
  // Any colon left (after a drive letter) is a scheme, not a path.
  const rest = DRIVE.test(path.replace(/\\/g, '/')) ? path.slice(2) : path
  if (rest.includes(':')) return null
  const rel = workspaceRelative(path, workspace)
  if (!rel) return null
  return line ? { path: rel, line } : { path: rel }
}

/** A path from a tool argument or the receipt as a file to open, or null when it's outside the workspace. */
export function fileTargetFromPath(path: string, workspace: string | null, line?: number): FileTarget | null {
  if (!workspace || !path) return null
  const rel = workspaceRelative(path, workspace)
  if (!rel) return null
  return line && Number.isInteger(line) && line > 0 ? { path: rel, line } : { path: rel }
}

/** Tools whose `path` argument is one file. */
const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'multi_edit', 'notebook_edit'])

/** The file a tool call names, at the line a read started from, or null for any other call. */
export function toolFileTarget(
  name: string,
  args: Record<string, unknown> | undefined,
  workspace: string | null
): FileTarget | null {
  if (!FILE_TOOLS.has(name) || !args || typeof args.path !== 'string') return null
  const offset = name === 'read_file' && typeof args.offset === 'number' ? args.offset : undefined
  return fileTargetFromPath(args.path, workspace, offset)
}
