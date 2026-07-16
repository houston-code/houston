import assert from 'node:assert/strict'
import { sum } from './sum.mjs'

assert.equal(sum([{ value: 1 }, { value: 2 }]), 3)
assert.equal(sum([]), 0)
// Holes in the list must be skipped, not crash.
assert.equal(sum([{ value: 1 }, null, { value: 2 }]), 3)
console.log('ok')
