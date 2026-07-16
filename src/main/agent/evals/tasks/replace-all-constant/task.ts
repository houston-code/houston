import { callTool, say, turn, type EvalTask } from '../../types'

/** `edit_file` with `replace_all`: one edit that must land on every occurrence. */
export const task: EvalTask = {
  id: 'replace-all-constant',
  title: 'Rename MAX_RETRIES to MAX_ATTEMPTS',
  prompt:
    "`node test.mjs` fails in this project. Work out what the code should be doing and update it so the test passes. Treat test.mjs as the spec: it defines the expected behaviour, so do not change it.",
  verify: { cmd: 'node', args: ['test.mjs'] },
  script: [
    turn(callTool('c1', 'read_file', { path: 'retry.mjs' })),
    turn(
      callTool('c2', 'edit_file', {
        path: 'retry.mjs',
        old_string: 'MAX_RETRIES',
        new_string: 'MAX_ATTEMPTS',
        replace_all: true
      })
    ),
    turn(say('Renamed the constant at all three call sites.'))
  ]
}
