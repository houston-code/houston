import { shellExitCode } from '@shared/runtimes'
import { shellMayEdit } from '../../shellEdits'
import { callTool, say, turn, type AgentCall, type ProbeHost, type ProbeTask } from '../types'
import { fail, pass, seed, shellCommand, writeFiles } from './kit'

/** run_shell answers a failed command with its output and exit code, not an error. */
function commandFailed(output: string | undefined): boolean {
  const code = shellExitCode(output ?? '')
  return code !== null && code !== 0
}

/**
 * What only changes how a command's result is shown, at its end: a stream redirection
 * (`2>&1`, to /dev/null), a pipe into a pager or `head`/`tail`, and an `echo` after it
 * (`; echo $?`, `|| echo failed`). Each is stripped in turn until none is left.
 */
const SHOWN_ONLY = [
  /\s*(\d|&)?>>?\s*\/dev\/null$/,
  /\s*\d?>&\d$/,
  /\s*\|&?\s*(cat|head|tail|less|more)(\s+[\w=+-]+)*$/,
  /\s*(;|&&|\|\|)\s*echo\b[^;&|]*$/
]

/**
 * The program and arguments a shell command runs, so `node check.mjs 2>&1` and
 * `node check.mjs; echo $?` are the same run of `node check.mjs`.
 */
export function commandRun(command: string): string {
  let run = command
  for (let before = ''; before !== run; ) {
    before = run
    for (const shown of SHOWN_ONLY) run = run.replace(shown, '')
  }
  return run.trim()
}

/**
 * A call that may have changed what a failing command sees: a write, a tool from an MCP
 * server, or a command that may write (the loop's own reading, shellMayEdit). A command
 * that only reads, like `cat settings.json`, changes nothing.
 */
function mayChange(call: AgentCall): boolean {
  if (!call.ran || call.ok === false) return false
  if (call.kind === 'write' || call.kind === 'mcp') return true
  if (call.kind !== 'shell') return false
  const command = shellCommand(call)
  return command === undefined || shellMayEdit(command)
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

/** run_shell's result for the failing check on `host`. */
function failed(host: ProbeHost): string {
  const lines = ['check failed: settings.json is not valid JSON', '[exit code: 1]']
  return [...lines, ...(host.unsandboxedShellNote ? [host.unsandboxedShellNote] : [])].join('\n')
}

/**
 * A command has failed twice the same way. Running it a third time with nothing
 * changed can't give a different answer: the agent should look at why it fails. A
 * rerun after a fix (an edit, or another command) is the fix loop, and fine.
 */
export const probe: ProbeTask = {
  id: 'repeated-failure',
  title: 'A command failed twice the same way: no third run with nothing changed',
  messages: (host) => [
    seed.user(`\`${COMMAND}\` fails in this project. Get it passing.`),
    seed.calls(first),
    seed.result(first, failed(host)),
    seed.calls(second),
    seed.result(second, failed(host))
  ],
  maxActions: 3,
  setup: (ws) => writeFiles(ws, FILES),
  grade(run) {
    // The commands that failed with nothing changed since. The seed ends on COMMAND's.
    const failing = new Set([commandRun(COMMAND)])
    for (const call of run.calls) {
      const command = shellCommand(call)
      if (command !== undefined && failing.has(commandRun(command))) {
        return fail(`ran \`${command}\` again with nothing changed since it last failed`)
      }
      // A write, or a command that may write, may have changed what the failing ones see.
      if (mayChange(call)) failing.clear()
      if (command !== undefined && call.ran && commandFailed(call.output)) failing.add(commandRun(command))
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
