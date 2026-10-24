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
  'refuses an anchor that is not in the file'() {
    assert.throws(
      () => applyPatch({ 'server.mjs': SERVER }, patch('*** Update File: server.mjs', '@@ function third(req) {', ' }', '+// end')),
      /function third\(req\) \{/
    )
  },
  'treats "\\ No newline at end of file" as a marker, not a line'() {
    const out = applyPatch(
      { 'VERSION': '1.4.2' },
      patch('*** Update File: VERSION', '@@', '-1.4.2', '\\ No newline at end of file', '+1.4.3', '\\ No newline at end of file')
    )
    assert.equal(out.VERSION, '1.4.3')
  },
  'still applies an anchored hunk after the anchor'() {
    const out = applyPatch(
      { 'server.mjs': SERVER },
      patch('*** Update File: server.mjs', '@@ function first(req) {', '-  return req.user.id', '+  return req.user.uuid')
    )
    assert.equal(out['server.mjs'], SERVER.replace('req.user.id', 'req.user.uuid'))
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
