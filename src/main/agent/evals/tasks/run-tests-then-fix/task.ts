import { callTool, say, turn, type EvalTask } from '../../types'

/**
 * The shell path: run the failing test, fix, re-run. Covers the seam most likely
 * to hang rather than fail — `run_shell` needs its approval resolved even under
 * `full-auto`, because an unsandboxed shell always asks for consent.
 */
export const task: EvalTask = {
  id: 'run-tests-then-fix',
  title: 'Run the failing test, then fix parsePort()',
  prompt:
    "Run `node test.mjs` to see how it fails, then fix the source and re-run it to confirm it passes. Treat test.mjs as the spec: it defines the expected behaviour, so do not change it.",
  verify: { cmd: 'node', args: ['test.mjs'] },
  script: [
    turn(callTool('c1', 'run_shell', { command: 'node test.mjs' })),
    turn(
      callTool('c2', 'edit_file', {
        path: 'port.mjs',
        old_string: '  return raw ?? 8080',
        new_string: '  return raw === undefined || raw === null ? 8080 : Number(raw)'
      })
    ),
    turn(callTool('c3', 'run_shell', { command: 'node test.mjs' })),
    turn(say('`parsePort()` now coerces to a number, and the test passes.'))
  ]
}
