import { callTool, say, turn, type EvalTask } from '../../types'

/**
 * Taken from a real Houston chat: a document-extraction app whose progress screen sat
 * at `finished: False` for good once a row failed, showed failed rows as a bare
 * `error`, and kept retrying a model the provider had retired. The fix spans three
 * files: the job counts only successes as processed and drops the error, the retry
 * helper retries permanent 4xx failures, and `stopOnError` is accepted but never
 * honored. The visible test is the stuck job; the holdout checks the retry policy
 * the prompt complains about and the option job.mjs documents.
 */
export const task: EvalTask = {
  id: 'extraction-job-stuck',
  title: 'Make a failing extraction job finish and say why',
  prompt:
    "Our document extraction job never finishes once any row fails: the progress screen sits at `finished: false` forever, and the failed row just says `error` with no reason. When the model we call was retired, it also kept retrying requests that could never succeed. `node test.mjs` reproduces the stuck job. Fix the job. test.mjs is the spec, so do not change it.",
  verify: { cmd: 'node', args: ['test.mjs'] },
  // What else the prompt and job.mjs promise: no retries of a permanent failure, backoff
  // for a transient one, and the "stop on the first error" option.
  holdout: { cmd: 'node', args: ['hidden.test.mjs'] },
  script: [
    turn(callTool('c1', 'run_shell', { command: 'node test.mjs' })),
    turn(
      callTool('c2', 'read_file', { path: 'extract/job.mjs' }),
      callTool('c3', 'read_file', { path: 'extract/retry.mjs' }),
      callTool('c4', 'read_file', { path: 'app.mjs' })
    ),
    turn(
      callTool('c5', 'multi_edit', {
        path: 'extract/job.mjs',
        edits: [
          {
            old_string: '  let processed = 0\n  let next = 0\n',
            new_string: '  let processed = 0\n  let next = 0\n  let stopped = false\n'
          },
          { old_string: '    while (next < rows.length) {', new_string: '    while (next < rows.length && !stopped) {' },
          {
            old_string: "      } catch (err) {\n        entry.state = 'error'\n      }",
            new_string: [
              '      } catch (err) {',
              "        entry.state = 'error'",
              '        entry.error = err instanceof Error ? err.message : String(err)',
              '        processed++',
              '        if (stopOnError) {',
              '          stopped = true',
              "          for (const e of state) if (e.state === 'pending') e.state = 'skipped'",
              '        }',
              '      }'
            ].join('\n')
          },
          {
            old_string: '        finished: processed === rows.length,',
            new_string: "        finished: state.every((e) => e.state !== 'pending' && e.state !== 'working'),"
          }
        ]
      })
    ),
    turn(
      callTool('c6', 'multi_edit', {
        path: 'extract/retry.mjs',
        edits: [
          {
            old_string: 'export async function withRetry(',
            new_string: [
              '// Overloaded, rate limited, or a gateway hiccup: worth another try. Anything else',
              '// with a status (a bad key, a retired model) fails the same way every time.',
              'const TRANSIENT = new Set([408, 429, 500, 502, 503, 504])',
              '',
              'function isTransient(err) {',
              '  return err?.status === undefined || TRANSIENT.has(err.status)',
              '}',
              '',
              'export async function withRetry('
            ].join('\n')
          },
          {
            old_string: '      if (attempt >= retries) throw err',
            new_string: '      if (attempt >= retries || !isTransient(err)) throw err'
          }
        ]
      })
    ),
    turn(callTool('c7', 'run_shell', { command: 'node test.mjs' })),
    turn(
      say(
        "The job only counted successful rows as processed, so one failure kept `finished` false forever, and it threw the error away. Failed rows now count as processed, keep their message, and `stopOnError` skips the rest; retries are limited to transient statuses (429, 5xx, network), so a retired model fails once. `node test.mjs` prints ok."
      )
    )
  ]
}
