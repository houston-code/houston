import { decimals, divRound, scaled } from './money.mjs'

/** Sales tax on an amount in cents, at a percentage rate such as "8.875". */
export function taxCents(cents, ratePercent) {
  const k = decimals(ratePercent)
  return Number(divRound(BigInt(cents) * scaled(ratePercent, k), 100n * 10n ** BigInt(k)))
}
