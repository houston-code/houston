/**
 * Amounts are integer cents once parsed; inputs arrive as decimal strings, and are
 * read exactly (as scaled integers), never through a float.
 */

/** "12.345" at scale 3 -> 12345n */
export function scaled(text, scale) {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(String(text).trim())
  if (!m) throw new Error(`not a decimal amount: ${text}`)
  const n = BigInt(m[2] + (m[3] ?? '').padEnd(scale, '0'))
  return m[1] ? -n : n
}

/** Digits after the decimal point. */
export function decimals(text) {
  return (/\.(\d+)$/.exec(String(text).trim())?.[1] ?? '').length
}

/** n / d, rounded half away from zero. */
export function divRound(n, d) {
  const negative = n < 0n !== d < 0n
  const a = n < 0n ? -n : n
  const b = d < 0n ? -d : d
  const q = (2n * a + b) / (2n * b)
  return negative ? -q : q
}

export function toCents(amount) {
  const k = decimals(amount)
  return Number(divRound(scaled(amount, k) * 100n, 10n ** BigInt(k)))
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
