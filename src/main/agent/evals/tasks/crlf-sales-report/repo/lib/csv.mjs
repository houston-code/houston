/**
 * Minimal CSV reader for the sales exports. Handles quoted fields (with "" as an
 * escaped quote) and commas inside quotes. One record per line: the exports never
 * put a newline inside a field.
 */
export function parseCsv(text) {
  const lines = text.split('\n')
  const header = splitRow(lines[0])
  const rows = []
  for (const line of lines.slice(1)) {
    if (line === '') continue
    const cells = splitRow(line)
    const row = {}
    header.forEach((name, i) => {
      row[name] = cells[i]
    })
    rows.push(row)
  }
  return rows
}

function splitRow(line) {
  const cells = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        cell += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      cells.push(cell)
      cell = ''
    } else {
      cell += ch
    }
  }
  cells.push(cell)
  return cells
}
