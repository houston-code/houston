import { execFile } from 'node:child_process'

/**
 * Hardened, read-only git execution shared by the agent's git tools and the
 * renderer's Changes panel.
 *
 * Config keys that let a repo-local .git/config run arbitrary commands when git
 * reads or diffs files (diff.external, textconv, fsmonitor, ext-diff, the `ext`
 * protocol) are neutralized, so inspecting an UNTRUSTED repo can't execute code.
 * These commands are read-only and never prompt for approval, so the hardening is
 * the only thing standing between an untrusted checkout and code execution.
 */
const GIT_HARDENING = [
  '-c',
  'core.fsmonitor=',
  '-c',
  'diff.external=',
  '-c',
  'protocol.ext.allow=never'
]

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_EXTERNAL_DIFF: '',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0'
}

/**
 * Run a read-only git subcommand with execFile (an argument array — NO shell, so
 * no injection) and config-driven execution neutralized. Returns combined
 * stdout+stderr, or a `[git error: …]` sentinel when the command fails with no
 * output. Used by the agent tools, which surface the text to the model verbatim.
 */
export function runReadGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...GIT_HARDENING, '--no-pager', ...args],
      { cwd, env: GIT_ENV, timeout: 10_000, maxBuffer: 4_000_000, windowsHide: true },
      (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr || ''}`.trim()
        if (err && !out) resolve(`[git error: ${(err as Error).message}]`)
        else resolve(out || '[no output]')
      }
    )
  })
}

/** Structured result of a captured git run (no sentinel collapsing). */
export interface GitCapture {
  /** True when git exited 0. */
  ok: boolean
  stdout: string
  stderr: string
}

/**
 * Like {@link runReadGit} but returns stdout/stderr and the exit status
 * separately (a larger buffer for whole-working-tree diffs), so callers can tell
 * "no changes" from "command failed" — used by the Changes panel.
 */
export function runGitCapture(args: string[], cwd: string): Promise<GitCapture> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...GIT_HARDENING, '--no-pager', ...args],
      { cwd, env: GIT_ENV, timeout: 15_000, maxBuffer: 16_000_000, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' })
      }
    )
  })
}
