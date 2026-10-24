/**
 * Money is integer cents everywhere past the parser, so totals never pick up float
 * error. `toCents` accepts what the exports contain: "12.5", "1,204.00", "$7", and
 * refunds as negative amounts. The finance team's spreadsheet uses the accounting
 * format, which writes a negative amount in parentheses: "(45.00)" is -45.00.
 */
export function toCents(amount) {
  const clean = amount.trim().replace(/^\$/, '').replace(/,/g, '')
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(clean)
  if (!m) throw new Error(`not an amount: ${JSON.stringify(amount)}`)
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'))
  return m[1] ? -cents : cents
}

/** 123456 -> "$1,234.56" */
export function formatCents(cents) {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`
}
