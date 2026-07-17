/**
 * Parser for `apply_patch`. Two dialects are accepted, both reduced to the same
 * {oldText, newText} hunks that the tool applies through the resilient edit matcher
 * (so a hunk whose context drifted by whitespace still applies):
 *
 * 1. The OpenAI-style envelope — a compact, multi-file format GPT/Codex emit natively:
 *
 *   *** Begin Patch
 *   *** Add File: path/to/new.ts
 *   +new file contents, one +line per line
 *   *** Update File: path/to/existing.ts
 *   *** Move to: path/to/renamed.ts          (optional)
 *   @@ optional anchor
 *    unchanged context line (leading space)
 *   -removed line
 *   +added line
 *   *** Delete File: path/to/gone.ts
 *   *** End Patch
 *
 * 2. A standard unified diff / `git diff` — what most models reach for when not told
 *    otherwise, and what previously hard-failed:
 *
 *   diff --git a/path b/path        (optional git header; new/deleted/rename detected)
 *   --- a/path                      (or /dev/null for an add)
 *   +++ b/path                      (or /dev/null for a delete)
 *   @@ -1,3 +1,4 @@ optional section
 *    context
 *   -removed
 *   +added
 *
 *    Hunks are consumed by the line counts in their `@@ -a,b +c,d @@` header, so a
 *    removed source line that itself begins with `---`/`+++`/`diff` is never mistaken
 *    for a file header. `a/`, `b/` prefixes and a trailing tab-timestamp are stripped.
 *    Because the executor locates hunks by text (it has no line numbers), an update
 *    hunk still needs at least one context/removed line — the default `-U3` always has
 *    one; a zero-context (`-U0`) insertion is rejected with a clear message.
 *
 * Parsing is pure (no filesystem) so it's fully unit-tested.
 */

export interface AddOp {
  type: 'add'
  path: string
  content: string
}
export interface DeleteOp {
  type: 'delete'
  path: string
}
export interface UpdateHunk {
  oldText: string
  newText: string
}
export interface UpdateOp {
  type: 'update'
  path: string
  moveTo?: string
  hunks: UpdateHunk[]
}
export type PatchOp = AddOp | DeleteOp | UpdateOp

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const ADD = '*** Add File: '
const UPDATE = '*** Update File: '
const DELETE = '*** Delete File: '
const MOVE = '*** Move to: '

function isDirective(line: string): boolean {
  return line.startsWith('*** ')
}

/** Reduce a run of hunk lines (`@@` / ` ` / `-` / `+`) into {oldText,newText} hunks. */
function parseHunks(lines: string[], path: string): UpdateHunk[] {
  const hunks: UpdateHunk[] = []
  let cur: { old: string[]; neu: string[] } | null = null
  const flush = (): void => {
    if (cur) hunks.push({ oldText: cur.old.join('\n'), newText: cur.neu.join('\n') })
    cur = null
  }
  for (const line of lines) {
    if (line.startsWith('@@')) {
      flush()
      continue
    }
    if (!cur) cur = { old: [], neu: [] }
    if (line === '' || line.startsWith(' ')) {
      const text = line === '' ? '' : line.slice(1)
      cur.old.push(text)
      cur.neu.push(text)
    } else if (line.startsWith('-')) {
      cur.old.push(line.slice(1))
    } else if (line.startsWith('+')) {
      cur.neu.push(line.slice(1))
    } else {
      throw new Error(`Update File: ${path}: unexpected hunk line "${line}".`)
    }
  }
  flush()
  if (hunks.length === 0) throw new Error(`Update File: ${path}: no hunks found.`)
  for (const h of hunks) {
    if (h.oldText === '') {
      throw new Error(
        `Update File: ${path}: a hunk has no context or removed lines to locate; include a surrounding line.`
      )
    }
  }
  return hunks
}

