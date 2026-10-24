/**
 * Edits to a plain-text document, as the collaborative editor sends them:
 *
 *   { type: 'insert', pos, text, site }   insert `text` before offset `pos`
 *   { type: 'delete', pos, len, site }    delete `len` characters starting at `pos`
 *
 * `site` identifies the client that made the edit. Offsets count UTF-16 code units,
 * like String#slice.
 */
export function apply(doc, op) {
  if (op.type === 'insert') {
    if (op.pos < 0 || op.pos > doc.length) throw new RangeError(`insert at ${op.pos} outside 0..${doc.length}`)
    return doc.slice(0, op.pos) + op.text + doc.slice(op.pos)
  }
  if (op.pos < 0 || op.pos + op.len > doc.length) throw new RangeError(`delete ${op.pos}+${op.len} outside 0..${doc.length}`)
  return doc.slice(0, op.pos) + doc.slice(op.pos + op.len)
}

/** Apply a list of ops in order. */
export const applyAll = (doc, ops) => ops.reduce(apply, doc)
