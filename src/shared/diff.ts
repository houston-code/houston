/**
 * A minimal line-level diff (longest-common-subsequence) used to render
 * `edit_file` / `write_file` changes as a red/green diff in the approval card.
 * Pure and dependency-free so it can be unit-tested and shared by the renderer.
 */

export type DiffLineType = 'add' | 'del' | 'ctx'

export interface DiffLine {
  type: DiffLineType
  text: string
}

/**
 * Above this many lines on either side we skip the O(m·n) LCS table and fall back
 * to a coarse "remove all, then add all" diff, so a huge file overwrite can't lock
 * up the renderer.
 */
const MAX_LCS_LINES = 2000

function splitLines(s: string): string[] {
  return s === '' ? [] : s.split('\n')
}

/** Compute a line diff between `oldStr` and `newStr`. */
export function diffLines(oldStr: string, newStr: string): DiffLine[] {
  const a = splitLines(oldStr)
  const b = splitLines(newStr)
  const m = a.length
  const n = b.length

  if (m > MAX_LCS_LINES || n > MAX_LCS_LINES) {
    return [
      ...a.map((text): DiffLine => ({ type: 'del', text })),
      ...b.map((text): DiffLine => ({ type: 'add', text }))
    ]
  }

  // lcs[i][j] = length of the LCS of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: 'del', text: a[i] })
      i++
    } else {
      out.push({ type: 'add', text: b[j] })
      j++
    }
  }
  while (i < m) out.push({ type: 'del', text: a[i++] })
  while (j < n) out.push({ type: 'add', text: b[j++] })
  return out
}

/**
 * A previewed change to ONE file, computed before the write lands.
 *
 * The renderer cannot compute this itself: it has no filesystem, so it cannot know
 * what a file currently holds, and the resilient edit matcher that decides what an
 * `edit_file`/`multi_edit`/`apply_patch` actually produces lives in the main
 * process. So the main process diffs against disk and ships the result. Because it
 * is captured BEFORE the write, the row keeps showing a true diff after the file
 * has already changed.
 */
export interface FileDiffPreview {
  /** Project-relative path, as the tool was given it. */
  path: string
  diff: DiffLine[]
  /** The file does not exist yet, so every line is an addition. */
  created?: boolean
  /** The file is being removed. */
  deleted?: boolean
  /** Renamed from this path (an apply_patch "Move to"). */
  renamedFrom?: string
  /** The diff was cut to a line budget; `diff` is a prefix of the real change. */
  truncated?: boolean
}

export interface DiffStat {
  added: number
  removed: number
}

/** Count added/removed lines in a diff. */
export function diffStat(lines: DiffLine[]): DiffStat {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.type === 'add') added++
    else if (l.type === 'del') removed++
  }
  return { added, removed }
}
