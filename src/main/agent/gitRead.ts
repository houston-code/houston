import { execFile } from 'node:child_process'
import { gitExecutable } from './gitBinary'

/**
 * Hardened, read-only git execution shared by the agent's git tools and the
 * renderer's Changes panel.
 *
 * Config keys that let a repo-local .git/config run arbitrary commands when git
 * reads or diffs files (diff.external, textconv, fsmonitor, ext-diff, the `ext`
 * protocol, hooks, signature verification) are neutralized, so inspecting an
 * UNTRUSTED repo can't execute code. These commands run in the main process, outside
 * the sandbox, and never prompt for approval, while `.git` sits inside the workspace a
 * sandboxed command may write: the hardening is the only thing standing between a
 * planted `.git/config` and code execution on the host.
 *
 * Filter drivers can't be switched off by a fixed flag, since a repo names its own
 * (`filter.<name>.clean`, run by `git status` and `git diff` on a modified file), so
 * {@link hardenedGitArgs} reads the repo's config first and blanks every driver it
 * defines locally (see {@link localFilterOverrides}).
 */
export const GIT_HARDENING = [
  '-c',
  'core.fsmonitor=',
  '-c',
  'diff.external=',
  '-c',
  'protocol.ext.allow=never',
  // No hooks: `worktree add` runs post-checkout, any ref update runs reference-transaction.
  '-c',
  'core.hooksPath=/dev/null',
  // `log.showSignature` makes log/show run `gpg.program` on a signed commit.
  '-c',
  'log.showSignature=false'
]

/** Config scopes the user controls; anything else (local, worktree) may be the repo's own. */
const TRUSTED_SCOPES = new Set(['global', 'system', 'command'])

/**
 * The `-c` overrides that blank every filter driver a repository defines in its own
 * config, from `git config --show-scope -z --get-regexp '^filter\.'` output (records of
 * `scope NUL key LF value NUL`). Drivers from the user's global config (git-lfs) keep
 * working; a driver the repo defines runs nothing. Null when a driver's name holds an
 * `=`: `-c` splits at the first one, so no override could name it, and the caller must
 * not run git at all. Pure.
 */
export function localFilterOverrides(output: string): string[] | null {
  const drivers = new Set<string>()
  const fields = output.split('\0')
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i].trim()
    const key = fields[i + 1].split('\n')[0]
    if (TRUSTED_SCOPES.has(scope)) continue
    const m = /^filter\.(.+)\.[^.]+$/i.exec(key)
    if (m) drivers.add(m[1])
  }
  const out: string[] = []
  for (const d of drivers) {
    if (d.includes('=')) return null
    for (const k of ['clean', 'smudge', 'process']) out.push('-c', `filter.${d}.${k}=`)
    out.push('-c', `filter.${d}.required=false`)
  }
  return out
}

