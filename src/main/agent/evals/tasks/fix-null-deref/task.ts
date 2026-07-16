import { callTool, say, turn, type EvalTask } from '../../types'

/** Read-then-edit: the plainest bug fix there is, and the canary for the whole path. */
export const task: EvalTask = {
  id: 'fix-null-deref',
  title: 'Fix a null dereference in sum()',
  prompt:
    "`node test.mjs` fails in this project. Work out why and fix the source so it passes. Treat test.mjs as the spec: it defines the expected behaviour, so do not change it.",
  verify: { cmd: 'node', args: ['test.mjs'] },
  script: [
    turn(callTool('c1', 'read_file', { path: 'sum.mjs' })),
    turn(
      callTool('c2', 'edit_file', {
        path: 'sum.mjs',
        old_string: '  for (const item of items) {\n    total += item.value\n  }',
        new_string: '  for (const item of items) {\n    if (!item) continue\n    total += item.value\n  }'
      })
    ),
    turn(say('Fixed — `sum()` now skips null entries.'))
  ]
}
