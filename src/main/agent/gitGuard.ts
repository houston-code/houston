import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, readdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AgentQuestion } from '@shared/agent'
import { GIT_ENV, runGitCapture } from './gitRead'

/**
 * Catches a sandboxed command planting code in a repository's `.git` that would later
 * run OUTSIDE the sandbox.
 *
 * The OS sandbox makes each workspace root writable, `.git` included, and that is what
 * keeps ordinary git (commit, `push -u`, `git config`, hook installers, submodules)
 * working inside it. The catch: a few things in `.git` are commands git runs on its own.
 * A hook, `core.fsmonitor`, a filter driver, or a `commondir` file pointing git at
 * another config, written by a confined command, runs as the user the next time THEIR
 * terminal (or a shell prompt that calls `git status` on every `cd`) touches the repo.
 * None of it shows in `git status` or a diff.
 *
 * So rather than block writes, the guard compares the exec-capable parts of each root's
 * repository before and after agent shell commands and reports what changed: hooks in
 * the hooks directory, exec-capable keys in the repo's own config files, the `commondir`
 * redirect, the `.git` pointer file, and the same for every nested repository the index
 * records as a submodule (the root's `git status` recurses into those and runs their
 * fsmonitor). Settings that run nothing (`user.*`, remotes, upstreams) never count.
 *
 * Cheap by construction: a snapshot is a few `stat`s and small file reads; git itself
 * runs only to parse config bytes this process hasn't parsed before (`git config
 * --file -`, which runs nothing; see {@link parsedConfigs}) or to list submodule entries
 * when the index changed. Nothing here executes repository-controlled code: every git
 * call is either `--file` parsing outside any repository or goes through the hardened
 * runner (see gitRead.ts).
 */

/** Hook files larger than this are fingerprinted by metadata and can't be restored by undo. */
const MAX_KEPT_HOOK_BYTES = 256 * 1024
/** Files read from one hooks directory. */
const MAX_HOOK_FILES = 256
/** Nested repositories (submodule entries) inspected per root. */
const MAX_NESTED_REPOS = 64
/** `git config` parses running at once, across every guard in the process. */
const MAX_PARALLEL_PARSES = 8
/** Linked worktrees' files read at once by one snapshot. */
const MAX_PARALLEL_READS = 16
/** Config files whose parse {@link parsedConfigs} keeps; the least recently used go first. */
const MAX_PARSED_CONFIGS = 4096

/** Config keys whose value is, or leads git to, a command it runs on its own. Lowercase. */
const EXEC_KEY_PATTERNS: RegExp[] = [
  /^core\.(fsmonitor|hookspath|sshcommand|pager|editor|askpass|gitproxy|alternaterefscommand)$/,
  /^sequence\.editor$/,
  /^diff\.external$/,
  /^diff\..+\.(textconv|command)$/,
  /^merge\..+\.driver$/,
  /^filter\..+\.(clean|smudge|process)$/,
  /^(difftool|mergetool)\..+\.(cmd|path)$/,
  /^gpg\.(.+\.)?program$/,
  /^gpg\.ssh\.defaultkeycommand$/,
  /^credential\.(.+\.)?helper$/,
  /^alias\./,
  /^include\.path$/,
  /^includeif\..+\.path$/,
  /^pager\./,
  /^interactive\.difffilter$/,
  /^remote\..+\.(uploadpack|receivepack)$/,
  /^protocol\.(.+\.)?allow$/,
  /^submodule\..+\.update$/,
  /^trailer\..+\.(command|cmd)$/,
  /^sendemail\./,
  /^web\.browser$/,
  /^(browser|man)\..+\.(cmd|path)$/,
  /^uploadpack\.packobjectshook$/
]

/** `core.fsmonitor` set to a boolean selects git's built-in daemon, which runs nothing from the repo. */
const GIT_BOOLEAN = /^(true|false|yes|no|on|off|1|0|)$/i

/**
 * `core.hooksPath` values written by hook installers that point at a folder the user
 * can see and that is checked in (husky v4–v8 `.husky`, v9 `.husky/_`, whose shims run
 * the tracked `.husky/<hook>` scripts). Reported as a note, never a pause.
 */
const KNOWN_HOOKS_PATHS = new Set(['.husky', '.husky/_'])

/** Whether a repo-local config entry can make git run a command. Pure. */
export function isExecConfigEntry(key: string, value: string): boolean {
  const k = key.toLowerCase()
  if (k === 'core.fsmonitor' && GIT_BOOLEAN.test(value.trim())) return false
  // Only a `!command` update mode runs anything; checkout/rebase/merge/none don't.
  if (/^submodule\..+\.update$/.test(k)) return value.trim().startsWith('!')
  return EXEC_KEY_PATTERNS.some((re) => re.test(k))
}

