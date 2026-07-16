import { callTool, say, turn, type EvalTask } from '../../types'

/** Locate-then-edit: `search_files` finds the file, the edit lands in a subdirectory. */
export const task: EvalTask = {
  id: 'search-then-fix',
  title: 'Find titleCase() and make it empty-string safe',
  prompt:
    'Something in this repo defines titleCase(), and it throws on an empty string. Find it, make it return an empty string instead, and make sure test.mjs passes.',
  verify: { cmd: 'node', args: ['test.mjs'] },
  script: [
    turn(callTool('c1', 'search_files', { pattern: 'function titleCase', files_with_matches: true })),
    turn(callTool('c2', 'read_file', { path: 'lib/text.mjs' })),
    turn(
      callTool('c3', 'edit_file', {
        path: 'lib/text.mjs',
        old_string: '  return s[0].toUpperCase() + s.slice(1)',
        new_string: '  if (!s) return s\n  return s[0].toUpperCase() + s.slice(1)'
      })
    ),
    turn(say('`titleCase()` in `lib/text.mjs` now returns an empty string unchanged.'))
  ]
}
