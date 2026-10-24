import { callTool, say, turn, type EvalTask } from '../../types'

/**
 * From a real Houston chat whose user asked "the file has a space in it, can you check
 * that's handled?" after a shelled-out file picker failed. The exporter builds one
 * shell command string, so a space splits an argument, `&` backgrounds half the
 * command, and a crafted name runs as a command. Quoting the arguments only half
 * works: double quotes still expand `$HOME` and run backticks, and single quotes break
 * on an apostrophe. The visible test has only the names from the report (spaces); the
 * holdout has the "other punctuation" the prompt mentions and a name crafted to run a
 * command, so quoting the reported case passes everything the agent can see and still
 * fails the grade. The fix that holds is an argument vector with no shell at all.
 */
export const task: EvalTask = {
  id: 'file-names-with-spaces',
  title: 'Export documents whatever their file names contain',
  prompt:
    "PDF export fails for some of our clients' documents, apparently the ones with spaces or other punctuation in their names; plain names export fine. `node test.mjs` reproduces it. Fix it. test.mjs is the spec, so do not change it.",
  verify: { cmd: 'node', args: ['test.mjs'] },
  // The other punctuation the prompt mentions, including a name that would run as a command.
  holdout: { cmd: 'node', args: ['hidden.test.mjs'] },
  script: [
    turn(callTool('c1', 'run_shell', { command: 'node test.mjs' })),
    turn(callTool('c2', 'read_file', { path: 'lib/render.mjs' }), callTool('c3', 'read_file', { path: 'lib/run.mjs' })),
    turn(
      callTool('c4', 'write_file', {
        path: 'lib/run.mjs',
        content: [
          "import { execFileSync } from 'node:child_process'",
          '',
          '/**',
          ' * Run a program with an argument vector, returning its stdout. No shell is involved,',
          ' * so an argument reaches the program exactly as given: spaces, quotes, `$`, `;` and',
          ' * backticks included. Throws with stderr on a non-zero exit.',
          ' */',
          'export function run(file, args) {',
          "  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })",
          '}',
          ''
        ].join('\n')
      })
    ),
    turn(
      callTool('c5', 'edit_file', {
        path: 'lib/render.mjs',
        old_string:
          '  let command = `"${NODE}" "${RENDERER}" --in ${input} --out ${output}`\n  if (title) command += ` --title ${title}`\n  run(command)',
        new_string:
          "  const args = [RENDERER, '--in', input, '--out', output]\n  if (title) args.push('--title', title)\n  run(NODE, args)"
      })
    ),
    turn(callTool('c6', 'run_shell', { command: 'node test.mjs' })),
    turn(
      say(
        "The renderer was invoked through one shell command string, so a space split the path, `&` and `;` ended the command, and `$HOME` or backticks in a name were expanded. `run()` now takes an argument vector and uses `execFileSync` with no shell, which also means a file name can no longer run as a command. `node test.mjs` prints ok."
      )
    )
  ]
}
