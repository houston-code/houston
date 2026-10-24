/**
 * Spread an invoice-level discount over its lines in proportion to their amounts,
 * so each line's tax is charged on what the customer actually pays for it. Refund
 * lines (negative amounts) take no share.
 *
 * The shares must add up to the discount exactly, as on the accountant's spreadsheet:
 * a leftover cent goes to the line whose exact share was cut the most (the earlier
 * line on a tie).
 */
export function allocateDiscount(amounts, discountCents) {
  const eligible = amounts.reduce((n, a) => n + Math.max(a, 0), 0)
  if (!eligible || !discountCents) return amounts.map(() => 0)
  return amounts.map((a) => (a > 0 ? Math.round((discountCents * a) / eligible) : 0))
}
