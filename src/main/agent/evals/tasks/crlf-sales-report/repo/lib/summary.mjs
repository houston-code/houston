import { toCents } from './money.mjs'

/** Per-region order counts and revenue, biggest region first. */
export function summarize(rows) {
  const byRegion = new Map()
  for (const row of rows) {
    const r = byRegion.get(row.region) ?? { region: row.region, orders: 0, cents: 0 }
    r.orders++
    r.cents += toCents(row.total)
    byRegion.set(row.region, r)
  }
  return [...byRegion.values()].sort((a, b) => b.cents - a.cents || a.region.localeCompare(b.region))
}

/** First and last order date, as written in the export (ISO dates sort as text). */
export function period(rows) {
  const dates = rows.map((r) => r.date).sort()
  return { from: dates[0], to: dates[dates.length - 1] }
}
