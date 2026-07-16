import assert from 'node:assert/strict'
import { makeConfig } from './config.mjs'

assert.equal(makeConfig({ timeoutMs: 50 }).timeoutMs, 50)
assert.equal(makeConfig().timeoutMs, 30)
assert.equal(makeConfig({ timeoutMs: 50 }).describe(), 'timeoutMs=50')
console.log('ok')
