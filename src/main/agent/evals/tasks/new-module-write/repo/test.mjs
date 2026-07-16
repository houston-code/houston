import assert from 'node:assert/strict'
import { slugify } from './index.mjs'

assert.equal(slugify('Hello World'), 'hello-world')
assert.equal(slugify('  Trim  Me  '), 'trim-me')
assert.equal(slugify('Already-slugged'), 'already-slugged')
console.log('ok')
