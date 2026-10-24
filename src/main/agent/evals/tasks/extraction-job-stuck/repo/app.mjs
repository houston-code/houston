import { createModelClient } from './extract/client.mjs'
import { createJob } from './extract/job.mjs'
import { withRetry } from './extract/retry.mjs'

const PROMPT = (row) => `Extract owner, parcel number and sale date from document ${row.file}.`

/**
 * Fill the missing spreadsheet columns from the property documents. Returns the job
 * so the progress screen can poll it; `start()` resolves when every worker is idle.
 */
export function startExtraction(rows, { fetch, sleep, model = 'models/gemini-2.5-flash', apiKey = 'demo', stopOnError, concurrency }) {
  const client = createModelClient({ fetch, model, apiKey })
  const job = createJob(rows, (row) => withRetry(() => client.extract(PROMPT(row)), { sleep }), { stopOnError, concurrency })
  job.started = job.start()
  return job
}