/** Parse an `apply_patch` envelope into structured operations. Throws on malformed input. */
function parseEnvelope(patch: string): PatchOp[] {
  const all = patch.replace(/\r\n/g, '\n').split('\n')
  // Trim blank lines around the envelope.
  let start = 0
  while (start < all.length && all[start].trim() === '') start += 1
  let stop = all.length - 1
  while (stop >= 0 && all[stop].trim() === '') stop -= 1
  const lines = all.slice(start, stop + 1)

  if (lines[0] !== BEGIN) throw new Error(`Patch must start with "${BEGIN}".`)
  if (lines[lines.length - 1] !== END) throw new Error(`Patch must end with "${END}".`)

  const ops: PatchOp[] = []
  let i = 1
  while (i < lines.length - 1) {
    const line = lines[i]
    if (line.startsWith(ADD)) {
      const path = line.slice(ADD.length).trim()
      if (!path) throw new Error('Add File: missing path.')
      i += 1
      const body: string[] = []
      while (i < lines.length - 1 && !isDirective(lines[i])) {
        const l = lines[i]
        if (l.startsWith('+')) body.push(l.slice(1))
        else if (l === '') body.push('')
        else throw new Error(`Add File: ${path}: content lines must start with "+".`)
        i += 1
      }
      ops.push({ type: 'add', path, content: body.join('\n') })
    } else if (line.startsWith(DELETE)) {
      const path = line.slice(DELETE.length).trim()
      if (!path) throw new Error('Delete File: missing path.')
      ops.push({ type: 'delete', path })
      i += 1
    } else if (line.startsWith(UPDATE)) {
      const path = line.slice(UPDATE.length).trim()
      if (!path) throw new Error('Update File: missing path.')
      i += 1
      let moveTo: string | undefined
      if (i < lines.length - 1 && lines[i].startsWith(MOVE)) {
        moveTo = lines[i].slice(MOVE.length).trim()
        // An empty destination is silently treated as "no move" by the executor (falsy
        // moveTo), so the requested rename would vanish while the tool reported success.
        if (!moveTo) throw new Error('Move to: missing destination path.')
        i += 1
      }
      const hunkLines: string[] = []
      while (i < lines.length - 1 && !isDirective(lines[i])) {
        hunkLines.push(lines[i])
        i += 1
      }
      ops.push({ type: 'update', path, moveTo, hunks: parseHunks(hunkLines, path) })
    } else {
      throw new Error(`Unexpected line in patch: "${line}".`)
    }
  }
  if (ops.length === 0) throw new Error('Patch contains no file operations.')
  return ops
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Strip a leading `a/` or `b/` (git) prefix; `/dev/null` is returned unchanged. */
function stripDiffPrefix(p: string): string {
  if (p === '/dev/null') return p
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2)
  return p
}

/** A `--- `/`+++ ` path may carry a trailing tab + timestamp; drop it and trim. */
function headerPath(rest: string): string {
  const tab = rest.indexOf('\t')
  return (tab === -1 ? rest : rest.slice(0, tab)).trim()
}

/**
 * Consume one hunk starting at `lines[start]` (an `@@ … @@` header), reading exactly
 * the number of `-`/context and `+`/context lines its header declares. Returns the
 * reduced hunk and the index just past it. Consuming by count — rather than scanning
 * to the next `---`/`diff` — is what makes a removed source line beginning with `---`
 * safe.
 */
function consumeHunk(
  lines: string[],
  start: number,
  path: string
): { hunk: UpdateHunk; next: number } {
  const m = HUNK_HEADER.exec(lines[start])
  if (!m) throw new Error(`Unified diff: malformed hunk header "${lines[start]}".`)
  let oldRemaining = m[2] === undefined ? 1 : parseInt(m[2], 10)
  let newRemaining = m[4] === undefined ? 1 : parseInt(m[4], 10)
  const oldBuf: string[] = []
  const newBuf: string[] = []
  let i = start + 1
  while (i < lines.length && (oldRemaining > 0 || newRemaining > 0)) {
    const l = lines[i]
    if (l.startsWith('\\')) {
      i += 1 // "\ No newline at end of file" — metadata, not a content line
      continue
    }
    const tag = l[0]
    const text = l.length === 0 ? '' : l.slice(1)
    if (l === '' || tag === ' ') {
      oldBuf.push(text)
      newBuf.push(text)
      oldRemaining -= 1
      newRemaining -= 1
    } else if (tag === '-') {
      oldBuf.push(text)
      oldRemaining -= 1
    } else if (tag === '+') {
      newBuf.push(text)
      newRemaining -= 1
    } else {
      throw new Error(`Unified diff: ${path}: unexpected hunk line "${l}".`)
    }
    i += 1
  }
  if (oldRemaining > 0 || newRemaining > 0) {
    throw new Error(`Unified diff: ${path}: hunk ended before its declared line counts were met.`)
  }
  return { hunk: { oldText: oldBuf.join('\n'), newText: newBuf.join('\n') }, next: i }
}

