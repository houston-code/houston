import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Commands run in the user's own shell: the composer's `!` escape, and the
 * `` !`command` `` context a custom command's template asks for.
 *
 * Unsandboxed on purpose. The sandbox exists to confine the AGENT, which can be
 * steered by a prompt injection into running something the user never wanted. A
 * command the user typed at their own prompt is not that: it is exactly as
 * trusted as the shell they launched Houston from, and confining it would only
 * break the obvious cases (`!git push` with no network, `!npm i` unable to write
 * outside the workspace). A command template's shell context gets the same
 * standing only once the user has said yes to it (or it is their own command, or
 * the folder is trusted); see commandContext.ts.
 *
 * `shell: true` is intended here: the string IS a shell command, typed by (or
 * shown to and approved by) the person the shell belongs to. Their $SHELL is used
 * so familiar syntax works.
 */
function spawnUserShell(workspace: string, command: string, detached: boolean): ChildProcess {
  return spawn(command, {
    cwd: workspace,
    shell: process.platform === 'win32' ? true : (process.env.SHELL ?? '/bin/sh'),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so a timeout can stop everything the command started.
    ...(detached && process.platform !== 'win32' ? { detached: true } : {})
  })
}

/** Run a `!` escape, streaming its output so a build looks alive rather than hung. */
export function runUserShell(
  workspace: string,
  command: string,
  onOutput: (chunk: string) => void
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawnUserShell(workspace, command, false)
    // Decode as streams, so a multibyte character split across two pipe chunks
    // prints as itself rather than as two replacement characters.
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => onOutput(d))
    child.stderr?.on('data', (d: string) => onOutput(d))
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 0))
  })
}

/** What a captured command printed and how it ended. */
export interface ShellCapture {
  exitCode: number
  stdout: string
  stderr: string
  /** Stopped at the time limit. */
  timedOut: boolean
  /** Printed more than the cap; `stdout` holds the start of it. */
  truncated: boolean
}

/**
 * Run a command and collect its output, bounded in time and size: a command that
 * hangs is stopped (its whole process group) at `timeoutMs`, and output past
 * `maxBytes` is dropped rather than held.
 */
export function captureUserShell(
  workspace: string,
  command: string,
  opts: { timeoutMs: number; maxBytes: number }
): Promise<ShellCapture> {
  return new Promise((resolve, reject) => {
    const child = spawnUserShell(workspace, command, true)
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    const stop = (): void => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        // cmd.exe has no process groups: stop the whole tree it started, not just the shell.
        else if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => child.kill('SIGKILL'))
        else child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, opts.timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      if (stdout.length >= opts.maxBytes) {
        truncated = true
        return
      }
      stdout += d
      if (stdout.length > opts.maxBytes) {
        stdout = stdout.slice(0, opts.maxBytes)
        truncated = true
      }
    })
    child.stderr?.on('data', (d: string) => {
      // Only the end of stderr is kept: that is where an error says what went wrong.
      stderr = (stderr + d).slice(-4000)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? (timedOut ? 124 : 1), stdout, stderr, timedOut, truncated })
    })
  })
}
