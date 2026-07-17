/**
 * A minimal line-level diff (longest-common-subsequence) used to render
 * `edit_file` / `write_file` changes as a red/green diff in the approval card.
 * Pure and dependency-free so it can be unit-tested and shared by the renderer.
 */

/**
 * `skip` stands in for a run of unchanged lines that was folded away by
 * `hunkDiff`; it carries the count so the UI can say what it hid.
 */
export type DiffLineType = 'add' | 'del' | 'ctx' | 'skip'

export interface DiffLine {
  type: DiffLineType
  text: string
  /** How many unchanged lines a `skip` marker stands for. */
  count?: number
}

/** A diff line with its position in the old/new file, for the gutter. */
export interface NumberedLine {
  type: DiffLine['type']
  text: string
  count?: number
  /** Line number in the old file (absent for additions). */
  oldNo?: number
  /** Line number in the new file (absent for deletions). */
  newNo?: number
}

/**
 * Attach old/new line numbers to a (hunked) diff.
 *
 * A `skip` marker stands for `count` unchanged lines, so both sides advance past
 * it — otherwise every number after the first fold would be wrong, which is worse
 * than having no numbers at all.
 */
export function numberDiff(diff: DiffLine[]): NumberedLine[] {
  let oldNo = 0
  let newNo = 0
  return diff.map((l) => {
    switch (l.type) {
      case 'del':
        return { ...l, oldNo: ++oldNo }
      case 'add':
        return { ...l, newNo: ++newNo }
      case 'skip': {
        const n = l.count ?? 0
        oldNo += n
        newNo += n
        return { ...l }
      }
      default:
        return { ...l, oldNo: ++oldNo, newNo: ++newNo }
    }
  })
}

/** Split into words and whitespace runs, so the pieces rejoin exactly. */
export function tokenize(s: string): string[] {
  return s.match(/\s+|[^\s]+/g) ?? []
}

/**
 * Which tokens actually differ between two versions of a line.
 *
 * Common prefix + common suffix, which is linear and catches the shape real edits
 * take (one contiguous change). An LCS would be quadratic on a long line for a
 * marginally better answer on edits people rarely make.
 */
export function wordDiff(oldText: string, newText: string): { del: boolean[]; add: boolean[] } {
  const a = tokenize(oldText)
  const b = tokenize(newText)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  // Nothing in common at either end: mark the whole line rather than pretend the
  // change is narrower than it is.
  return {
    del: a.map((_, i) => i >= start && i < endA),
    add: b.map((_, i) => i >= start && i < endB)
  }
}

/**
 * Pair each `del` with the `add` that replaced it, so a modified line can show
 * WHICH words changed. A `del` immediately followed by an `add` is a replacement;
 * anything else is a whole-line insert or removal, and marking words inside it
 * would invent a precision that isn't there.
 */
export function replacementPairs(lines: NumberedLine[]): Map<number, number> {
  const pairs = new Map<number, number>()
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].type === 'del' && lines[i + 1].type === 'add') {
      pairs.set(i, i + 1)
      i++ // an add already claimed as a replacement can't also start one
    }
  }
  return pairs
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

/** Count added/removed lines in a diff (`skip` markers count for nothing). */
export function diffStat(lines: DiffLine[]): DiffStat {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.type === 'add') added++
    else if (l.type === 'del') removed++
  }
  return { added, removed }
}

/** Lines of unchanged context kept either side of a change. */
export const CONTEXT_LINES = 3

/**
 * Fold a full-file diff down to the changes plus a little context, replacing each
 * long unchanged stretch with a single `skip` marker.
 *
 * This is a correctness fix, not a cosmetic one. A preview used to be the WHOLE
 * file's diff, cut to a line budget with `slice(0, N)` — so a one-line edit at
 * line 500 of a 600-line file produced 400 lines of untouched context and not one
 * changed line. The approval card showed a diff with nothing in it, labelled
 * "truncated", and the user was asked to approve that.
 *
 * Folding first means the budget is spent on the change instead of the file.
 */
export function hunkDiff(lines: DiffLine[], context = CONTEXT_LINES): DiffLine[] {
  const changed = lines.map((l) => l.type === 'add' || l.type === 'del')
  if (!changed.some(Boolean)) return [] // nothing changed: nothing worth showing

  // Keep any line within `context` of a change.
  const keep = lines.map((_, i) =>
    changed.slice(Math.max(0, i - context), i + context + 1).some(Boolean)
  )

  const out: DiffLine[] = []
  let run = 0
  const flush = (): void => {
    if (run > 0) {
      out.push({ type: 'skip', text: `${run} unchanged line${run === 1 ? '' : 's'}`, count: run })
      run = 0
    }
  }
  lines.forEach((l, i) => {
    if (keep[i]) {
      flush()
      out.push(l)
    } else {
      run++
    }
  })
  flush()
  return out
}
