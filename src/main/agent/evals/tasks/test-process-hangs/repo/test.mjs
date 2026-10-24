import assert from 'node:assert/strict'
import { createService } from './src/service.mjs'

// CI runs this file and waits for it to exit. A suite that still has something
// running after its last check would sit there until the job timeout, so fail fast
// instead. (This guard's own timer doesn't count: it is unref'd, so it never keeps the
// process alive.)
let finished = false
setTimeout(() => {
  console.error('✗ the process is still running 2s after the last check: something is keeping it alive')
  process.exit(1)
}, 2000).unref()
process.on('exit', () => {
  if (!finished) {
    console.error('✗ the process exited before the suite finished')
    process.exitCode = 1
  }
})

const written = []
const loads = []
const service = createService({
  perMinute: 2,
  auditSink: { write: (batch) => written.push(...batch) },
  loadItem: async (path) => {
    loads.push(path)
    return { path, name: `item at ${path}` }
  }
})

assert.deepEqual(await service.handle({ user: 'ada', path: '/items/1' }), {
  status: 200,
  body: { path: '/items/1', name: 'item at /items/1' }
})
assert.equal((await service.handle({ user: 'ada', path: '/items/1' })).status, 200)
assert.deepEqual(loads, ['/items/1'], 'the second read is served from the cache')
assert.equal((await service.handle({ user: 'ada', path: '/items/2' })).status, 429, 'ada is over her limit')
assert.equal((await service.handle({ user: 'bob', path: '/items/2' })).status, 200, 'bob has his own bucket')

await service.close()
assert.deepEqual(
  written.map((e) => `${e.user} ${e.path} ${e.status}`),
  ['ada /items/1 200', 'ada /items/1 200', 'ada /items/2 429', 'bob /items/2 200'],
  'closing the service writes the pending audit entries'
)

finished = true
console.log('ok, waiting for the process to exit')