/** Parse a unified diff / `git diff` into the same structured operations. */
function parseUnifiedDiff(patch: string): PatchOp[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n')
  const n = lines.length
  const ops: PatchOp[] = []
  let i = 0

  while (i < n) {
    if (lines[i].trim() === '') {
      i += 1
      continue
    }

    let newFile = false
    let deletedFile = false
    let renameFrom: string | undefined
    let renameTo: string | undefined

    // Optional `diff --git` header block: read its metadata lines until the ---/+++/@@.
    if (lines[i].startsWith('diff --git ')) {
      i += 1
      while (
        i < n &&
        !lines[i].startsWith('--- ') &&
        !lines[i].startsWith('@@') &&
        !lines[i].startsWith('diff --git ')
      ) {
        const h = lines[i]
        if (h.startsWith('new file mode')) newFile = true
        else if (h.startsWith('deleted file mode')) deletedFile = true
        else if (h.startsWith('rename from ')) renameFrom = h.slice('rename from '.length).trim()
        else if (h.startsWith('rename to ')) renameTo = h.slice('rename to '.length).trim()
        // index / similarity / mode / copy headers carry nothing the executor needs.
        i += 1
      }
      // A 100%-similar rename has the rename headers but no ---/+++ or hunks.
      if (renameFrom && renameTo && (i >= n || !lines[i].startsWith('--- '))) {
        ops.push({ type: 'update', path: renameFrom, moveTo: renameTo, hunks: [] })
        continue
      }
    }

    // The ---/+++ header pair.
    let oldPath: string | undefined
    let newPath: string | undefined
    if (i < n && lines[i].startsWith('--- ')) {
      oldPath = headerPath(lines[i].slice(4))
      i += 1
      if (!(i < n && lines[i].startsWith('+++ '))) {
        throw new Error('Unified diff: a "--- " header must be followed by a "+++ " header.')
      }
      newPath = headerPath(lines[i].slice(4))
      i += 1
    } else {
      throw new Error(`Unified diff: expected a "--- " file header but found "${lines[i]}".`)
    }

    // Read every hunk for this file, consuming each by its declared line counts.
    const hunks: UpdateHunk[] = []
    const label = stripDiffPrefix(oldPath === '/dev/null' ? (newPath ?? '') : oldPath)
    while (i < n && lines[i].startsWith('@@')) {
      const { hunk, next } = consumeHunk(lines, i, label)
      hunks.push(hunk)
      i = next
    }

    // Resolve the operation.
    if (deletedFile || newPath === '/dev/null') {
      const path = stripDiffPrefix(oldPath ?? renameFrom ?? '')
      if (!path || path === '/dev/null') throw new Error('Unified diff: delete is missing a source path.')
      ops.push({ type: 'delete', path })
    } else if (newFile || oldPath === '/dev/null') {
      const path = stripDiffPrefix(newPath ?? renameTo ?? '')
      if (!path || path === '/dev/null')
        throw new Error('Unified diff: add is missing a destination path.')
      ops.push({ type: 'add', path, content: hunks.map((h) => h.newText).join('\n') })
    } else {
      const from = stripDiffPrefix(oldPath ?? renameFrom ?? '')
      const to = stripDiffPrefix(newPath ?? renameTo ?? from)
      if (!from) throw new Error('Unified diff: update is missing a file path.')
      if (hunks.length === 0) throw new Error(`Unified diff: ${from}: no hunks found.`)
      for (const h of hunks) {
        if (h.oldText === '') {
          throw new Error(
            `Unified diff: ${from}: a hunk has no context or removed lines to locate; use at least one line of context (the default -U3, not -U0).`
          )
        }
      }
      ops.push({ type: 'update', path: from, moveTo: to !== from ? to : undefined, hunks })
    }
  }

  if (ops.length === 0) throw new Error('Unified diff contains no file operations.')
  return ops
}

/**
 * Parse an `apply_patch` payload into structured operations, accepting either the
 * OpenAI envelope or a unified diff / `git diff`. Throws on malformed input.
 */
export function parsePatch(patch: string): PatchOp[] {
  const firstNonBlank = patch.replace(/\r\n/g, '\n').split('\n').find((l) => l.trim() !== '') ?? ''
  if (firstNonBlank === BEGIN) return parseEnvelope(patch)

  const norm = patch.replace(/\r\n/g, '\n').split('\n')
  const looksUnified =
    norm.some((l) => l.startsWith('diff --git ')) ||
    (norm.some((l) => l.startsWith('--- ')) && norm.some((l) => l.startsWith('+++ ')))
  if (looksUnified) return parseUnifiedDiff(patch)

  throw new Error(
    `Patch must start with "${BEGIN}", or be a unified diff (with "--- "/"+++ " headers or a "diff --git" line).`
  )
}
