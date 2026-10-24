import assert from 'node:assert/strict'
import { applyPatch } from './patch/apply.mjs'

const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')

const SERVER = [
  "import http from 'node:http'",
  '',
  'function first(req) {',
  '  if (!req.user) return null',
  '  return req.user.id',
  '}',
  '',
  'function second(req) {',
  '  if (!req.user) return null',
  '  return req.user.name',
  '}',
  '',
  'export default { first, second }',
  ''
].join('\n')

const CASES = {
  'updates a line in place'() {
    const out = applyPatch({ 'a.txt': 'one\ntwo\nthree\n' }, patch('*** Update File: a.txt', '@@', ' one', '-two', '+2', ' three'))
    assert.equal(out['a.txt'], 'one\n2\nthree\n')
  },
  'adds and deletes files'() {
    const out = applyPatch({ 'old.txt': 'bye\n' }, patch('*** Add File: new.txt', '+hello', '+world', '*** Delete File: old.txt'))
    assert.deepEqual(out, { 'new.txt': 'hello\nworld\n' })
  },
  'applies several hunks in order'() {
    const out = applyPatch(
      { 'a.txt': 'a\nb\nc\nd\ne\n' },
      patch('*** Update File: a.txt', '@@', '-a', '+A', ' b', '@@', ' d', '-e', '+E')
    )
    assert.equal(out['a.txt'], 'A\nb\nc\nd\nE\n')
  },
  'refuses a hunk whose context is not in the file'() {
    assert.throws(() => applyPatch({ 'a.txt': 'x\n' }, patch('*** Update File: a.txt', '@@', '-y', '+z')), /hunk 1 of a.txt does not match/)
  },
  'puts an anchored hunk after its anchor'() {
    const out = applyPatch(
      { 'server.mjs': SERVER },
      patch('*** Update File: server.mjs', '@@ function second(req) {', "-  if (!req.user) return null", "+  if (!req.user) return 'anonymous'")
    )
    assert.equal(out['server.mjs'], SERVER.replace("return null\n  return req.user.name", "return 'anonymous'\n  return req.user.name"))
  },
  'pins an End of File hunk to the end of the file'() {
    const css = '.a {\n  color: red;\n}\n\n.b {\n  color: blue;\n}\n'
    const out = applyPatch(
      { 'site.css': css },
      patch('*** Update File: site.css', '@@', ' }', '+', '+.c {', '+  color: green;', '+}', '*** End of File')
    )
    assert.equal(out['site.css'], css + '\n.c {\n  color: green;\n}\n')
  }
}

const failures = []
for (const [name, run] of Object.entries(CASES)) {
  try {
    run()
  } catch (err) {
    failures.push(`✗ ${name}\n    ${String(err.message).split('\n').join('\n    ')}`)
  }
}
if (failures.length) {
  console.log(`${failures.length} of ${Object.keys(CASES).length} cases fail:\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('ok')
