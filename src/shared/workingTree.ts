/**
 * Parsing for the "Changes" panel: turn `git diff HEAD` output (and untracked
 * file contents) into a structured, per-file diff the renderer can display.
 *
 * Pure and dependency-free (it only borrows the line-diff from ./diff for
 * untracked files), so it can be unit-tested without git and shared by both
 * processes. The scope is the whole working tree vs HEAD — every uncommitted
 * change, not just what the current chat touched.
 */

import { diffLines, type DiffLine } from './diff'

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

/** One `@@ … @@` hunk of a file diff. */
export interface DiffHunk {
  /** The verbatim `@@ -a,b +c,d @@ …` header line. */
  header: string
  lines: DiffLine[]
}

/** A single changed file in the working tree. */
export interface FileDiff {
  /** Display path: the new path (or the old path for deletions). */
  path: string
  /** The pre-rename path, present only for renames. */
  oldPath?: string
  status: FileChangeStatus
  hunks: DiffHunk[]
  /** Added line count. */
  added: number
  /** Removed line count. */
  removed: number
  binary: boolean
  /** A note shown instead of hunks (binary / oversized / empty / unreadable). */
  note?: string
}

/** The whole working-tree change set, as returned over IPC to the renderer. */
export interface WorkingTreeChanges {
  /** False when the workspace is not a git repository. */
  isRepo: boolean
  /** Current branch, or null (detached / unborn / non-repo). */
  branch: string | null
  files: FileDiff[]
  /** Total added / removed across every file. */
  added: number
  removed: number
  /** True when some files were omitted (e.g. an untracked-file cap was hit). */
  truncated?: boolean
}

