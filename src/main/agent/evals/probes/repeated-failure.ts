import { shellExitCode } from '@shared/runtimes'
import { callTool, say, turn, type ProbeTask } from '../types'
import { changesThings, fail, pass, seed, shellCommand, writeFiles } from './kit'

/** run_shell answers a failed command with its output and exit code, not an error. */
function commandFailed(output: string | undefined): boolean {
  const code = shellExitCode(output ?? '')
  return code !== null && code !== 0
}

const COMMAND = 'node check.mjs'

const FILES: Record<string, string> = {
  // Its own message rather than JSON.parse's, which differs between Node versions.
  'check.mjs': [
    "import { readFileSync } from 'node:fs'",
    '',
    'try {',
    "  JSON.parse(readFileSync('settings.json', 'utf8'))",
    '} catch {',
    "  console.error('check failed: settings.json is not valid JSON')",
    '  process.exit(1)',
    '}',
    "console.log('check passed')",
    ''
  ].join('\n'),
  // The trailing comma is the defect.
  'settings.json': '{\n  "theme": "dark",\n  "pageSize": 20,\n}\n'
}

const first = seed.call('s1', 'run_shell', { command: COMMAND })
const second = seed.call('s2', 'run_shell', { command: COMMAND })

/** run_shell's result for the failing check. */
const FAILED = 'check failed: settings.json is not valid JSON\n[exit code: 1]'

/**
 * A command has failed twice the same way. Running it a third time with nothing
 * changed can't give a different answer: the agent should look at why it fails. A
 * rerun after a fix (an edit, or another command) is the fix loop, and fine.
 */
export const probe: ProbeTask = {
  id: 'repeated-failure',
  title: 'A command failed twice the same way: no third run with nothing changed',
  messages: [
    seed.user(`\`${COMMAND}\` fails in this project. Get it passing.`),
    seed.calls(first),
    seed.result(first, FAILED),
    seed.calls(second),
    seed.result(second, FAILED)
  ],
  maxActions: 3,
  setup: (ws) => writeFiles(ws, FILES),
  grade(run) {
    // The seed ends on a failure of COMMAND with nothing changed since.
    let failing: string | undefined = COMMAND
    for (const call of run.calls) {
      const command = shellCommand(call)
      if (command !== undefined && command === failing) {
        return fail(`ran \`${command}\` again with nothing changed since it last failed`)
      }
      // Any other write or command that ran may have changed what the failing one sees.
      if (changesThings(call) && call.ran && call.ok !== false) failing = undefined
      if (command !== undefined && call.ran && commandFailed(call.output)) failing = command
    }
    return pass('changed something before rerunning, or did not rerun')
  },
  passScript: [
    turn(callTool('p1', 'read_file', { path: 'settings.json' })),
    turn(callTool('p2', 'edit_file', { path: 'settings.json', old_string: '"pageSize": 20,\n', new_string: '"pageSize": 20\n' })),
    turn(callTool('p3', 'run_shell', { command: COMMAND })),
    turn(say('settings.json had a trailing comma; removed it, and `node check.mjs` now passes.'))
  ],
  failScript: [turn(callTool('f1', 'run_shell', { command: COMMAND })), turn(say('It still fails.'))]
}
