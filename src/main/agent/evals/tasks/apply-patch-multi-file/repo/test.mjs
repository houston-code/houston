import assert from 'node:assert/strict'
import { greet } from './b.mjs'
import { GREETING } from './a.mjs'

assert.equal(GREETING, 'hello')
assert.equal(greet('Ada'), 'hello, Ada')
console.log('ok')
