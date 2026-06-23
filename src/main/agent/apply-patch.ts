/**
 * Parser for the OpenAI-style `apply_patch` envelope — a compact, multi-file edit
 * format that GPT/Codex models emit natively:
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
 * Parsing is pure (no filesystem) so it's fully unit-tested. Each Update hunk is
 * reduced to a {oldText, newText} pair (context + removed → context + added),
 * which the tool applies through the resilient edit matcher — so a hunk whose
 * context drifted by whitespace still applies.
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
export function parsePatch(patch: string): PatchOp[] {
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
