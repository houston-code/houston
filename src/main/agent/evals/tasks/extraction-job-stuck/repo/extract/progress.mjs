/** The text the progress screen shows for a status snapshot. */
export function formatStatus(status) {
  const lines = [`finished: ${status.finished}`, `processed: ${status.processed} / ${status.total}`]
  for (const row of status.rows) {
    if (row.state === 'error') lines.push(`row ${row.id}: error${row.error ? ` -> ${row.error}` : ''}`)
    else lines.push(`row ${row.id}: ${row.state}`)
  }
  return lines.join('\n')
}
