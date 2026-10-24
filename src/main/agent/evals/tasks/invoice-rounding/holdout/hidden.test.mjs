import assert from 'node:assert/strict'
import { buildInvoice, renderInvoice } from './src/invoice.mjs'
import { buildInvoice as refBuildInvoice, renderInvoice as refRenderInvoice } from './invoice-reference/invoice.mjs'

// Whole invoices, priced exactly as the accountant's spreadsheet prices them (the rules
// are in src/invoice.mjs and src/discount.mjs).

const renovation = buildInvoice({
  lines: [
    { description: 'Design consultation', qty: '3', unitPrice: '33.333' },
    { description: 'Tile sample', qty: '1', unitPrice: '1.005' },
    { description: 'Grout (kg)', qty: '2.5', unitPrice: '4.13' },
    { description: 'Returned fixture', qty: '-1', unitPrice: '2.675' }
  ],
  discount: '5.00',
  taxRate: '8.875'
})
assert.equal(renderInvoice(renovation), [
    '                          amount  discount       tax     total',
    'Design consultation       100.00     -4.49      8.48    103.99',
    'Tile sample                 1.01     -0.05      0.09      1.05',
    'Grout (kg)                 10.33     -0.46      0.88     10.75',
    'Returned fixture           -2.68      0.00     -0.24     -2.92',
    'TOTAL                     108.66     -5.00      9.21    112.87'
  ].join('\n'))

const survey = buildInvoice({
  lines: [
    { description: 'Site visit', qty: '1', unitPrice: '33.33' },
    { description: 'Measurements', qty: '1', unitPrice: '33.33' },
    { description: 'Floor plan', qty: '1', unitPrice: '33.34' }
  ],
  discount: '10.00',
  taxRate: '7.25'
})
assert.equal(renderInvoice(survey), [
    '                          amount  discount       tax     total',
    'Site visit                 33.33     -3.33      2.18     32.18',
    'Measurements               33.33     -3.33      2.18     32.18',
    'Floor plan                 33.34     -3.34      2.18     32.18',
    'TOTAL                     100.00    -10.00      6.54     96.54'
  ].join('\n'))

const supplies = buildInvoice({
  lines: [
    { description: 'Paint (L)', qty: '2', unitPrice: '12.50' },
    { description: 'Primer (L)', qty: '2', unitPrice: '12.50' },
    { description: 'Brushes', qty: '3', unitPrice: '0.335' }
  ],
  discount: '0.01',
  taxRate: '6.35'
})
assert.equal(renderInvoice(supplies), [
    '                          amount  discount       tax     total',
    'Paint (L)                  25.00     -0.01      1.59     26.58',
    'Primer (L)                 25.00      0.00      1.59     26.59',
    'Brushes                     1.01      0.00      0.06      1.07',
    'TOTAL                      51.01     -0.01      3.24     54.24'
  ].join('\n'))

// And any invoice at all, priced by the same rules (the reference beside this file
// implements them exactly).
let seed = 0x1a7e
const rand = (n) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed % n
}
const pick = (xs) => xs[rand(xs.length)]
const QTY = ['1', '1', '2', '3', '7', '12', '0.5', '2.5', '1.25', '0.75', '-1', '-2']
const price = () => `${rand(5) ? rand(200) : rand(20000)}.${String(rand(1000)).padStart(3, '0').slice(0, 2 + rand(2))}`
const wrong = []
for (let i = 0; i < 3000 && wrong.length < 5; i++) {
  const lines = Array.from({ length: 1 + rand(5) }, (_, n) => ({ description: `Item ${n + 1}`, qty: pick(QTY), unitPrice: price() }))
  const ref = refBuildInvoice({ lines })
  const billable = ref.lines.reduce((n, l) => n + Math.max(l.amount, 0), 0)
  // A discount never larger than what it can be shared over.
  const cents = billable > 0 && rand(3) ? rand(Math.min(billable, 50_000) + 1) : 0
  const invoice = { lines, discount: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`, taxRate: pick(['0', '5', '6.35', '7.25', '8.875', '20']) }
  const want = refRenderInvoice(refBuildInvoice(invoice))
  let got
  try {
    got = renderInvoice(buildInvoice(invoice))
  } catch (err) {
    got = `threw ${err.message}`
  }
  if (got !== want) wrong.push(`${JSON.stringify(invoice)}\n    want:\n${want}\n    got:\n${got}`)
}
assert.deepEqual(wrong, [], `invoices priced unlike the accountant's rules:\n${wrong.join('\n')}`)
console.log('ok')
