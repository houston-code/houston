import assert from 'node:assert/strict'
import { MAX_ATTEMPTS, remaining, shouldRetry } from './retry.mjs'

assert.equal(MAX_ATTEMPTS, 3)
assert.equal(shouldRetry(2), true)
assert.equal(shouldRetry(3), false)
assert.equal(remaining(1), 2)
console.log('ok')
