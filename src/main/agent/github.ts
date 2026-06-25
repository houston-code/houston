import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, delimiter } from 'node:path'

/**
 * First-class GitHub integration via the `gh` CLI — the same path Claude Code
 * takes. Houston never stores a GitHub token: `gh` manages its own credentials
 * (`gh auth login`), and every GitHub tool is kind:'network', so it leaves the
 * machine only behind an approval prompt. All invocations use execFile with an
 * argument array (no shell, so no command injection) under a hardened,
 * non-interactive environment, so a crafted title/branch can't run a command.
 */

/** Common install locations probed when `gh` isn't on a stripped PATH (bash subshells). */
const GH_CANDIDATES = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']

export interface ResolveGhOptions {
  env?: NodeJS.ProcessEnv
  exists?: (p: string) => boolean
  candidates?: string[]
}

/**
 * Locate the `gh` binary on PATH (or a known install dir), or null if absent.
 * Mirrors {@link resolveRipgrep}: an explicit `HOUSTON_GH` override wins, then the
 * PATH, then a short list of standard install dirs (PATH is stripped in the
 * Electron-spawned environment, so the fallbacks matter).
 */
export function resolveGh(opts: ResolveGhOptions = {}): string | null {
  const env = opts.env ?? process.env
  const exists = opts.exists ?? existsSync
  const candidates = opts.candidates ?? GH_CANDIDATES
  const override = env.HOUSTON_GH
  if (override && exists(override)) return override
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && exists(join(dir, 'gh'))) return join(dir, 'gh')
  }
  for (const c of candidates) if (exists(c)) return c
  return null
}

/** Non-interactive, no-prompt, no-color environment so `gh` never blocks on a TTY. */
const GH_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_PAGER: 'cat',
  PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  CLICOLOR: '0',
  NO_COLOR: '1'
}

export interface GhResult {
  /** True when `gh` exited 0. */
  ok: boolean
  stdout: string
  stderr: string
  /** Exit code, or null when the process was killed or couldn't be spawned. */
  code: number | null
}

/** Run a `gh` subcommand in `cwd`. Injected into the tool context for testability. */
export type GhExec = (args: string[], cwd: string, signal?: AbortSignal) => Promise<GhResult>

const MAX_GH_BUFFER = 8_000_000
const GH_TIMEOUT_MS = 60_000

/**
 * Build a {@link GhExec} bound to a resolved `gh` path. Never rejects — a non-zero
 * exit, a timeout, or a spawn failure all come back as `ok:false` with stderr, so
 * the calling tool can surface a useful message instead of throwing.
 */
export function runGh(ghPath: string): GhExec {
  return (args, cwd, signal) =>
    new Promise<GhResult>((resolve) => {
      execFile(
        ghPath,
        args,
        {
          cwd,
          env: GH_ENV,
          timeout: GH_TIMEOUT_MS,
          maxBuffer: MAX_GH_BUFFER,
          windowsHide: true,
          signal
        },
        (err: (Error & { code?: number | string }) | null, stdout, stderr) => {
          // On a non-zero exit, execFile's error.code is the numeric exit status;
          // on a spawn failure (e.g. ENOENT) it's a string — normalize to a code.
          const code =
            err && typeof err.code === 'number' ? err.code : err ? null : 0
          resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '', code })
        }
      )
    })
}

/**
 * A short system-prompt line advertising the GitHub tools when `gh` is installed.
 * Pure filesystem probe — deliberately makes NO network/auth call, so the run
 * start never triggers unapproved egress (auth/repo state is discovered when the
 * agent actually invokes a gh_pr_* tool, behind its approval prompt). Returns ''
 * when `gh` isn't installed, so the section is simply omitted.
 */
export function githubContext(resolve: () => string | null = resolveGh): string {
  if (!resolve()) return ''
  return (
    'GitHub: the `gh` CLI is available. Use the gh_pr_* tools (gh_pr_create, ' +
    'gh_pr_list, gh_pr_view, gh_pr_comment, gh_pr_checkout) to work with pull ' +
    'requests instead of raw `gh` shell commands — each requires approval ' +
    '(network egress). gh_pr_create needs the branch pushed first (e.g. ' +
    '`git push -u origin <branch>` via run_shell). If a call reports you are not ' +
    'authenticated, tell the user to run `gh auth login`.'
  )
}
