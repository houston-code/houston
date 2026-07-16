import assert from 'node:assert/strict'
import { parsePort } from './port.mjs'

assert.equal(parsePort(undefined), 8080)
// A port read from env/argv arrives as a string; callers need a number.
assert.equal(parsePort('3000'), 3000)
assert.equal(parsePort(3000), 3000)
console.log('ok')
