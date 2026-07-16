import { callTool, say, turn, type EvalTask } from '../../types'

/** Read-then-edit: the plainest bug fix there is, and the canary for the whole path. */
export const task: EvalTask = {
  id: 'fix-null-deref',
  title: 'Fix a null dereference in sum()',
  prompt:
    'sum() in sum.mjs throws when the list contains a null hole. Skip null entries instead of crashing, then make sure test.mjs passes.',
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
