import { readFileSync } from 'node:fs'
import { parseCsv } from './lib/csv.mjs'
import { period, summarize } from './lib/summary.mjs'
import { renderReport } from './lib/render.mjs'

/** Build the monthly report from a sales export. */
export function salesReport(path) {
  const rows = parseCsv(readFileSync(path, 'utf8'))
  return renderReport(period(rows), summarize(rows))
}

if (process.argv[2]) console.log(salesReport(process.argv[2]))
