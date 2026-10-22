import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

/**
 * Run a `gh` subcommand in `cwd`, with `env` added to gh's environment (the `GH_REPO`
 * pin, see {@link ghRepoEnv}). Injected into the tool context for testability.
 */
export type GhExec = (
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv
) => Promise<GhResult>

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
  return async (args, cwd, signal, env) => {
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
          env: gitConfigEnv(hardening, { ...GH_ENV, ...env }),
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

/** A remote URL's host and path, and whether git reaches it over SSH; null for a local path. */
function parseRemoteUrl(url: string): { host: string; path: string; ssh: boolean } | null {
  const u = url.trim()
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(u)
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return { host: scp[1], path: scp[2], ssh: true }
  try {
    const parsed = new URL(u)
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return null
    return { host: parsed.hostname, path: parsed.pathname, ssh: parsed.protocol === 'ssh:' }
  } catch {
    return null
  }
}

/** gh's spelling of a host: lowercased, a leading `www.` dropped. */
function normalizeGhHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '')
}

/** `<host>:<owner>/<repo>`, lowercased, or null unless `path` is exactly `owner/repo`. */
function repoSlug(host: string, path: string): string | null {
  const parts = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/')
  if (parts.length !== 2 || !host || !parts.every((p) => /^[\w.-]+$/.test(p))) return null
  return `${normalizeGhHost(host)}:${parts[0]}/${parts[1]}`.toLowerCase()
}

/**
 * The `<host>:<owner>/<repo>` a git remote URL points at (`git@github.com:o/r.git`,
 * `https://github.com/o/r`, `ssh://git@host/o/r.git`), lowercased, or null for a URL
 * that names no repository. Any credentials in the URL are dropped.
 */
export function remoteRepoSlug(url: string): string | null {
  const parsed = parseRemoteUrl(url)
  return parsed ? repoSlug(parsed.host, parsed.path) : null
}

/**
 * A repository named the way `GH_REPO` or a `gh-resolved` value names one (`owner/repo`,
 * `host/owner/repo`, or a URL) as `<host>:<owner>/<repo>`, with `host` for a value that
 * names none. Null when it names no repository (gh refuses such a value too).
 */
function fullNameSlug(value: string, host: string): string | null {
  const v = value.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /^[^@/\s]+@/.test(v)) return remoteRepoSlug(v)
  const parts = v.split('/')
  if (parts.some((p) => !p)) return null
  if (parts.length === 2) return repoSlug(host, v)
  if (parts.length === 3) return repoSlug(parts[0], `${parts[1]}/${parts[2]}`)
  return null
}

/** gh's remote preference: `upstream`, then `github`, then `origin`, then the rest. */
function remoteScore(name: string): number {
  const n = name.toLowerCase()
  return n === 'upstream' ? 3 : n === 'github' ? 2 : n === 'origin' ? 1 : 0
}

/** gh's config directory (where `hosts.yml` lives), the way gh finds it. */
function ghConfigDir(env: NodeJS.ProcessEnv): string {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'gh')
  if (process.platform === 'win32' && env.AppData) return join(env.AppData, 'GitHub CLI')
  return join(homedir(), '.config', 'gh')
}

/**
 * The hosts gh is signed in to: the top-level keys of its `hosts.yml`. Only the keys are
 * read, never a token under them. Empty when the file is missing or unreadable.
 */
export async function ghAuthedHosts(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  let text: string
  try {
    text = await readFile(join(ghConfigDir(env), 'hosts.yml'), 'utf8')
  } catch {
    return []
  }
  const hosts: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^(["']?)([A-Za-z0-9][A-Za-z0-9.-]*)\1:\s*$/.exec(line)
    if (m) hosts.push(normalizeGhHost(m[2]))
  }
  return hosts
}

/**
 * The host an SSH host alias stands for (`ssh -G <alias>`'s `hostname`), the way gh
 * translates `git@work-github:o/r` before it reads the repository. `ssh -G` prints the
 * resolved config and connects to nothing. The alias itself when it can't be resolved.
 */
export function sshHostname(alias: string): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias)) return Promise.resolve(alias)
  return new Promise((resolve) => {
    execFile('ssh', ['-G', alias], { timeout: 5_000, windowsHide: true }, (err, stdout) => {
      const m = err ? null : /^hostname\s+(\S+)\s*$/m.exec(stdout ?? '')
      const host = m ? m[1].toLowerCase() : alias
      resolve(host === 'ssh.github.com' ? 'github.com' : host)
    })
  })
}

