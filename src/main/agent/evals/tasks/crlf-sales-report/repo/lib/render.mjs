import { formatCents } from './money.mjs'

/** The fixed-width table the finance channel gets every month. */
export function renderReport({ from, to }, regions) {
  const lines = [`Sales ${from} to ${to}`, '']
  for (const r of regions) lines.push(row(r.region, r.orders, r.cents))
  const orders = regions.reduce((n, r) => n + r.orders, 0)
  const cents = regions.reduce((n, r) => n + r.cents, 0)
  lines.push('-'.repeat(28), row('TOTAL', orders, cents))
  return lines.join('\n')
}

function row(label, orders, cents) {
  return `${label.padEnd(8)}${String(orders).padStart(4)}${formatCents(cents).padStart(16)}`
}
