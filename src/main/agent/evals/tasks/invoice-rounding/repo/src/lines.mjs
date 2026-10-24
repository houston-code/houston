import { toCents } from './money.mjs'

/** A line's amount: quantity times unit price, to the cent. */
export function lineAmount(qty, unitPrice) {
  return toCents(Number(qty) * Number(unitPrice))
}
