/**
 * Split a unified diff into per-file sections, then group them into chunks of at
 * most `maxFiles` files so each reviewer call stays small. Chunks are numbered from 1
 * because that is how the report refers to them.
 */
export function splitDiff(diff, maxFiles = 2) {
  const files = []
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) files.push({ path: line.split(' b/')[1], lines: [line] })
    else if (files.length) files[files.length - 1].lines.push(line)
  }
  const chunks = []
  for (let i = 0; i < files.length; i += maxFiles) {
    const group = files.slice(i, i + maxFiles)
    chunks.push({ index: chunks.length + 1, paths: group.map((f) => f.path), text: group.map((f) => f.lines.join('\n')).join('\n') })
  }
  return chunks
}
