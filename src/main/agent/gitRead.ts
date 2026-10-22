import { execFile } from 'node:child_process'

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

/**
 * The full hardening for a git command in `cwd`: {@link GIT_HARDENING} plus overrides
 * for the filter drivers the repo defines. Reading config runs no external program.
 * Outside a repo (or when git is missing) it is just the fixed flags. Rejects when the
 * repo defines a driver no override can name (see {@link localFilterOverrides}).
 */
export function hardenedGitArgs(cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...GIT_HARDENING, 'config', '--show-scope', '-z', '--get-regexp', '^filter\\.'],
      { cwd, env: GIT_ENV, timeout: 5_000, maxBuffer: 1_000_000, windowsHide: true },
      (_err, stdout) => {
        const overrides = localFilterOverrides(String(stdout ?? ''))
        if (overrides) resolve([...GIT_HARDENING, ...overrides])
        else reject(new Error('This repository defines a git filter driver Houston cannot switch off, so it will not run git here.'))
      }
    )
  })
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
      'git',
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
  stdout: string
  stderr: string
}

/**
 * Like {@link runReadGit} but returns stdout/stderr and the exit status
 * separately (a larger buffer for whole-working-tree diffs), so callers can tell
 * "no changes" from "command failed" — used by the Changes panel.
 */
export async function runGitCapture(args: string[], cwd: string): Promise<GitCapture> {
  let hardening: string[]
  try {
    hardening = await hardenedGitArgs(cwd)
  } catch (e) {
    return { ok: false, stdout: '', stderr: (e as Error).message }
  }
  return new Promise((resolve) => {
    execFile(
      'git',
      [...hardening, '--no-pager', ...args],
      { cwd, env: GIT_ENV, timeout: 15_000, maxBuffer: 16_000_000, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' })
      }
    )
  })
}

/** Runs a git subcommand, resolving its stdout, or null when it fails. */
export type GitTry = (args: string[]) => Promise<string | null>

/** A {@link GitTry} over {@link runGitCapture} in `cwd`. */
export function captureTry(cwd: string): GitTry {
  return async (args) => {
    const r = await runGitCapture(args, cwd)
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
