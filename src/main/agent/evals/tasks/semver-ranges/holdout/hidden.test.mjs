import assert from 'node:assert/strict'
import { satisfies } from './lib/range.mjs'
import { compare, parse } from './lib/version.mjs'
import { resolve } from './resolve.mjs'
import { maxSatisfying as refMaxSatisfying, satisfies as refSatisfies } from './semver-reference/range.mjs'

// [range, version, should it satisfy?] -- the semantics of npm's `semver` package.
const CASES = [
  ['1.2.3', '1.2.3', true],
  ['>=1.2.3', '1.10.0', true],
  ['>=1.2.3 <2.0.0', '2.0.0', false],
  ['<1.2.0 || >=2.0.0', '1.5.0', false],
  ['<1.2.0 || >=2.0.0', '2.1.0', true],
  ['*', '3.1.4', true],
  ['1.x', '1.9.9', true],
  ['1.x', '2.0.0', false],
  ['1.2.x', '1.2.9', true],
  ['1.2.x', '1.3.0', false],
  ['~1.2.3', '1.2.9', true],
  ['~1.2.3', '1.3.0', false],
  ['~1', '1.9.0', true],
  ['~0.2.3', '0.2.5', true],
  ['^1.2.3', '1.9.0', true],
  ['^1.2.3', '2.0.0', false],
  ['^1.2.3', '1.2.2', false],
  // Caret allows changes that don't modify the left-most non-zero part.
  ['^0.2.3', '0.2.9', true],
  ['^0.2.3', '0.3.0', false],
  ['^0.0.3', '0.0.3', true],
  ['^0.0.3', '0.0.4', false],
  ['^0.0', '0.0.9', true],
  ['^0.0', '0.1.0', false],
  ['^0.x', '0.9.0', true],
  ['^1.2.x', '1.9.0', true],
  // Hyphen ranges: a partial version on the right means "up to the end of it".
  ['1.2.3 - 2.3.4', '2.3.4', true],
  ['1.2.3 - 2.3.4', '2.3.5', false],
  ['1.2 - 2.3.4', '1.2.0', true],
  ['1.2.3 - 2.3', '2.3.9', true],
  ['1.2.3 - 2.3', '2.4.0', false],
  ['1.2.3 - 2', '2.9.9', true],
  // Pre-releases only match a range that names a pre-release of the same x.y.z.
  ['>1.2.3-alpha.3', '1.2.3-alpha.7', true],
  ['>1.2.3-alpha.3', '3.4.5-alpha.9', false],
  ['>1.2.3-alpha.3', '3.4.5', true],
  ['^1.2.0', '1.3.0-beta.1', false],
  ['*', '1.0.0-rc.1', false],
  ['~1.2.3-beta.2', '1.2.3-beta.4', true],
  ['~1.2.3-beta.2', '1.2.4-beta.1', false],
  ['>=1.0.0-beta.2 <1.0.0', '1.0.0-beta.11', true],
  ['>=1.0.0-beta.11 <1.0.0', '1.0.0-beta.2', false],
  ['>=1.0.0-alpha <1.0.0', '1.0.0-alpha.1', true],
  ['>=1.0.0-1 <1.0.0', '1.0.0-alpha', true],
  // Build metadata never affects matching.
  ['1.2.3', '1.2.3+build.7', true]
]

const failures = []
for (const [range, version, expected] of CASES) {
  const actual = satisfies(version, range)
  if (actual !== expected) failures.push(`satisfies(${JSON.stringify(version)}, ${JSON.stringify(range)}) should be ${expected}`)
}

// Precedence, as the semver spec lists it.
const ORDER = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0']
for (let i = 0; i + 1 < ORDER.length; i++) {
  if (compare(parse(ORDER[i]), parse(ORDER[i + 1])) !== -1) failures.push(`${ORDER[i]} should sort before ${ORDER[i + 1]}`)
}

if (failures.length) {
  console.log(`${failures.length} of ${CASES.length + ORDER.length - 1} cases fail:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}

// What the installer does with all that.
assert.deepEqual(
  resolve(
    { 'left-pad': '^0.2.3', chalk: '^4.1.0', vite: '>=6.0.0-beta.2 <6.0.0', zod: '~3.22' },
    {
      'left-pad': ['0.2.3', '0.2.10', '0.3.0', '1.0.0'],
      chalk: ['4.1.0', '4.1.2', '4.2.0-rc.1', '5.0.0'],
      vite: ['5.4.0', '6.0.0-beta.2', '6.0.0-beta.10', '6.0.0'],
      zod: ['3.21.4', '3.22.0', '3.22.4', '3.23.0']
    }
  ),
  { 'left-pad': '0.2.10', chalk: '4.1.2', vite: '6.0.0-beta.10', zod: '3.22.4' }
)

// And every combination of the forms lib/range.mjs documents, against npm's rules
// (the reference beside this file implements them). Partial versions appear only where
// the doc says what they mean.
let seed = 0x5e7e2
const rand = (n) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed % n
}
const PRE = ['', '', '', '', '-alpha', '-alpha.1', '-beta.2', '-beta.11', '-rc.1', '-1', '-0']
const num = () => rand(4)
const full = () => `${num()}.${num()}.${num()}${PRE[rand(PRE.length)]}`
const partial = () => [`${num()}`, `${num()}.${num()}`, `${num()}.x`, `${num()}.${num()}.x`][rand(4)]
const comparator = () => {
  switch (rand(6)) {
    case 0:
      return `${['', '=', '>', '>=', '<', '<='][rand(6)]}${full()}`
    case 1:
      return `${['>=', '<'][rand(2)]}${num()}.${num()}`
    case 2:
      return `^${rand(2) ? full() : partial()}`
    case 3:
      return `~${rand(2) ? full() : partial()}`
    case 4:
      return rand(5) ? partial() : '*'
    default:
      return full()
  }
}
const alternative = () =>
  rand(5) === 0
    ? `${rand(2) ? full() : `${num()}.${num()}`} - ${rand(2) ? full() : [`${num()}`, `${num()}.${num()}`][rand(2)]}`
    : Array.from({ length: 1 + rand(3) }, comparator).join(' ')
const wrong = []
for (let i = 0; i < 6000 && wrong.length < 8; i++) {
  const range = Array.from({ length: 1 + (rand(4) === 0 ? 1 : 0) }, alternative).join(' || ')
  const version = `${full()}${rand(6) === 0 ? '+build.7' : ''}`
  const want = refSatisfies(version, range)
  if (satisfies(version, range) !== want) wrong.push(`satisfies(${JSON.stringify(version)}, ${JSON.stringify(range)}) should be ${want}`)
  if (i % 20 === 0) {
    const versions = Array.from({ length: 6 }, full)
    const best = refMaxSatisfying(versions, range)
    const got = maxSatisfyingOf(versions, range)
    if (got !== best) wrong.push(`maxSatisfying(${JSON.stringify(versions)}, ${JSON.stringify(range)}) should be ${best}`)
  }
}
function maxSatisfyingOf(versions, range) {
  try {
    return resolve({ dep: range }, { dep: versions }).dep
  } catch {
    return null
  }
}
assert.deepEqual(wrong, [], `ranges resolved unlike npm:\n  ${wrong.join('\n  ')}`)
console.log('ok')
