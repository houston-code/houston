import assert from 'node:assert/strict'
import { salesReport } from './report.mjs'

// Our own hand-written sample.
assert.equal(
  salesReport('data/sample.csv'),
  [
    'Sales 2026-08-03 to 2026-08-21',
    '',
    'West       2       $1,160.25',
    'East       1          $75.50',
    'North      1          $19.99',
    '----------------------------',
    'TOTAL      4       $1,255.74'
  ].join('\n')
)

// The real September export, straight from the finance team's spreadsheet.
assert.equal(
  salesReport('data/sales-2026-09.csv'),
  [
    'Sales 2026-09-01 to 2026-09-29',
    '',
    'East       3       $2,310.00',
    'West       3         $905.40',
    'South      2         $410.10',
    'North      1          $88.00',
    '----------------------------',
    'TOTAL      9       $3,713.50'
  ].join('\n')
)
console.log('ok')
