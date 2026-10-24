/**
 * The extraction job behind the progress screen: one model call per spreadsheet row,
 * a few at a time. The screen polls `status()` once a second and stops polling when
 * it reports `finished`.
 *
 * `stopOnError` is the screen's "stop on the first error" checkbox: once a row fails,
 * no new rows start, and the ones that never started are reported as `skipped`.
 *
 * `processed` counts the rows that ran to an outcome, done or failed; a skipped row
 * never ran.
 */
export function createJob(rows, extractRow, { concurrency = 2, stopOnError = false } = {}) {
  const state = rows.map((row) => ({ id: row.id, state: 'pending', fields: null, error: null }))
  let processed = 0
  let next = 0

  async function worker() {
    while (next < rows.length) {
      const i = next++
      const entry = state[i]
      entry.state = 'working'
      try {
        entry.fields = await extractRow(rows[i])
        entry.state = 'done'
        processed++
      } catch (err) {
        entry.state = 'error'
      }
    }
  }

  return {
    async start() {
      const workers = Array.from({ length: Math.min(concurrency, rows.length) }, worker)
      await Promise.all(workers)
    },
    status() {
      return {
        finished: processed === rows.length,
        processed,
        total: rows.length,
        rows: state.map((e) => ({ ...e }))
      }
    }
  }
}