export interface GhRepoKeyOptions {
  env?: NodeJS.ProcessEnv
  git?: GitTry
  /** The hosts gh is signed in to (see {@link ghAuthedHosts}); injected in tests. */
  authedHosts?: () => Promise<string[]>
  /** SSH alias translation (see {@link sshHostname}); injected in tests. */
  sshHost?: (alias: string) => Promise<string>
}

/**
 * The repository the `gh_*` tools act on in `cwd`, as `<host>:<owner>/<repo>`: the key
 * their network grants are scoped by (see networkDestination), and the repository every
 * gh call is then pinned to (see {@link ghRepoEnv}), so gh can only act on the repository
 * the user approved. Null outside a repository or with no GitHub remote.
 *
 * It is the repository gh itself would pick, by gh's own rules: `GH_REPO` when set; else
 * the checkout's remotes on hosts gh is signed in to, `upstream` before `github` before
 * `origin` before the rest, where the first one with a `remote.<name>.gh-resolved` value
 * (`gh repo set-default`) decides (`base` names that remote's repository, anything else
 * names `owner/repo` on that remote's host), and otherwise the first remote wins. A
 * `gh-resolved` value or remote changed mid-chat therefore changes the key, and the next
 * write asks again; and because gh is told the repository outright, a change made after
 * the prompt can't redirect the approved call.
 */
export async function ghRepoKey(cwd: string, opts: GhRepoKeyOptions = {}): Promise<string | null> {
  const env = opts.env ?? process.env
  const git = opts.git ?? captureTry(cwd)
  const ghHost = env.GH_HOST?.trim() ? normalizeGhHost(env.GH_HOST.trim()) : ''
  const ghRepo = env.GH_REPO?.trim()
  if (ghRepo) return fullNameSlug(ghRepo, ghHost || 'github.com')

  const out = await git(['remote', '-v'])
  if (!out) return null
  const authed = await (opts.authedHosts ?? (() => ghAuthedHosts(env)))()
  const known = new Set(['github.com', ...authed, ...(ghHost ? [ghHost] : [])])
  const translate = opts.sshHost ?? sshHostname

  // Each remote's repository, from its fetch URL, else its push URL (gh's order).
  const remotes: { name: string; host: string; slug: string; resolved?: string }[] = []
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\S+)\s+(\S+)\s+\((?:fetch|push)\)$/.exec(line.trim())
    if (!m || remotes.some((r) => r.name === m[1])) continue
    const parsed = parseRemoteUrl(m[2])
    if (!parsed) continue
    let host = normalizeGhHost(parsed.host)
    if (parsed.ssh && !known.has(host)) host = normalizeGhHost(await translate(host))
    const slug = repoSlug(host, parsed.path)
    if (slug) remotes.push({ name: m[1], host, slug })
  }

  // gh files each value under the second dot-separated part of its key, last one winning.
  const resolvedOut = await git(['config', '--get-regexp', '^remote\\..*\\.gh-resolved$'])
  for (const line of (resolvedOut ?? '').split(/\r?\n/)) {
    const sp = line.indexOf(' ')
    if (sp < 0) continue
    const name = line.slice(0, sp).split('.')[1]
    const remote = remotes.find((r) => r.name === name)
    if (remote) remote.resolved = line.slice(sp + 1).trim()
  }

  // Only remotes on hosts gh is signed in to; GH_HOST, or a single signed-in host,
  // narrows them to that host (GH_HOST even when nothing is left, as gh does).
  let candidates = remotes.filter((r) => known.has(r.host))
  const defaultHost = ghHost || (authed.length === 1 ? authed[0] : '')
  if (defaultHost) {
    const onDefault = candidates.filter((r) => r.host === defaultHost)
    if (ghHost || onDefault.length) candidates = onDefault
  }
  candidates.sort((a, b) => remoteScore(b.name) - remoteScore(a.name))

  const decided = candidates.find((r) => r.resolved)
  if (decided) {
    if (decided.resolved === 'base') return decided.slug
    const named = fullNameSlug(decided.resolved!, decided.host)
    return named && `${decided.host}:${named.slice(named.indexOf(':') + 1)}`
  }
  return candidates[0]?.slug ?? null
}

/**
 * The environment entry that pins a gh call to the repository `key` (from
 * {@link ghRepoKey}) names: `GH_REPO=<host>/<owner>/<repo>`, which gh honors over every
 * remote and `gh-resolved` value.
 */
export function ghRepoEnv(key: string): { GH_REPO: string } {
  const colon = key.indexOf(':')
  return { GH_REPO: `${key.slice(0, colon)}/${key.slice(colon + 1)}` }
}
