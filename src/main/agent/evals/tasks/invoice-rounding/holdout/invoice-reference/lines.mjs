import { decimals, divRound, scaled } from './money.mjs'

/** A line's amount: quantity times unit price, to the cent, computed exactly. */
export function lineAmount(qty, unitPrice) {
  const q = decimals(qty)
  const p = decimals(unitPrice)
  return Number(divRound(scaled(qty, q) * scaled(unitPrice, p) * 100n, 10n ** BigInt(q + p)))
}