/** Whether a `core.hooksPath` value is a known installer's visible, checked-in folder. Pure. */
export function isKnownHooksPath(value: string): boolean {
  const v = value.trim().replace(/^\.\//, '').replace(/\/+$/, '')
  return KNOWN_HOOKS_PATHS.has(v)
}

/** Parse `git config -z --list` output (records `key LF value NUL`) into entries. Pure. */
export function parseConfigList(output: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const rec of output.split('\0')) {
    if (!rec) continue
    const nl = rec.indexOf('\n')
    // A key with no `=` in the file (`[core] bare`) has no value line: git reads it as true.
    out.push(nl < 0 ? [rec, ''] : [rec.slice(0, nl), rec.slice(nl + 1)])
  }
  return out
}

/** Where git looks for an included config file (`~/` is home; relative is next to the file). */
function includeTarget(value: string, fromDir: string): string {
  const v = value.trim()
  if (v.startsWith('~/')) return join(homedir(), v.slice(2))
  return isAbsolute(v) ? v : resolve(fromDir, v)
}

/** One hook file as found on disk. */
interface HookSnap {
  hash: string
  mode: number
  /** The bytes, kept for undo when small enough. */
  content?: Buffer
}

/** One config file: its raw text (null when absent) and its exec-capable entries. */
interface ConfigSnap {
  text: string | null
  /** Exec-capable entries, key (lowercase section/name) → values in file order. */
  exec: Map<string, string[]>
}

/** The exec-capable state of one repository (a root, or a nested submodule checkout). */
export interface RepoSnap {
  /** The working-tree directory whose `.git` this describes. */
  dir: string
  /** `.git` as found: a directory, a pointer file (with its text), or nothing. */
  dotGit: { kind: 'dir' } | { kind: 'file'; text: string } | { kind: 'none' }
  gitDir?: string
  commonDir?: string
  /**
   * `commondir` files by absolute path (null when absent): this repo's own and every
   * linked worktree's under `<commonDir>/worktrees/`. One redirects git to another
   * directory's config and hooks.
   */
  commondirs: Map<string, string | null>
  /**
   * Where each present `commondir` sends git, resolved the way git does (symlinks
   * followed), or null when it names nothing that exists.
   */
  commondirTargets?: Map<string, string | null>
  /** {@link commonDir} with symlinks resolved. */
  commonDirReal?: string
  /**
   * Config files by absolute path: `<commonDir>/config`, each `config.worktree`, and
   * one level of files they include.
   */
  configs: Map<string, ConfigSnap>
  /** The hooks directory and its non-sample files by name. */
  hooksDir?: string
  hooks: Map<string, HookSnap>
  /** Submodule entries the index records (path → object id); roots only. */
  gitlinks?: Map<string, string>
}

/** What changed, in a form the user can read and Houston can undo. */
export type GitChange =
  | {
      kind: 'config'
      repo: string
      file: string
      key: string
      before: string[]
      after: string[]
      /** A known installer's setting (husky's hooksPath): noted, not paused on. */
      known: boolean
      /** The whole file as it was (null when absent), for a file that is now a symlink. */
      beforeText?: string | null
    }
  | { kind: 'hook'; repo: string; file: string; before?: HookSnap; after: HookSnap }
  | { kind: 'commondir'; repo: string; file: string; before: string | null; after: string }
  | { kind: 'dotgit'; repo: string; file: string; before: RepoSnap['dotGit']; after: RepoSnap['dotGit'] }

/** Injectable seams, real implementations by default. */
export interface GitGuardDeps {
  /** Parse `bytes`, read from config file `file`, into all its entries; null when git can't. */
  readConfigEntries?: (file: string, bytes: Buffer) => Promise<Array<[string, string]> | null>
  /** Submodule entries (path → object id) in the index of the repo at `dir`. */
  listGitlinks?: (dir: string) => Promise<Map<string, string>>
}

async function readText(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8')
  } catch {
    return null
  }
}

/**
 * The directory a `commondir` file's text sends git to, as git resolves it: trailing
 * line endings dropped, a relative path taken from the file's own directory, and
 * symlinks followed component by component (so `<link>/../..` lands where git lands,
 * not where a lexical join would). Null when that names nothing.
 */
async function commondirTarget(file: string, text: string): Promise<string | null> {
  const t = text.replace(/[\r\n]+$/, '')
  if (!t) return null
  try {
    return await realpath(isAbsolute(t) ? t : `${dirname(file)}${sep}${t}`)
  } catch {
    return null
  }
}

/**
 * `git config --no-includes --file - -z --list` fed `bytes` on stdin: parses exactly the
 * bytes the caller read and hashed (never the file again, which may have changed since),
 * follows no includes, runs nothing. `--no-includes` is spelled out because, unlike a
 * named file, stdin otherwise follows them.
 */
