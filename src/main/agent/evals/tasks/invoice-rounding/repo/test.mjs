import assert from 'node:assert/strict'
import { buildInvoice, renderInvoice } from './src/invoice.mjs'

// The reported invoice: a returned fixture at 2.675 must be refunded as -2.68, the
// way the accountant's spreadsheet rounds it.
const invoice = buildInvoice({
  lines: [
    { description: 'Pendant light', qty: '2', unitPrice: '64.50' },
    { description: 'Returned fixture', qty: '-1', unitPrice: '2.675' }
  ]
})
assert.equal(
  renderInvoice(invoice),
  [
    '                          amount  discount       tax     total',
    'Pendant light             129.00      0.00      0.00    129.00',
    'Returned fixture           -2.68      0.00      0.00     -2.68',
    'TOTAL                     126.32      0.00      0.00    126.32'
  ].join('\n')
)
console.log('ok')
