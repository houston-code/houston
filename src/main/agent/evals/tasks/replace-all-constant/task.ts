import { callTool, say, turn, type EvalTask } from '../../types'

/** `edit_file` with `replace_all`: one edit that must land on every occurrence. */
export const task: EvalTask = {
  id: 'replace-all-constant',
  title: 'Rename MAX_RETRIES to MAX_ATTEMPTS',
  prompt:
    'Rename the MAX_RETRIES constant in retry.mjs to MAX_ATTEMPTS everywhere it appears, so test.mjs passes.',
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
