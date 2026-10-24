/** Amounts are integer cents once parsed; inputs arrive as decimal strings. */
export function toCents(amount) {
  return Math.round(Number(amount) * 100)
}

/** 123456 -> "1,234.56", -268 -> "-2.68" */
export function formatCents(cents) {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${whole}.${String(abs % 100).padStart(2, '0')}`
}
