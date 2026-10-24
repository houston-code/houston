import assert from 'node:assert/strict'
import { satisfies } from './lib/range.mjs'
import { resolve } from './resolve.mjs'

// [range, version, should it satisfy?] -- the semantics of npm's `semver` package.
const CASES = [
  ['1.2.3', '1.2.3', true],
  ['>=1.2.3 <2.0.0', '2.0.0', false],
  ['^1.2.3', '1.9.0', true],
  ['^1.2.3', '2.0.0', false],
  // The reported bug.
  ['^0.2.3', '0.2.9', true],
  ['^0.2.3', '0.3.0', false]
]
for (const [range, version, expected] of CASES) {
  assert.equal(satisfies(version, range), expected, `satisfies(${JSON.stringify(version)}, ${JSON.stringify(range)})`)
}

assert.deepEqual(resolve({ 'left-pad': '^0.2.3' }, { 'left-pad': ['0.2.3', '0.2.10', '0.3.0', '1.0.0'] }), { 'left-pad': '0.2.10' })
console.log('ok')