/** Undo git's C-style quoting of a path with unusual characters. */
function dequote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s
      .slice(1, -1)
      .replace(/\\t/g, '\t')
      .replace(/\\n/g, '\n')
      .replace(/\\(["\\])/g, '$1')
  }
  return s
}

/** Resolve a `---`/`+++` path: strip the `a/`|`b/` prefix; `/dev/null` → null. */
function sidePath(raw: string): string | null {
  const s = dequote(raw.trim())
  if (s === '/dev/null') return null
  if (s.startsWith('a/') || s.startsWith('b/')) return s.slice(2)
  return s
}

/**
 * Best-effort parse of the `a/<old> b/<new>` tail of a `diff --git` line, used
 * only as a fallback when a file has no `---`/`+++` lines (mode-only or binary
 * changes). Handles the common unquoted same-name case and git's quoted form.
 */
function parseDiffGitPaths(raw: string): { oldPath: string; newPath: string } | null {
  const quoted = raw.match(/^"(.+)"\s+"(.+)"$/)
  if (quoted) {
    return {
      oldPath: dequote(`"${quoted[1]}"`).replace(/^a\//, ''),
      newPath: dequote(`"${quoted[2]}"`).replace(/^b\//, '')
    }
  }
  const idx = raw.indexOf(' b/')
  if (idx > 0 && raw.startsWith('a/')) {
    return { oldPath: raw.slice(2, idx), newPath: raw.slice(idx + 3) }
  }
  return null
}

type Pending = FileDiff & { _raw?: string }

/** Resolve a file's display path from its `diff --git` header when none was set. */
function finalizeFile(f: Pending): FileDiff {
  const raw = f._raw
  delete f._raw
  if (!f.path && raw) {
    const parsed = parseDiffGitPaths(raw)
    if (parsed) {
      f.path = parsed.newPath
      if (!f.oldPath && parsed.oldPath !== parsed.newPath) f.oldPath = parsed.oldPath
    }
  }
  if (!f.path && f.oldPath) f.path = f.oldPath
  return f
}

/**
 * Parse the unified diff emitted by `git diff HEAD` into per-file diffs. Tolerant
 * of mode-only, rename, and binary entries. Untracked files are not part of this
 * output — see {@link untrackedToFileDiff}.
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let cur: Pending | null = null
  let hunk: DiffHunk | null = null

  const closeHunk = (): void => {
    if (cur && hunk) cur.hunks.push(hunk)
    hunk = null
  }
  const closeFile = (): void => {
    closeHunk()
    if (cur) files.push(finalizeFile(cur))
    cur = null
  }

  // Drop the single trailing newline so the terminating split artifact ('') is
  // not mistaken for an empty context line at the end of the last hunk.
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      closeFile()
      cur = { path: '', status: 'modified', hunks: [], added: 0, removed: 0, binary: false }
      cur._raw = line.slice('diff --git '.length)
      continue
    }
    if (!cur) continue

    if (line.startsWith('new file mode')) {
      cur.status = 'added'
    } else if (line.startsWith('deleted file mode')) {
      cur.status = 'deleted'
    } else if (line.startsWith('rename from ')) {
      cur.oldPath = dequote(line.slice('rename from '.length).trim())
      cur.status = 'renamed'
    } else if (line.startsWith('rename to ')) {
      cur.path = dequote(line.slice('rename to '.length).trim())
      cur.status = 'renamed'
    } else if (line.startsWith('copy to ')) {
      cur.path = dequote(line.slice('copy to '.length).trim())
    } else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      cur.binary = true
      cur.note = 'Binary file'
    } else if (line.startsWith('--- ')) {
      const p = sidePath(line.slice(4))
      if (p === null) {
        if (cur.status !== 'renamed') cur.status = 'added'
      } else if (!cur.oldPath) {
        cur.oldPath = p
      }
    } else if (line.startsWith('+++ ')) {
      const p = sidePath(line.slice(4))
      if (p === null) {
        if (cur.status !== 'renamed') cur.status = 'deleted'
      } else {
        cur.path = p
      }
    } else if (line.startsWith('@@')) {
      closeHunk()
      hunk = { header: line, lines: [] }
    } else if (hunk) {
      const c = line[0]
      if (c === '+') {
        hunk.lines.push({ type: 'add', text: line.slice(1) })
        cur.added++
      } else if (c === '-') {
        hunk.lines.push({ type: 'del', text: line.slice(1) })
        cur.removed++
      } else if (c === ' ') {
        hunk.lines.push({ type: 'ctx', text: line.slice(1) })
      }
      // A leading '\' ("\ No newline at end of file") carries no content.
    }
  }
  closeFile()
  return files
}

/** Options describing why an untracked file's contents can't be shown inline. */
export interface UntrackedDisplay {
  binary?: boolean
  /** Size in KB when the file is over the display cap. */
  tooLargeKb?: number
  unreadable?: boolean
}

/**
 * Build a FileDiff for an untracked file: its full contents as an all-additions
 * diff, or a one-line note when the contents can't be shown (binary, oversized,
 * unreadable, or empty).
 */
export function untrackedToFileDiff(
  path: string,
  content: string | null,
  opts: UntrackedDisplay = {}
): FileDiff {
  const base = { path, status: 'untracked' as const, hunks: [], added: 0, removed: 0 }
  if (opts.binary) return { ...base, binary: true, note: 'Binary file' }
  if (opts.unreadable) return { ...base, binary: false, note: 'Could not read file' }
  if (opts.tooLargeKb != null) {
    return { ...base, binary: false, note: `Large file (${opts.tooLargeKb} KB) — not shown` }
  }
  const lines = diffLines('', content ?? '')
  const added = lines.length
  if (added === 0) return { ...base, binary: false, note: 'Empty file' }
  return {
    path,
    status: 'untracked',
    hunks: [{ header: `@@ -0,0 +1,${added} @@`, lines }],
    added,
    removed: 0,
    binary: false
  }
}

/** Sum added / removed across files. */
export function totalStat(files: FileDiff[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const f of files) {
    added += f.added
    removed += f.removed
  }
  return { added, removed }
}
