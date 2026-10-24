import assert from 'node:assert/strict'
import { salesReport } from './report.mjs'

// October's export from the same spreadsheet, with refunds in the accounting format.
assert.equal(
  salesReport('data/sales-2026-10.csv'),
  [
    'Sales 2026-10-02 to 2026-10-30',
    '',
    'East       3       $1,440.00',
    'West       2       $1,105.00',
    'North      1         $210.25',
    '----------------------------',
    'TOTAL      6       $2,755.25'
  ].join('\n')
)
console.log('ok')