export function defaultReadConfigEntries(_file: string, bytes: Buffer): Promise<Array<[string, string]> | null> {
  return new Promise((done) => {
    const child = execFile(
      'git',
      ['config', '--no-includes', '--file', '-', '-z', '--list'],
      // Outside any repository, so git does no discovery and reads no repo config.
      { cwd: tmpdir(), env: GIT_ENV, timeout: 5_000, maxBuffer: 4_000_000, windowsHide: true },
      (err, stdout) => done(err ? null : parseConfigList(String(stdout)))
    )
    // git can exit (a parse error) before reading it all; the exit status already says so.
    child.stdin?.on('error', () => {})
    child.stdin?.end(bytes)
  })
}

/** Runs `fn`s with at most `n` in flight; the rest wait their turn. */
function limiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: Array<() => void> = []
  return async (fn) => {
    if (active < n) active++
    // A finishing call hands its slot straight to the next waiter.
    else await new Promise<void>((r) => waiting.push(r))
    try {
      return await fn()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

/** Every config parse in the process takes a slot here, so concurrent guards share the bound. */
const parseSlot = limiter(MAX_PARALLEL_PARSES)

/** `fn` over `items` with at most `n` in flight, results in input order. */
async function mapLimit<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

type ReadConfigEntries = NonNullable<GitGuardDeps['readConfigEntries']>
type ExecEntries = Map<string, string[]>
/** One file's parse: the SHA-256 of the bytes parsed, and their exec-capable entries. */
interface ParsedConfig {
  digest: string
  exec: Promise<ExecEntries | null>
}

/**
 * Config parses kept for every guard in the process (each run, each chat), per parser
 * and then per file path, so a new run's baseline doesn't spawn git again for each of a
 * repository's (possibly hundreds of) `config.worktree` files. Exact: an entry is used
 * only for the very bytes it was parsed from (by SHA-256), git parsed those same bytes
 * (on stdin), and with includes off its output depends on nothing else. A failed parse
 * (which may have been a timeout) is dropped so the next snapshot tries again. Treat the
 * entry maps as read-only: they are shared.
 */
const parsedConfigs = new WeakMap<ReadConfigEntries, Map<string, ParsedConfig>>()

/** The exec-capable entries of config `file` holding `bytes`; null when git can't parse it. */
function execEntries(read: ReadConfigEntries, file: string, bytes: Buffer): Promise<ExecEntries | null> {
  let cache = parsedConfigs.get(read)
  if (!cache) parsedConfigs.set(read, (cache = new Map()))
  const digest = createHash('sha256').update(bytes).digest('hex')
  const hit = cache.get(file)
  // Re-inserted on every use, so iteration order runs least to most recently used.
  cache.delete(file)
  if (hit && hit.digest === digest) {
    cache.set(file, hit)
    return hit.exec
  }
  const exec = parseSlot(() => read(file, bytes)).then((entries) => {
    // A file git can't parse makes git itself refuse to run, so it runs nothing either.
    if (!entries) return null
    const out: ExecEntries = new Map()
    for (const [key, value] of entries) {
      if (isExecConfigEntry(key, value)) out.set(key, [...(out.get(key) ?? []), value])
    }
    return out
  })
  const entry: ParsedConfig = { digest, exec }
  cache.set(file, entry)
  while (cache.size > MAX_PARSED_CONFIGS) cache.delete(cache.keys().next().value!)
  const forget = (): void => {
    if (cache.get(file) === entry) cache.delete(file)
  }
  exec.then((r) => r === null && forget(), forget)
  return exec
}

/** Submodule entries via the hardened runner (`ls-files -s`, mode 160000). */
async function defaultListGitlinks(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const r = await runGitCapture(['ls-files', '-s', '-z'], dir)
  if (!r.ok) return out
  for (const rec of r.stdout.split('\0')) {
    // `<mode> <oid> <stage>\t<path>`
    const m = /^160000 ([0-9a-f]+) \d+\t(.+)$/s.exec(rec)
    if (m) out.set(m[2]!, m[1]!)
  }
  return out
}

/** Resolve where a working tree's git data lives from its `.git` entry. */
async function locateGitDir(dir: string): Promise<{ dotGit: RepoSnap['dotGit']; gitDir?: string }> {
  const dotGit = join(dir, '.git')
  let st
  try {
    st = await stat(dotGit)
  } catch {
    return { dotGit: { kind: 'none' } }
  }
  if (st.isDirectory()) return { dotGit: { kind: 'dir' }, gitDir: dotGit }
  const text = (await readText(dotGit)) ?? ''
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text)
  if (!m) return { dotGit: { kind: 'file', text } }
  const target = m[1]!
  return { dotGit: { kind: 'file', text }, gitDir: isAbsolute(target) ? target : resolve(dir, target) }
}

/**
 * What one snapshot has read, by kind and path. Checkouts sharing a common dir (a linked
 * worktree root and its main checkout) then scan its linked worktrees, config files, and
 * hooks once per snapshot, not once each.
 */
type Reads = Map<string, Promise<unknown>>

/** `fn()`, or what it already gave under `key` in this snapshot. */
function once<T>(reads: Reads, key: string, fn: () => Promise<T>): Promise<T> {
  let p = reads.get(key) as Promise<T> | undefined
  if (!p) reads.set(key, (p = fn()))
  return p
}

/**
 * Per-guard snapshot builder. Config parses come from the process-wide
 * {@link parsedConfigs}, and a small cache (index stat → gitlinks) is kept here, so a
 * snapshot of an unchanged repository spawns nothing.
 */
class Snapshotter {
  private gitlinkCache = new Map<string, { key: string; links: Map<string, string> }>()
  private readEntries: ReadConfigEntries
  private listGitlinks: NonNullable<GitGuardDeps['listGitlinks']>

  constructor(deps: GitGuardDeps) {
    this.readEntries = deps.readConfigEntries ?? defaultReadConfigEntries
    this.listGitlinks = deps.listGitlinks ?? defaultListGitlinks
  }

  private async config(file: string): Promise<ConfigSnap> {
    let bytes: Buffer
    try {
      bytes = await readFile(file)
    } catch {
      return { text: null, exec: new Map() }
    }
    const exec = await execEntries(this.readEntries, file, bytes)
    return { text: bytes.toString('utf8'), exec: exec ?? new Map() }
  }

  private async hooks(hooksDir: string): Promise<Map<string, HookSnap>> {
    const out = new Map<string, HookSnap>()
    let names: string[]
    try {
      names = await readdir(hooksDir)
    } catch {
      return out
    }
    for (const name of names.sort().slice(0, MAX_HOOK_FILES)) {
      if (name.endsWith('.sample')) continue
      const p = join(hooksDir, name)
      try {
        const st = await stat(p)
        if (!st.isFile()) continue
        const mode = st.mode & 0o7777
        // A large file is fingerprinted by its metadata, never read whole.
        if (st.size > MAX_KEPT_HOOK_BYTES) {
          out.set(name, { hash: `stat:${st.size}:${st.mtimeMs}:${st.ino}`, mode })
          continue
        }
        const buf = await readFile(p)
        out.set(name, { hash: createHash('sha256').update(buf).digest('hex'), mode, content: buf })
      } catch {
        // Vanished mid-read: the next snapshot sees it.
      }
    }
    return out
  }

  private async gitlinks(dir: string, gitDir: string): Promise<Map<string, string>> {
    let key = 'none'
    try {
      const st = await stat(join(gitDir, 'index'))
      key = `${st.ino}:${st.size}:${st.mtimeMs}`
    } catch {
      // No index yet: no entries.
    }
    const cached = this.gitlinkCache.get(gitDir)
    if (cached && cached.key === key) return cached.links
    const links = key === 'none' ? new Map<string, string>() : await this.listGitlinks(dir)
    this.gitlinkCache.set(gitDir, { key, links })
    return links
  }

  /** Snapshot the repository at `dir`, reusing what this snapshot already read (`reads`). */
  async repo(dir: string, withGitlinks: boolean, reads: Reads): Promise<RepoSnap> {
    const text = (file: string): Promise<string | null> => once(reads, `text\0${file}`, () => readText(file))
    const config = (file: string): Promise<ConfigSnap> => once(reads, `config\0${file}`, () => this.config(file))
    const { dotGit, gitDir } = await locateGitDir(dir)
    const snap: RepoSnap = { dir, dotGit, commondirs: new Map(), configs: new Map(), hooks: new Map() }
    if (!gitDir) return snap
    snap.gitDir = gitDir
    const own = await text(join(gitDir, 'commondir'))
    snap.commondirs.set(join(gitDir, 'commondir'), own)
    const commonDir = own !== null && own.trim() ? resolve(gitDir, own.trim()) : gitDir
    snap.commonDir = commonDir
    snap.commonDirReal = await realpath(commonDir).catch(() => undefined)
    const configFiles = [join(commonDir, 'config'), join(gitDir, 'config.worktree')]
    // Every linked worktree's own git dir sits in the common dir, as writable as it is.
    const linked = await once(reads, `worktrees\0${commonDir}`, async () => {
      try {
        return (await readdir(join(commonDir, 'worktrees'))).sort()
      } catch {
        return [] // No linked worktrees.
      }
    })
    const wts = linked.map((name) => join(commonDir, 'worktrees', name))
    const cds = await mapLimit(wts, MAX_PARALLEL_READS, (wt) => text(join(wt, 'commondir')))
    for (const [i, wt] of wts.entries()) {
      const cd = join(wt, 'commondir')
      if (!snap.commondirs.has(cd)) snap.commondirs.set(cd, cds[i] ?? null)
      if (!configFiles.includes(join(wt, 'config.worktree'))) configFiles.push(join(wt, 'config.worktree'))
    }
    const present = [...snap.commondirs].filter((e): e is [string, string] => e[1] !== null)
    const targets = await mapLimit(present, MAX_PARALLEL_READS, ([file, t]) =>
      once(reads, `target\0${file}\0${t}`, () => commondirTarget(file, t))
    )
    snap.commondirTargets = new Map(present.map(([file], i) => [file, targets[i] ?? null]))
    const cfgs = await mapLimit(configFiles, MAX_PARALLEL_READS, config)
    for (const [i, f] of configFiles.entries()) {
      const cfg = cfgs[i]!
      snap.configs.set(f, cfg)
      // One level of `include.path` / `includeIf.*.path`: git reads those files as config too.
      for (const [key, values] of cfg.exec) {
        if (!/^include(if\..+)?\.path$/i.test(key)) continue
        for (const v of values) {
          const target = includeTarget(v, dirname(f))
          if (!snap.configs.has(target)) snap.configs.set(target, await config(target))
        }
      }
    }
    const hooksDir = join(commonDir, 'hooks')
    snap.hooksDir = hooksDir
    snap.hooks = await once(reads, `hooks\0${hooksDir}`, () => this.hooks(hooksDir))
    if (withGitlinks) snap.gitlinks = await this.gitlinks(dir, gitDir)
    return snap
  }
}

/** A full snapshot: each root's repository plus its submodule checkouts. */
export type GuardSnapshot = Map<string, RepoSnap>

function sameValues(a: string[] = [], b: string[] = []): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** The exec-capable differences between two snapshots of one repository. Pure. */
export function diffRepo(before: RepoSnap | undefined, after: RepoSnap): GitChange[] {
  const changes: GitChange[] = []
  const repo = after.dir
  const bDot = before?.dotGit ?? { kind: 'none' as const }
  const pointer = (d: RepoSnap['dotGit']): string => (d.kind === 'file' ? d.text : d.kind)
  // A replaced or repointed `.git` (only meaningful when there was one before).
  if (before && bDot.kind !== 'none' && pointer(bDot) !== pointer(after.dotGit)) {
    changes.push({ kind: 'dotgit', repo, file: join(repo, '.git'), before: bDot, after: after.dotGit })
  }
  // A new or changed `commondir`. A linked worktree's own is expected; only a change counts.
  // One that sends git to the common dir this repository already had is no redirect: it is
  // what `git worktree add` writes for a new sibling worktree (another chat, the user's
  // terminal), and undoing it would break that worktree.
  for (const [file, text] of after.commondirs) {
    const prev = before?.commondirs.get(file) ?? null
    if (text === null || text === prev) continue
    const target = after.commondirTargets?.get(file)
    if (before?.commonDirReal && target && target === before.commonDirReal) continue
    changes.push({ kind: 'commondir', repo, file, before: prev, after: text })
  }
  for (const [file, cfg] of after.configs) {
    const prevCfg = before?.configs.get(file)
    const prev = prevCfg?.exec ?? new Map<string, string[]>()
    for (const [key, values] of cfg.exec) {
      if (sameValues(prev.get(key), values)) continue
      const known = key.toLowerCase() === 'core.hookspath' && values.length === 1 && isKnownHooksPath(values[0]!)
      changes.push({
        kind: 'config',
        repo,
        file,
        key,
        before: prev.get(key) ?? [],
        after: values,
        known,
        beforeText: prevCfg?.text ?? null
      })
    }
  }
  // Hooks: a new or changed file. A deleted hook runs nothing, so it isn't reported.
  const prevHooks = before && before.hooksDir === after.hooksDir ? before.hooks : new Map<string, HookSnap>()
  for (const [name, hook] of after.hooks) {
    const prev = prevHooks.get(name)
    if (prev && prev.hash === hook.hash && prev.mode === hook.mode) continue
    changes.push({ kind: 'hook', repo, file: join(after.hooksDir!, name), ...(prev ? { before: prev } : {}), after: hook })
  }
  return changes
}

/** Display path relative to the workspace when inside it, with `/` separators on every platform. */
function shown(p: string, workspace: string): string {
  const rel = relative(workspace, p)
  return (rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : p).replace(/\\/g, '/')
}

function clip(s: string, max = 120): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** One line describing a change, for the question and the tool result. Pure. */
export function describeChange(c: GitChange, workspace: string): string {
  const f = shown(c.file, workspace)
  switch (c.kind) {
    case 'config':
      return c.after.length === 0
        ? `${f}: removed ${c.key}`
        : `${f}: ${c.key} set to "${clip(c.after.join(', '))}"${c.before.length ? ` (was "${clip(c.before.join(', '))}")` : ''}`
    case 'hook': {
      const first = c.after.content ? clip(c.after.content.toString('utf8').split('\n').slice(0, 3).join(' | '), 100) : ''
      return `${c.before ? 'changed' : 'new'} hook ${f}${first ? `: ${first}` : ''}`
    }
    case 'commondir':
      return `${f} now points git at "${clip(c.after)}"`
    case 'dotgit':
      return `${f} was replaced or repointed`
  }
}

/** A shell command that removes a change by hand. Pure. */
export function manualUndo(c: GitChange): string {
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  switch (c.kind) {
    case 'config':
      return c.before.length === 0
        ? `git config --file ${q(c.file)} --unset-all ${q(c.key)}`
        : `git config --file ${q(c.file)} --replace-all ${q(c.key)} ${q(c.before[0]!)}`
    case 'hook':
      return c.before ? `restore ${q(c.file)} from a clean copy of the repository` : `rm ${q(c.file)}`
    case 'commondir':
      return c.before === null ? `rm ${q(c.file)}` : `printf %s ${q(c.before)} > ${q(c.file)}`
    case 'dotgit':
      return c.before.kind === 'file' ? `printf %s ${q(c.before.text)} > ${q(c.file)}` : `inspect ${q(c.file)} by hand`
  }
}

/** Run `git config --file` (outside any repository; runs nothing). Resolves to success. */
function gitConfigFile(args: string[]): Promise<boolean> {
  return new Promise((done) => {
    execFile('git', ['config', ...args], { cwd: tmpdir(), env: GIT_ENV, timeout: 5_000, windowsHide: true }, (err) =>
      // Exit 5 from --unset-all means the key was already gone.
      done(!err || (err as { code?: number }).code === 5)
    )
  })
}

/** Whether `p` is a symbolic link (false when it doesn't exist). */
async function isSymlink(p: string): Promise<boolean> {
  return (await lstat(p).catch(() => null))?.isSymbolicLink() === true
}

/**
 * Replace `file` with `content` (or remove it, for null) as a fresh regular file. The
 * old entry is unlinked first, so a symlink planted in its place is removed rather than
 * written through to whatever it points at.
 */
async function replaceFile(file: string, content: string | Buffer | null, mode?: number): Promise<void> {
  await unlink(file).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e
  })
  if (content === null) return
  await writeFile(file, content, { flag: 'wx' })
  if (mode !== undefined) await chmod(file, mode)
}

