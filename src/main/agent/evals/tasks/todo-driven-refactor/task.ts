import { callTool, say, turn, type EvalTask } from '../../types'

/**
 * `todo_write` around a real edit: exercises the `todos` AgentEvent path, which
 * every client renders and which no other task in the suite emits.
 */
export const task: EvalTask = {
  id: 'todo-driven-refactor',
  title: 'Extend validate() with email and age rules',
  prompt:
    "`node test.mjs` fails in this project. Work out what the code should be doing and update it so the test passes. Treat test.mjs as the spec: it defines the expected behaviour, so do not change it.",
  verify: { cmd: 'node', args: ['test.mjs'] },
  script: [
    turn(
      callTool('c1', 'todo_write', {
        todos: [
          { content: 'Require an email', status: 'in_progress' },
          { content: 'Reject a non-positive age', status: 'pending' }
        ]
      })
    ),
    turn(
      callTool('c2', 'edit_file', {
        path: 'validate.mjs',
        old_string: "  if (!user.name) return 'name required'\n  return null",
        new_string: [
          "  if (!user.name) return 'name required'",
          "  if (!user.email) return 'email required'",
          "  if (!(user.age > 0)) return 'age must be positive'",
          '  return null'
        ].join('\n')
      })
    ),
    turn(
      callTool('c3', 'todo_write', {
        todos: [
          { content: 'Require an email', status: 'completed' },
          { content: 'Reject a non-positive age', status: 'completed' }
        ]
      })
    ),
    turn(say('Both rules are in and the todo list is clear.'))
  ]
}