/** One `git config` run: the error execFile gave (null on exit 0), and both streams. */
export interface ConfigProbe {
  err: (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null
  stdout: string
  stderr: string
}

/** Runs `git config <args>` in `cwd`. */
export type ConfigRunner = (args: string[], cwd: string) => Promise<ConfigProbe>

/** `git config <args>` with the fixed hardening and the probe's own small limits. */
const probeConfig: ConfigRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile(
      gitExecutable(GIT_ENV),
      [...GIT_HARDENING, 'config', ...args],
      { cwd, env: GIT_ENV, timeout: 5_000, maxBuffer: 1_000_000, windowsHide: true },
      (err, stdout, stderr) =>
        resolve({ err: err as ConfigProbe['err'], stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    )
  })

/** Whether git refused `--show-scope` as an unknown option: git older than 2.26. Pure. */
export function showScopeUnsupported(p: ConfigProbe): boolean {
  return !!p.err && p.err.code === 129 && /unknown option\W+show-scope/.test(p.stderr)
}

/**
 * `git config -z` records without a scope (`key LF value NUL`, or `key NUL` for a key
 * with no value) rewritten as `--show-scope -z` records (`scope NUL key LF value NUL`),
 * so one parser reads both. Pure.
 */
export function withScope(scope: string, output: string): string {
  return output
    .split('\0')
    .filter((record) => record !== '')
    .map((record) => `${scope}\0${record}\0`)
    .join('')
}

/** `git config --local` run outside any repository. */
const OUTSIDE_REPO = /only be used inside a git repository/

/**
 * The config entries `query` selects (`['--get-regexp', re]` or `['--list']`), as
 * `--show-scope -z` records. Git older than 2.26 has no `--show-scope`, so there the
 * repository's own files are listed by themselves instead: `--local --includes` (the
 * repository's config and every file it includes) and, when the repository turns on
 * per-worktree config, `--worktree --includes`, labelled `local` and `worktree`. That
 * leaves out the user's global and system config, which every caller trusts anyway,
 * so the result means the same on any git. Outside a repository there is no local
 * config, which reads as no entries. A failed or cut-off run is returned as it is,
 * for the caller to refuse.
 */
export async function scopedConfig(cwd: string, query: string[], run: ConfigRunner = probeConfig): Promise<ConfigProbe> {
  const scoped = await run(['--show-scope', '-z', ...query], cwd)
  if (!showScopeUnsupported(scoped)) return scoped
  const local = await run(['--local', '--includes', '-z', ...query], cwd)
  if (local.err?.code === 128 && OUTSIDE_REPO.test(local.stderr)) return { err: null, stdout: '', stderr: '' }
  if (filterProbeFailed(local.err, local.stdout)) return local
  const perWorktree = await run(['--local', '--bool', '--get', 'extensions.worktreeConfig'], cwd)
  if (filterProbeFailed(perWorktree.err, perWorktree.stdout)) return perWorktree
  let worktree = ''
  if (perWorktree.stdout.trim() === 'true') {
    const w = await run(['--worktree', '--includes', '-z', ...query], cwd)
    if (filterProbeFailed(w.err, w.stdout)) return w
    worktree = w.stdout
  }
  return { err: null, stdout: withScope('local', local.stdout) + withScope('worktree', worktree), stderr: '' }
}

/**
 * The full hardening for a git command in `cwd`: {@link GIT_HARDENING} plus overrides
 * for the filter drivers the repo defines. Reading config runs no external program.
 * Outside a repo (or when git is missing) it is just the fixed flags. Rejects when the
 * repo defines a driver no override can name (see {@link localFilterOverrides}), and
 * when the listing did not finish (cut off at the buffer or timed out): a partial
 * listing could leave out exactly the driver that runs. Works on git older than 2.26
 * too (see {@link scopedConfig}).
 */
export async function hardenedGitArgs(cwd: string, run: ConfigRunner = probeConfig): Promise<string[]> {
  const { err, stdout, stderr } = await scopedConfig(cwd, ['--get-regexp', '^filter\\.'], run)
  if (filterProbeFailed(err, stdout)) {
    // git's own fatal error (a broken `.git`, a config it can't parse) says more
    // than ours; anything else (cut off, timed out) gets ours.
    const fatal = err?.code === 128 ? /^fatal: .+$/m.exec(stderr)?.[0] : undefined
    throw new Error(fatal ?? "Houston could not read this repository's git config, so it will not run git here.")
  }
  const overrides = localFilterOverrides(stdout)
  if (overrides) return [...GIT_HARDENING, ...overrides]
  throw new Error('This repository defines a git filter driver Houston cannot switch off, so it will not run git here.')
}

/**
 * Whether the filter-driver probe failed in a way that leaves its listing incomplete.
 * Exit 0 is a full listing and exit 1 with no output is "no filter keys". A git that
 * could not be started at all (ENOENT: not installed, or the folder is gone) runs
 * nothing afterwards either, so it is not a failure here. Anything else (a kill by
 * the timeout, the output buffer overflowing, an unknown option on an old git, a
 * config git cannot parse) is. Pure.
 */
export function filterProbeFailed(err: (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null, stdout: string): boolean {
  if (!err) return false
  if (err.code === 'ENOENT') return false
  if (err.code === 1 && !err.killed && !err.signal && stdout === '') return false
  return true
}

export const GIT_ENV = {
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
export async function runReadGit(args: string[], cwd: string): Promise<string> {
  let hardening: string[]
  try {
    hardening = await hardenedGitArgs(cwd)
  } catch (e) {
    return `[git error: ${(e as Error).message}]`
  }
  return new Promise((resolve) => {
    execFile(
      gitExecutable(GIT_ENV),
      [...hardening, '--no-pager', ...args],
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
  /** git's exit code; null when it never ran or was killed (e.g. the timeout). */
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Like {@link runReadGit} but returns stdout/stderr and the exit status
 * separately (a larger buffer for whole-working-tree diffs), so callers can tell
 * "no changes" from "command failed" — used by the Changes panel.
 */
export async function runGitCapture(
  args: string[],
  cwd: string,
  /**
   * The hardening for `cwd`, already being worked out by the caller: several git
   * commands in one operation share one probe instead of each starting its own `git
   * config` process. Only for commands run moments apart, never across separate
   * operations (the repository's config can change in between).
   */
  hardening?: Promise<string[]>
): Promise<GitCapture> {
  let hardeningArgs: string[]
  try {
    hardeningArgs = await (hardening ?? hardenedGitArgs(cwd))
  } catch (e) {
    return { ok: false, code: null, stdout: '', stderr: (e as Error).message }
  }
  return new Promise((resolve) => {
    execFile(
      gitExecutable(GIT_ENV),
      [...hardeningArgs, '--no-pager', ...args],
      { cwd, env: GIT_ENV, timeout: 15_000, maxBuffer: 16_000_000, windowsHide: true },
      (err, stdout, stderr) => {
        const code = !err ? 0 : typeof err.code === 'number' ? err.code : null
        resolve({ ok: !err, code, stdout: stdout || '', stderr: stderr || '' })
      }
    )
  })
}

/** Runs a git subcommand, resolving its stdout, or null when it fails. */
export type GitTry = (args: string[]) => Promise<string | null>

/**
 * A {@link GitTry} over {@link runGitCapture} in `cwd`, every command sharing `hardening`
 * when given (the same rule applies: commands of one operation only).
 */
export function captureTry(cwd: string, hardening?: Promise<string[]>): GitTry {
  return async (args) => {
    const r = await runGitCapture(args, cwd, hardening)
    return r.ok ? r.stdout : null
  }
}

/** git's well-known empty tree, per object format; git resolves it without storing it. */
const EMPTY_TREE: Record<string, string> = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'
}

/**
 * The base to diff against for "everything uncommitted": `HEAD`, or the empty
 * tree when HEAD has no commit yet (a fresh `git init`). `git diff HEAD` fails
 * there, which silently dropped staged files: they are tracked, so the untracked
 * listing doesn't carry them either. Against the empty tree every tracked file
 * shows as added. Falls back to `HEAD` when the format can't be read.
 */
export async function uncommittedDiffBase(tryGit: GitTry): Promise<string> {
  if ((await tryGit(['rev-parse', '--verify', '-q', 'HEAD^{commit}'])) !== null) return 'HEAD'
  // --show-object-format needs git 2.25+; older git is SHA-1 only.
  const format = (await tryGit(['rev-parse', '--show-object-format']))?.trim() || 'sha1'
  return EMPTY_TREE[format] ?? 'HEAD'
}