/**
 * Put one change back: the key's previous values, the hook's previous bytes (or no
 * hook), the previous `commondir` / `.git` pointer (or none). Only the reported item
 * is touched, so unrelated changes the same command made (an upstream from
 * `push -u`, a new remote) survive. Never writes through a symlink. Resolves false
 * when it could not be undone.
 */
export async function undoChange(c: GitChange): Promise<boolean> {
  try {
    switch (c.kind) {
      case 'config': {
        // git writes config through a symlink, so a config file swapped for one (say, to
        // the user's global config) is put back whole instead of edited in place.
        if (await isSymlink(c.file)) {
          if (c.beforeText === undefined) return false
          await replaceFile(c.file, c.beforeText)
          return true
        }
        if (!(await gitConfigFile(['--file', c.file, '--unset-all', c.key]))) return false
        for (const v of c.before) if (!(await gitConfigFile(['--file', c.file, '--add', c.key, v]))) return false
        return true
      }
      case 'hook': {
        if (!c.before) {
          await unlink(c.file)
          return true
        }
        if (!c.before.content) return false
        await replaceFile(c.file, c.before.content, c.before.mode)
        return true
      }
      case 'commondir': {
        await replaceFile(c.file, c.before)
        return true
      }
      case 'dotgit': {
        if (c.before.kind !== 'file') return false
        // Only a pointer file can be put back; never replace a directory.
        const st = await lstat(c.file).catch(() => null)
        if (st && st.isDirectory()) return false
        await replaceFile(c.file, c.before.text)
        return true
      }
    }
  } catch {
    return false
  }
}

