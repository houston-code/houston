import { callTool, say, turn, type EvalTask } from '../../types'

/** `multi_edit`: several edits to one file, applied atomically and in order. */
export const task: EvalTask = {
  id: 'multi-edit-rename',
  title: 'Rename the timeout option to timeoutMs',
  prompt:
    "`node test.mjs` fails in this project. Work out what the code should be doing and update it so the test passes. Treat test.mjs as the spec: it defines the expected behaviour, so do not change it.",
  verify: { cmd: 'node', args: ['test.mjs'] },
  script: [
    turn(callTool('c1', 'read_file', { path: 'config.mjs' })),
    turn(
      callTool('c2', 'multi_edit', {
        path: 'config.mjs',
        edits: [
          {
            old_string: '  const timeout = opts.timeout ?? 30',
            new_string: '  const timeoutMs = opts.timeoutMs ?? 30'
          },
          {
            old_string: "    timeout,\n    describe: () => 'timeout=' + timeout",
            new_string: "    timeoutMs,\n    describe: () => 'timeoutMs=' + timeoutMs"
          }
        ]
      })
    ),
    turn(say('Renamed `timeout` to `timeoutMs` across the config module.'))
  ]
}
