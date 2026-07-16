import assert from 'node:assert/strict'
import { validate } from './validate.mjs'

assert.equal(validate({ name: 'a', email: 'e@x', age: 30 }), null)
assert.equal(validate({ email: 'e@x', age: 30 }), 'name required')
assert.equal(validate({ name: 'a', age: 30 }), 'email required')
assert.equal(validate({ name: 'a', email: 'e@x', age: -1 }), 'age must be positive')
console.log('ok')
