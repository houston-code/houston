import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { joinFor, pathDelimiter, withExeSuffix } from '../binaries'
import { captureTry, hardenedGitArgs, type GitTry } from './gitRead'

/**
 * First-class GitHub integration via the `gh` CLI. Houston never stores a GitHub
 * token: `gh` manages its own credentials
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
  /** Platform override (defaults to process.platform); injected in tests. */
  platform?: NodeJS.Platform
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
  const platform = opts.platform ?? process.platform
  const name = withExeSuffix('gh', platform) // gh.exe on Windows
  const pathDelim = pathDelimiter(platform)
  const joinP = joinFor(platform)
  const override = env.HOUSTON_GH
  if (override && exists(override)) return override
  for (const dir of (env.PATH ?? '').split(pathDelim)) {
    if (dir && exists(joinP(dir, name))) return joinP(dir, name)
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
 * Carry git `-c key=value` hardening in the environment (`GIT_CONFIG_COUNT`,
 * `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`), after any entries `base` already
 * has, so every git that `gh` starts (checkout, fetch, push) inherits it. Pure.
 */
export function gitConfigEnv(args: string[], base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  const start = Number(base.GIT_CONFIG_COUNT)
  let n = Number.isInteger(start) && start > 0 ? start : 0
  for (let i = 0; i + 1 < args.length; i += 2) {
    if (args[i] !== '-c') continue
    const eq = args[i + 1].indexOf('=')
    if (eq <= 0) continue
    env[`GIT_CONFIG_KEY_${n}`] = args[i + 1].slice(0, eq)
    env[`GIT_CONFIG_VALUE_${n}`] = args[i + 1].slice(eq + 1)
    n++
  }
  env.GIT_CONFIG_COUNT = String(n)
  return env
}

/**
 * Build a {@link GhExec} bound to a resolved `gh` path. Never rejects — a non-zero
 * exit, a timeout, or a spawn failure all come back as `ok:false` with stderr, so
 * the calling tool can surface a useful message instead of throwing.
 *
 * `gh` runs git in the workspace for some commands (`pr checkout`, `pr merge`'s local
 * branch cleanup), outside the sandbox, so that git gets the same hardening as
 * Houston's own (no repo-defined hooks, fsmonitor, or filter drivers); a repo whose
 * drivers can't be switched off gets no `gh` at all.
 */
export function runGh(ghPath: string): GhExec {
  return async (args, cwd, signal) => {
    let hardening: string[]
    try {
      hardening = await hardenedGitArgs(cwd)
    } catch (e) {
      return { ok: false, stdout: '', stderr: (e as Error).message, code: null }
    }
    return new Promise<GhResult>((resolve) => {
      execFile(
        ghPath,
        args,
        {
          cwd,
          env: gitConfigEnv(hardening, GH_ENV),
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
    'GitHub: the `gh` CLI is available. Prefer the dedicated gh_* tools over raw ' +
    '`gh` shell commands. Reads (lists, views, checks, runs) run without approval ' +
    'in full auto; the rest require approval (network egress): pull requests ' +
    '(gh_pr_create, gh_pr_list, gh_pr_view, gh_pr_comment, gh_pr_review, ' +
    'gh_pr_checkout, gh_pr_checks, gh_pr_merge, gh_pr_set_state to close/reopen ' +
    'or toggle draft), issues (gh_issue_list, gh_issue_view, gh_issue_create, ' +
    'gh_issue_comment, gh_issue_set_state to close/reopen), CI runs ' +
    '(gh_run_list, gh_run_view — use log_failed:true to ' +
    'read a failing run\'s logs), and gh_repo_create for a new repository. ' +
    'gh_pr_create needs the branch pushed first (e.g. `git push -u origin <branch>` ' +
    'via run_shell); gh_repo_create defaults to a private repo made from the ' +
    'current directory and pushed, so commit the project first. If a call reports ' +
    'you are not authenticated, tell the user to run `gh auth login`.'
  )
}

/**
 * The `<host>:<owner>/<repo>` a git remote URL points at (`git@github.com:o/r.git`,
 * `https://github.com/o/r`, `ssh://git@host/o/r.git`), lowercased, or null for a URL
 * that names no repository. Any credentials in the URL are dropped.
 */
export function remoteRepoSlug(url: string): string | null {
  const u = url.trim()
  let host: string
  let path: string
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(u)
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    host = scp[1]
    path = scp[2]
  } else {
    try {
      const parsed = new URL(u)
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return null
      host = parsed.hostname
      path = parsed.pathname
    } catch {
      return null
    }
  }
  const parts = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1] || !host) return null
  return `${host}:${parts[0]}/${parts[1]}`.toLowerCase()
}

/**
 * Which repository the `gh_*` tools act on in `cwd`, as the key their network grants
 * are scoped by (see networkDestination): `GH_REPO` when set (gh honors it first),
 * else every repository the checkout's remotes point at, sorted and comma-joined. All
 * of them, not the one gh would pick, so adding or repointing a remote mid-chat
 * changes the key and the next write asks again. Null outside a repository or with
 * no GitHub-shaped remote.
 */
export async function ghRepoKey(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  git: GitTry = captureTry(cwd)
): Promise<string | null> {
  const ghRepo = env.GH_REPO?.trim()
  if (ghRepo) {
    const parts = ghRepo.split('/')
    if (parts.length === 2) return `github.com:${ghRepo}`.toLowerCase()
    if (parts.length === 3) return `${parts[0]}:${parts[1]}/${parts[2]}`.toLowerCase()
  }
  const out = await git(['remote', '-v'])
  if (!out) return null
  const slugs = new Set<string>()
  for (const line of out.split(/\r?\n/)) {
    const url = line.split(/\s+/)[1]
    const slug = url ? remoteRepoSlug(url) : null
    if (slug) slugs.add(slug)
  }
  if (!slugs.size) return null
  const sorted = [...slugs].sort()
  // One host in practice; written once so the key reads `<host>:<a>,<b>`.
  const host = sorted[0].split(':')[0]
  return sorted.every((s) => s.startsWith(`${host}:`))
    ? `${host}:${sorted.map((s) => s.slice(host.length + 1)).join(',')}`
    : sorted.join(',')
}
