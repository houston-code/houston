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

// Every row succeeds.
{
  const { job } = run({})
  const status = await runToEnd(job)
  assert.equal(formatStatus(status), 'finished: true\nprocessed: 3 / 3\nrow 5013399: done\nrow 5015413: done\nrow 5017720: done')
}

// A retired model is a permanent failure: one call, the reason shown, the job still finishes.
{
  const { job } = run({ 'deed-5015413.pdf': [404] })
  const status = await runToEnd(job)
  assert.equal(
    formatStatus(status),
    [
      'finished: true',
      'processed: 3 / 3',
      'row 5013399: done',
      'row 5015413: error -> HTTP 404: models/gemini-2.5-flash is no longer available to new users',
      'row 5017720: done'
    ].join('\n')
  )
}

console.log('ok')
