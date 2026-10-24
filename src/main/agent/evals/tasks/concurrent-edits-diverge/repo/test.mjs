import assert from 'node:assert/strict'
import { editConcurrently } from './ot/session.mjs'

// One person edits while the other is idle: nothing to reconcile.
assert.deepEqual(
  editConcurrently('Hello world', { type: 'insert', pos: 5, text: ',', site: 1 }, { type: 'insert', pos: 11, text: '!', site: 2 }),
  { a: 'Hello, world!', b: 'Hello, world!' }
)

// The report: two people typed at the same spot at the same moment, and their
// screens disagreed about the result.
const screens = editConcurrently(
  'Meeting at 10',
  { type: 'insert', pos: 11, text: '9 or ', site: 1 },
  { type: 'insert', pos: 11, text: 'about ', site: 2 }
)
assert.equal(screens.a, screens.b, 'the two screens show different text')
assert.equal(screens.a, 'Meeting at 9 or about 10')
console.log('ok')
