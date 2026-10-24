/**
 * Parse a patch envelope:
 *
 *   *** Begin Patch
 *   *** Update File: src/app.mjs
 *   @@ function start()          optional anchor: the hunk is after this line
 *    context line                (leading space)
 *   -removed line
 *   +added line
 *   *** End of File              optional: the hunk ends at the end of the file
 *   *** Add File: src/new.mjs
 *   +every line of the new file
 *   *** Delete File: src/old.mjs
 *   *** End Patch
 *
 * Diff tools also emit "\ No newline at end of file" after a hunk line; it says
 * something about the line before it and is not itself a line of the file.
 *
 * Returns [{ type: 'update', path, hunks: [{ anchor, lines: [{ op, text }], atEof }] }
 *          | { type: 'add', path, lines: [text] } | { type: 'delete', path }].
 */
export function parsePatch(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  if (lines[0] !== '*** Begin Patch') throw new Error('patch must start with "*** Begin Patch"')
  if (lines[lines.length - 1] !== '*** End Patch') throw new Error('patch must end with "*** End Patch"')

  const ops = []
  let op = null
  let hunk = null
  for (let i = 1; i < lines.length - 1; i++) {
    const line = lines[i]
    let m
    if ((m = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line))) {
      op = { type: m[1].toLowerCase(), path: m[2].trim() }
      if (op.type === 'update') op.hunks = []
      if (op.type === 'add') op.lines = []
      ops.push(op)
      hunk = null
    } else if (op?.type === 'add' && line.startsWith('+')) {
      op.lines.push(line.slice(1))
    } else if (op?.type === 'update' && line.startsWith('@@')) {
      hunk = { anchor: line.slice(2).trim() || null, lines: [], atEof: false }
      op.hunks.push(hunk)
    } else if (op?.type === 'update' && /^[ +-]/.test(line)) {
      if (!hunk) {
        hunk = { anchor: null, lines: [], atEof: false }
        op.hunks.push(hunk)
      }
      hunk.lines.push({ op: line[0], text: line.slice(1) })
    } else if (op?.type === 'update' && line === '') {
      // An editor stripped the leading space from an empty context line.
      hunk?.lines.push({ op: ' ', text: '' })
    } else {
      throw new Error(`line ${i + 1}: unexpected ${JSON.stringify(line)}`)
    }
  }
  return ops
}
