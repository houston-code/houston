import { parsePatch } from './parse.mjs'

/** Find `needle` (an array of lines) in `haystack` at or after `from`. -1 if absent. */
function find(haystack, needle, from) {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

/** Apply one file's hunks, in order, to its text. */
function applyHunks(path, text, hunks) {
  const trailingNewline = text.endsWith('\n')
  const lines = (trailingNewline ? text.slice(0, -1) : text).split('\n')
  let cursor = 0
  hunks.forEach((hunk, n) => {
    const before = hunk.lines.filter((l) => l.op !== '+').map((l) => l.text)
    const after = hunk.lines.filter((l) => l.op !== '-').map((l) => l.text)
    const at = find(lines, before, cursor)
    if (at === -1) throw new Error(`hunk ${n + 1} of ${path} does not match the file`)
    lines.splice(at, before.length, ...after)
    cursor = at + after.length
  })
  return lines.join('\n') + (trailingNewline ? '\n' : '')
}

/** Apply a patch to `files` ({ path: text }), returning the new set of files. */
export function applyPatch(files, patchText) {
  const out = { ...files }
  for (const op of parsePatch(patchText)) {
    if (op.type === 'add') {
      if (op.path in out) throw new Error(`${op.path} already exists`)
      out[op.path] = op.lines.join('\n') + '\n'
    } else if (op.type === 'delete') {
      if (!(op.path in out)) throw new Error(`${op.path} does not exist`)
      delete out[op.path]
    } else {
      if (!(op.path in out)) throw new Error(`${op.path} does not exist`)
      out[op.path] = applyHunks(op.path, out[op.path], op.hunks)
    }
  }
  return out
}