/** Whether `p` (resolved through its parent directory) lies under one of `dirs`. */
async function within(p: string, dirs: string[]): Promise<boolean> {
  let parent: string
  try {
    parent = await realpath(dirname(p))
  } catch {
    return false
  }
  const real = join(parent, basename(p))
  return dirs.some((d) => {
    const rel = relative(d, real)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
}

/** The per-run guard: a baseline, refreshed after each check the user has answered. */
export class GitGuard {
  private snap: Snapshotter
  private baseline: GuardSnapshot | undefined
  /**
   * Where an undo may write: the roots and the git dirs they had at the first baseline
   * (a linked worktree's common dir lives outside its root). Fixed then, so a command
   * that later repoints a `.git` file or plants a submodule entry aimed at another of
   * the user's repositories can't steer Houston's own undo into editing it.
   */
  private undoDirs: string[] | undefined

  constructor(
    private roots: string[],
    deps: GitGuardDeps = {}
  ) {
    this.snap = new Snapshotter(deps)
  }

  /** Snapshot every root's repository and its submodule checkouts. */
  async snapshot(): Promise<GuardSnapshot> {
    const out: GuardSnapshot = new Map()
    // One snapshot reads each file once, however many of its repositories share it.
    const reads: Reads = new Map()
    for (const root of this.roots) {
      const tops = [root]
      const top = await this.snap.repo(root, true, reads)
      out.set(root, top)
      // A linked worktree's common dir is writable too (see gitDirs.ts), and with it the
      // main checkout's index: its submodule entries count as well.
      if (top.commonDir && top.commonDir !== top.gitDir && basename(top.commonDir) === '.git') {
        const main = dirname(top.commonDir)
        if (!out.has(main)) {
          out.set(main, await this.snap.repo(main, true, reads))
          tops.push(main)
        }
      }
      for (const t of tops) {
        let n = 0
        for (const path of out.get(t)!.gitlinks?.keys() ?? []) {
          if (n++ >= MAX_NESTED_REPOS) break
          const dir = resolve(t, path)
          // Never follow an entry out of its checkout (a crafted index path).
          const rel = relative(t, dir)
          if (!rel || rel.startsWith('..') || isAbsolute(rel) || out.has(dir)) continue
          out.set(dir, await this.snap.repo(dir, false, reads))
        }
      }
    }
    return out
  }

  /** Take the baseline if this run hasn't yet (call before a command runs). */
  async ensureBaseline(): Promise<void> {
    if (this.baseline) return
    this.baseline = await this.snapshot()
    const dirs = new Set<string>()
    for (const root of this.roots) {
      const top = this.baseline.get(root)
      for (const d of [root, top?.gitDir, top?.commonDir]) {
        if (!d) continue
        try {
          dirs.add(await realpath(d))
        } catch {
          // Gone already: nothing to write there.
        }
      }
    }
    this.undoDirs = [...dirs]
  }

  /**
   * Compare the repositories now against the baseline. Returns the changes and the
   * snapshot they were computed from; call {@link accept} with it once handled.
   */
  async check(): Promise<{ changes: GitChange[]; current: GuardSnapshot }> {
    const current = await this.snapshot()
    const before = this.baseline ?? current
    const changes: GitChange[] = []
    // A nested repo first seen now has no baseline: everything exec-capable in it is new.
    const seen = new Set<string>()
    for (const [dir, after] of current) {
      for (const c of diffRepo(before.get(dir), after)) {
        // Already shown to the user by another chat's guard, and kept there: this run's
        // command didn't make it, and asking again could undo what they chose to keep.
        if (keptElsewhere.has(changeFingerprint(c))) continue
        // Two checkouts sharing a common dir report its files once.
        const id = `${c.kind}\0${c.file}\0${c.kind === 'config' ? c.key : ''}`
        if (seen.has(id)) continue
        seen.add(id)
        changes.push(c)
      }
    }
    return { changes, current }
  }

  /** Make `current` the new baseline (the user kept the changes, or they were noted). */
  accept(current: GuardSnapshot): void {
    this.baseline = current
  }

  /** Undo `changes`, then re-baseline. Returns the ones that could not be undone. */
  async undo(changes: GitChange[]): Promise<GitChange[]> {
    const failed: GitChange[] = []
    for (const c of changes) {
      // Outside the roots and their git dirs, leave it to the user (see undoDirs).
      const ok = (await within(c.file, this.undoDirs ?? [])) && (await undoChange(c))
      if (!ok) failed.push(c)
    }
    this.baseline = await this.snapshot()
    return failed
  }
}

/**
 * Changes the user chose to keep when a guard asked about them, by
 * {@link changeFingerprint}, shared by every run in this process. Each run compares
 * against its own baseline, so a change one chat's command made (and the user kept)
 * also shows up in every other chat working in the same repository, on that chat's
 * next command, as if that command had made it. Answering "Undo" there would remove
 * what the user just kept. Only kept changes are shared: one still waiting for an
 * answer, or one the asking run never resolved (an aborted run), is still flagged by
 * every guard that sees it.
 */
const keptElsewhere = new Set<string>()
/** Entries kept in {@link keptElsewhere}; the oldest go first past this. */
const MAX_KEPT_ELSEWHERE = 512

/**
 * Identifies one change by where it is and what it now is, so another guard seeing the
 * same file in the same state recognizes it. A different value in the same file is a
 * different change and is flagged again. Pure.
 */
export function changeFingerprint(c: GitChange): string {
  switch (c.kind) {
    case 'config':
      return `config\0${c.file}\0${c.key}\0${JSON.stringify(c.after)}`
    case 'hook':
      return `hook\0${c.file}\0${c.after.hash}\0${c.after.mode}`
    case 'commondir':
      return `commondir\0${c.file}\0${c.after}`
    case 'dotgit':
      return `dotgit\0${c.file}\0${c.after.kind === 'file' ? c.after.text : c.after.kind}`
  }
}

/** Record changes the user kept, so other runs' guards don't ask about them again. */
export function rememberKept(changes: GitChange[]): void {
  for (const c of changes) {
    const id = changeFingerprint(c)
    keptElsewhere.delete(id)
    keptElsewhere.add(id)
  }
  while (keptElsewhere.size > MAX_KEPT_ELSEWHERE) keptElsewhere.delete(keptElsewhere.values().next().value!)
}

/** Forget every kept change (tests). */
export function resetKeptElsewhere(): void {
  keptElsewhere.clear()
}

/** The two answers offered when a command changed something exec-capable. */
export const GIT_GUARD_UNDO = 'Undo these changes'
export const GIT_GUARD_KEEP = 'Keep them'

/** The question shown to the user. Pure. */
export function gitGuardQuestion(changes: GitChange[], workspace: string): AgentQuestion {
  const lines = changes.map((c) => `- ${describeChange(c, workspace)}`)
  return {
    question:
      'The last command changed git settings that can run programs outside the sandbox the next time ' +
      'you use git in this project. None of this shows in git status or a diff.\n' +
      `${lines.join('\n')}\n` +
      'If you didn\'t expect this, undo it. Undo puts back only these items.',
    options: [
      { label: GIT_GUARD_UNDO, description: 'Restore the previous values and remove what was added.' },
      { label: GIT_GUARD_KEEP, description: 'Leave them, for example a git hook tool you meant to install.' }
    ]
  }
}

/** Whether the user's answer keeps the changes. Anything else, a typed reply included, undoes. */
export function answerKeeps(answer: string): boolean {
  return /^\s*keep\b/i.test(answer)
}

/**
 * After an agent shell command: compare against the baseline, ask about exec-capable
 * changes (or undo them when nobody can be asked), and return a note for the tool
 * result, empty when nothing relevant changed. A known installer's setting (husky's
 * hooksPath) is noted without asking.
 */
export async function reviewGitChanges(
  guard: GitGuard,
  opts: { workspace: string; ask?: (q: AgentQuestion) => Promise<string> }
): Promise<string> {
  const { changes, current } = await guard.check()
  if (changes.length === 0) {
    guard.accept(current)
    return ''
  }
  const notes = changes.filter((c) => c.kind === 'config' && c.known)
  const flagged = changes.filter((c) => !(c.kind === 'config' && c.known))
  const out: string[] = []
  if (notes.length) {
    out.push(`[git: ${notes.map((c) => describeChange(c, opts.workspace)).join('; ')} (a known hook installer's setting).]`)
  }
  if (flagged.length === 0) {
    guard.accept(current)
    return out.join('\n')
  }
  const listed = flagged.map((c) => describeChange(c, opts.workspace)).join('; ')
  let keep = false
  if (opts.ask) keep = answerKeeps(await opts.ask(gitGuardQuestion(flagged, opts.workspace)))
  if (keep) {
    guard.accept(current)
    rememberKept(flagged)
    const manual = flagged.map((c) => manualUndo(c)).join('; ')
    out.push(
      `[git: this command changed settings that run programs outside the sandbox (${listed}). ` +
        `The user chose to keep them. To remove them later: ${manual}]`
    )
    return out.join('\n')
  }
  const failed = await guard.undo(flagged)
  const why = opts.ask ? 'The user chose to undo them' : 'Nobody was available to approve them, so Houston undid them'
  out.push(
    `[git: this command changed settings that run programs outside the sandbox (${listed}). ${why}.` +
      (failed.length
        ? ` These could not be undone automatically: ${failed.map((c) => `${describeChange(c, opts.workspace)} (${manualUndo(c)})`).join('; ')}.`
        : '') +
      ' If a hook or setting is needed, ask the user to set it up themselves.]'
  )
  return out.join('\n')
}
