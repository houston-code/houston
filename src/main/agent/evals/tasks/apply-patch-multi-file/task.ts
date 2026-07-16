import { callTool, say, turn, type EvalTask } from '../../types'

/**
 * `apply_patch`: one envelope touching two files. The only task whose edit lands
 * through the patch parser rather than the string matcher.
 */
export const task: EvalTask = {
  id: 'apply-patch-multi-file',
  title: 'Change the greeting across two modules',
  prompt:
    "The greeting should read 'hello, <name>' — the constant in a.mjs needs to be 'hello', and greet() in b.mjs should join with a comma. Apply both changes so test.mjs passes.",
  verify: { cmd: 'node', args: ['test.mjs'] },
  script: [
    turn(
      callTool('c1', 'apply_patch', {
        patch: [
          '*** Begin Patch',
          '*** Update File: a.mjs',
          '@@',
          "-export const GREETING = 'hi'",
          "+export const GREETING = 'hello'",
          '*** Update File: b.mjs',
          '@@',
          "-  return GREETING + ' ' + name",
          "+  return GREETING + ', ' + name",
          '*** End Patch'
        ].join('\n')
      })
    ),
    turn(say('Patched both modules — the greeting now reads `hello, <name>`.'))
  ]
}
