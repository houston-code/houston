import { allocateDiscount } from './discount.mjs'
import { lineAmount } from './lines.mjs'
import { formatCents, toCents } from './money.mjs'
import { taxCents } from './tax.mjs'

/**
 * Price an invoice. Every figure is rounded to the cent where it is computed (line
 * amount, discount share, line tax), half away from zero, the way the accountant's
 * spreadsheet does it, and the invoice totals are the sums of the line figures. Tax
 * is charged on each line after its share of the discount.
 */
export function buildInvoice({ lines, discount = '0', taxRate = '0' }) {
  const amounts = lines.map((l) => lineAmount(l.qty, l.unitPrice))
  const shares = allocateDiscount(amounts, toCents(discount))
  const priced = lines.map((l, i) => {
    const tax = taxCents(amounts[i], taxRate)
    return { description: l.description, amount: amounts[i], discount: shares[i], tax, total: amounts[i] - shares[i] + tax }
  })
  const sum = (k) => priced.reduce((n, l) => n + l[k], 0)
  return { lines: priced, subtotal: sum('amount'), discount: sum('discount'), tax: sum('tax'), total: sum('total') }
}

/** The invoice as the customer sees it. */
export function renderInvoice(inv) {
  const row = (label, ...cols) => label.padEnd(22) + cols.map((c) => c.padStart(10)).join('')
  const out = [row('', 'amount', 'discount', 'tax', 'total')]
  for (const l of inv.lines) {
    out.push(row(l.description, formatCents(l.amount), formatCents(-l.discount), formatCents(l.tax), formatCents(l.total)))
  }
  out.push(row('TOTAL', formatCents(inv.subtotal), formatCents(-inv.discount), formatCents(inv.tax), formatCents(inv.total)))
  return out.join('\n')
}
