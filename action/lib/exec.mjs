// The one place the action starts a process: an argument array and no shell, so nothing
// in an event payload can become a command. Resolves (never rejects) with the exit code
// and the captured output.

import { spawn } from 'node:child_process'

/**
 * Run `cmd` with `args`. `input` is written to stdin; `onStdoutLine` sees each complete
 * stdout line as it arrives (for progress logging), and the full output is still returned.
 */
export function exec(cmd, args, { cwd, env, input, onStdoutLine } = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let pending = ''
    const child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      stdout += d
      if (!onStdoutLine) return
      pending += d
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) onStdoutLine(line)
    })
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (e) => resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` }))
    child.on('close', (code) => {
      if (onStdoutLine && pending) onStdoutLine(pending)
      resolve({ code: code ?? 1, stdout, stderr })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}
