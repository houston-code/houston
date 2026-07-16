import { callTool, say, turn, type EvalTask } from '../../types'

/** `write_file` creating a file that does not exist yet, satisfying a dangling import. */
export const task: EvalTask = {
  id: 'new-module-write',
  title: 'Write the missing slug module',
  prompt:
    'index.mjs re-exports slugify from ./slug.mjs, but that module does not exist. Write it so test.mjs passes.',
  verify: { cmd: 'node', args: ['test.mjs'] },
  script: [
    turn(callTool('c1', 'read_file', { path: 'test.mjs' })),
    turn(
      callTool('c2', 'write_file', {
        path: 'slug.mjs',
        content: [
          'export function slugify(input) {',
          '  return input',
          '    .trim()',
          '    .toLowerCase()',
          "    .replace(/[^a-z0-9]+/g, '-')",
          "    .replace(/^-+|-+$/g, '')",
          '}',
          ''
        ].join('\n')
      })
    ),
    turn(say('Added `slug.mjs` with a `slugify()` that trims, lowercases, and collapses separators.'))
  ]
}
