import assert from 'node:assert/strict'
import { apply } from './ot/ops.mjs'
import { editConcurrently } from './ot/session.mjs'

const ins = (pos, text, site) => ({ type: 'insert', pos, text, site })
const del = (pos, len, site) => ({ type: 'delete', pos, len, site })
const same = (doc, a, b, expected) => {
  const s = editConcurrently(doc, a, b)
  assert.equal(s.a, s.b, `screens differ for ${JSON.stringify({ doc, a, b })}`)
  if (expected !== undefined) assert.equal(s.a, expected, JSON.stringify({ doc, a, b }))
}

// Intent: text one site inserts survives a concurrent delete around it.
same('abcdefgh', del(2, 4, 1), ins(4, 'XY', 2), 'abXYgh')
same('abcdefgh', ins(4, 'XY', 2), del(2, 4, 1), 'abXYgh')
// Overlapping and nested deletes remove each character once.
same('abcdefgh', del(1, 4, 1), del(3, 4, 2), 'ah')
same('abcdefgh', del(2, 2, 1), del(0, 8, 2), '')
same('abcdefgh', del(3, 2, 1), del(3, 2, 2), 'abcfgh')
// Same-offset inserts go lower site first, whichever site is "a".
same('ab', ins(1, 'X', 2), ins(1, 'Y', 1), 'aYXb')

// And the contract in general: every pair of edits converges.
let seed = 0x5eed
const rand = (n) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed % n
}
const randomOp = (doc, site) => {
  if (doc.length && rand(2)) {
    const pos = rand(doc.length)
    return del(pos, 1 + rand(doc.length - pos), site)
  }
  return ins(rand(doc.length + 1), 'xyz'.slice(0, 1 + rand(3)), site)
}
for (let i = 0; i < 5000; i++) {
  const doc = 'abcdefghij'.slice(0, rand(11))
  const a = randomOp(doc, 1)
  const b = randomOp(doc, 2)
  same(doc, a, b)
  // Inserted text is still there on both screens.
  for (const op of [a, b]) if (op.type === 'insert') assert.ok(editConcurrently(doc, a, b).a.includes(op.text), JSON.stringify({ doc, a, b }))
}
assert.equal(apply('abc', ins(3, 'd', 1)), 'abcd')
console.log('ok')
