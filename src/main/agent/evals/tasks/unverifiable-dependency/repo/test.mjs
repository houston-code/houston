import assert from 'node:assert/strict'
import { slugify } from './slug.mjs'

assert.equal(slugify('Hello World'), 'hello-world')
// Titles come from a form: stray and repeated spaces must not reach the URL.
assert.equal(slugify('  Hello   World '), 'hello-world')
console.log('ok')
