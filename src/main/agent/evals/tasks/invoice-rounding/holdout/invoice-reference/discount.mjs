/**
 * Spread an invoice-level discount over its lines in proportion to their amounts,
 * so each line's tax is charged on what the customer actually pays for it. Refund
 * lines (negative amounts) take no share.
 *
 * Largest remainder: every line gets the floor of its exact share, then the cents
 * left over go one each to the lines whose shares were cut the most (earlier line
 * first on a tie), so the shares always sum to the discount exactly.
 */
export function allocateDiscount(amounts, discountCents) {
  const eligible = amounts.reduce((n, a) => n + Math.max(a, 0), 0)
  if (!eligible || !discountCents) return amounts.map(() => 0)
  const shares = amounts.map((a) => (a > 0 ? Math.floor((discountCents * a) / eligible) : 0))
  let left = discountCents - shares.reduce((n, s) => n + s, 0)
  const byRemainder = amounts
    .map((a, i) => ({ i, remainder: (discountCents * a) % eligible }))
    .filter(({ i }) => amounts[i] > 0)
    .sort((x, y) => y.remainder - x.remainder || x.i - y.i)
  for (const { i } of byRemainder) {
    if (left === 0) break
    shares[i]++
    left--
  }
  return shares
}
