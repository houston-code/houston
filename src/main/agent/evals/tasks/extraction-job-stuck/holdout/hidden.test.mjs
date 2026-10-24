import assert from 'node:assert/strict'
import { startExtraction } from './app.mjs'
import { formatStatus } from './extract/progress.mjs'

const ROWS = [
  { id: '5013399', file: 'deed-5013399.pdf' },
  { id: '5015413', file: 'deed-5015413.pdf' },
  { id: '5017720', file: 'deed-5017720.pdf' }
]

/** A fake model API: `plan[file]` is the list of responses that row gets, in order. */
function fakeApi(plan) {
  const calls = []
  async function fetch(_url, init) {
    const file = /document (\S+)\./.exec(JSON.parse(init.body).prompt)[1]
    calls.push(file)
    const queue = plan[file] ?? [200]
    const status = queue.length > 1 ? queue.shift() : queue[0]
    const ok = status >= 200 && status < 300
    return {
      ok,
      status,
      json: async () =>
        ok ? { fields: { owner: `owner of ${file}` } } : { error: { message: MESSAGES[status] ?? 'request failed' } }
    }
  }
  return { fetch, calls }
}
const MESSAGES = {
  404: 'models/gemini-2.5-flash is no longer available to new users',
  503: 'the model is overloaded, try again later',
  400: 'API key not valid'
}

/** Run a job the way the progress screen does: poll until it says finished. */
async function runToEnd(job) {
  await job.started
  // The workers are idle now, so a job that isn't finished never will be.
  const status = job.status()
  assert.ok(status.finished, `the job never reports finished, so the screen polls forever:\n${formatStatus(status)}`)
  return status
}

function run(plan, opts = {}) {
  const api = fakeApi(plan)
  const delays = []
  const job = startExtraction(ROWS, { fetch: api.fetch, sleep: async (ms) => void delays.push(ms), ...opts })
  return { job, api, delays }
}

// A retired model will never answer: one call, no retries.
{
  const { job, api, delays } = run({ 'deed-5015413.pdf': [404] })
  await runToEnd(job)
  assert.equal(api.calls.filter((f) => f === 'deed-5015413.pdf').length, 1, 'a 404 will never succeed, so it must not be retried')
  assert.deepEqual(delays, [])
}

// A bad key is permanent too.
{
  const { job, api, delays } = run({ 'deed-5013399.pdf': [400] })
  await runToEnd(job)
  assert.equal(api.calls.filter((f) => f === 'deed-5013399.pdf').length, 1)
  assert.deepEqual(delays, [])
}

// An overloaded model is transient: back off and try again.
{
  const { job, api, delays } = run({ 'deed-5017720.pdf': [503, 503, 200] })
  const status = await runToEnd(job)
  assert.equal(status.rows[2].state, 'done')
  assert.equal(api.calls.filter((f) => f === 'deed-5017720.pdf').length, 3)
  assert.deepEqual(delays, [500, 1000])
}

// ...but not forever: three retries, then the row fails with the last error.
{
  const { job, api } = run({ 'deed-5017720.pdf': [503] })
  const status = await runToEnd(job)
  assert.equal(api.calls.filter((f) => f === 'deed-5017720.pdf').length, 4)
  assert.equal(status.rows[2].state, 'error')
  assert.equal(status.rows[2].error, 'HTTP 503: the model is overloaded, try again later')
}

// "Stop on the first error": nothing new starts after a row fails; the rest are skipped.
{
  const api = fakeApi({ 'deed-5013399.pdf': [404] })
  // One row at a time, so "after the first failure" is well defined.
  const job = startExtraction(ROWS, { fetch: api.fetch, sleep: async () => {}, stopOnError: true, concurrency: 1 })
  const status = await runToEnd(job)
  assert.deepEqual(
    status.rows.map((r) => r.state),
    ['error', 'skipped', 'skipped']
  )
  assert.deepEqual(api.calls, ['deed-5013399.pdf'])
  assert.equal(formatStatus(status).split('\n')[1], 'processed: 1 / 3')
}
console.log('ok')
