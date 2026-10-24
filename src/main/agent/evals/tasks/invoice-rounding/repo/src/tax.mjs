/** Sales tax on an amount in cents, at a percentage rate such as "8.875". */
export function taxCents(cents, ratePercent) {
  return Math.round((cents * Number(ratePercent)) / 100)
}
