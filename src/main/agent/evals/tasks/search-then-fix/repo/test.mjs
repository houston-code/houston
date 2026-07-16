import assert from 'node:assert/strict'
import { titleCase } from './lib/text.mjs'
import { clamp } from './lib/math.mjs'

assert.equal(titleCase('hello'), 'Hello')
assert.equal(clamp(5, 0, 3), 3)
// An empty string must come back empty, not throw.
assert.equal(titleCase(''), '')
console.log('ok')
