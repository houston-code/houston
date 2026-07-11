import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { SKIP_DIRS } from './search'
import { withExeSuffix } from '../binaries'

/**
 * Structural (AST-aware) code search for the `ast_grep` tool, backed by the
 * ast-grep CLI. Unlike `search_files` (regex text search) this matches by syntax
 * tree shape, so it ignores formatting and supports meta-variables ($A, $$$ARGS).
 *
 * The packaged app bundles the binary (see src/main/binaries.ts); otherwise we
 * look on PATH. There is no pure-JS fallback — structural matching needs the
 * parser — so when no binary is found the tool returns a clear error.
 */

const MAX_LINE = 300
const AG_CANDIDATES = [
  '/opt/homebrew/bin/ast-grep',
  '/usr/local/bin/ast-grep',
  '/usr/bin/ast-grep',
  '/opt/homebrew/bin/sg'
]

export interface ResolveAgOptions {
  env?: NodeJS.ProcessEnv
  candidates?: string[]
  exists?: (p: string) => boolean
  /** Platform override (defaults to process.platform); injected in tests. */
  platform?: NodeJS.Platform
}

/** Locate an ast-grep binary (HOUSTON_AST_GREP override, then PATH, then common dirs), or null. */
export function resolveAstGrep(opts: ResolveAgOptions = {}): string | null {
  const env = opts.env ?? process.env
  const exists = opts.exists ?? existsSync
  const candidates = opts.candidates ?? AG_CANDIDATES
  const platform = opts.platform ?? process.platform
  const name = withExeSuffix('ast-grep', platform) // ast-grep.exe on Windows
  const pathDelim = platform === 'win32' ? ';' : ':' // not node:path delimiter (host-dependent)
  const override = env.HOUSTON_AST_GREP
  if (override && exists(override)) return override
  for (const dir of (env.PATH ?? '').split(pathDelim)) {
    if (dir && exists(join(dir, name))) return join(dir, name)
  }
  for (const c of candidates) if (exists(c)) return c
  return null
}

/** A single match from ast-grep's `--json=stream` output (the fields we use). */
interface AgMatch {
  file?: string
  text?: string
  lines?: string
  range?: { start?: { line?: number; column?: number } }
}

const clip = (s: string): string => (s.length > MAX_LINE ? s.slice(0, MAX_LINE) : s)

/**
 * Parse ast-grep's `--json=stream` output (one JSON object per line) into
 * "path:line:col: text" entries, keeping at most `max`. ast-grep reports 0-based
 * line/column, so we add 1 to match editor/grep conventions.
 *
 * Parsing line by line means a truncated trailing line (from the output cap in
 * runAstGrep) is simply skipped rather than poisoning the whole result — unlike
 * a single `--json=compact` array, where a cut-off tail makes the entire parse
 * fail and silently yields zero matches.
 */
export function parseAstGrepStream(stdout: string, max: number): string[] {
  const out: string[] = []
  for (const line of stdout.split('\n')) {
    if (out.length >= max) break
    const trimmed = line.trim()
    if (!trimmed) continue
    let m: AgMatch
    try {
      m = JSON.parse(trimmed) as AgMatch
    } catch {
      continue // incomplete/garbled line (e.g. a truncated tail) — skip it
    }
    const ln = (m.range?.start?.line ?? 0) + 1
    const col = (m.range?.start?.column ?? 0) + 1
    const text = (m.text ?? m.lines ?? '').split('\n')[0].trim()
    out.push(`${m.file ?? '?'}:${ln}:${col}: ${clip(text)}`)
  }
  return out
}

export interface AstGrepRunOptions {
  binPath: string
  pattern: string
  lang: string
  /** Workspace root; ast-grep runs with this as cwd so output paths are relative. */
  cwd: string
  /** Search root relative to the workspace (ast-grep argument). */
  searchRel: string
  max: number
  signal?: AbortSignal
}

/**
 * Strip ast-grep's benign postinstall notice from stderr. The `@ast-grep/cli`
 * npm shim prints these two lines when its postinstall step didn't run (e.g. a
 * sandboxed `npm ci` that skips install scripts): it falls back to resolving the
 * native binary at runtime and still works. That notice would otherwise be
 * mistaken for a failure on an empty search (which also exits non-zero), so drop
 * it — while leaving any real diagnostic (`error: …`, `ERROR: …`) intact.
 */
export function stripAstGrepNoise(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      if (!t) return false
      if (t.startsWith('[warn] postinstall script did not run')) return false
      if (t.startsWith('Enable postinstall to avoid')) return false
      return true
    })
    .join('\n')
    .trim()
}

/**
 * Decide whether an ast-grep run failed. It exits non-zero both for a clean "no
 * matches" (exit 1) and for real failures (bad lang/pattern, missing path), so
 * the exit code alone can't tell them apart — the discriminator is a real stderr
 * diagnostic. Any benign postinstall notice ({@link stripAstGrepNoise}) is
 * ignored. Returns the error message, or undefined when the run succeeded (with
 * or without matches).
 */
export function astGrepError(matches: string[], code: number | null, stderr: string): string | undefined {
  if (matches.length || code === 0) return undefined
  return stripAstGrepNoise(stderr) || undefined
}

/**
 * Run ast-grep and collect formatted matches. Resolves with an `error` (rather
 * than rejecting) when the pattern/lang is invalid so the caller can surface it.
 */
export function runAstGrep(o: AstGrepRunOptions): Promise<{ matches: string[]; error?: string }> {
  return new Promise((resolve) => {
    // --json=stream emits one JSON object per line (not one big array), so the
    // output cap below can drop a trailing line without corrupting the rest.
    // --no-ignore vcs matches search_files' scope — search everything except the
    // SKIP_DIRS globs below — rather than silently honoring the repo's .gitignore
    // (which would give the two search tools different file sets).
    const args = ['run', '--pattern', o.pattern, '--lang', o.lang, '--no-ignore', 'vcs', '--json=stream']
    for (const d of SKIP_DIRS) args.push('--globs', `!${d}`)
    args.push('--', o.searchRel || '.')

    let child
    try {
      child = spawn(o.binPath, args, { cwd: o.cwd, signal: o.signal })
    } catch (e) {
      resolve({ matches: [], error: (e as Error).message })
      return
    }
    let out = ''
    let err = ''
    child.stdout.on('data', (c: Buffer) => {
      if (out.length < 5_000_000) out += c.toString()
    })
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString()
    })
    child.on('error', (e) => resolve({ matches: [], error: e.message }))
    child.on('close', (code) => {
      const matches = parseAstGrepStream(out, o.max)
      // ast-grep exits non-zero both for "no matches" (exit 1) and for real
      // failures like a bad language or a missing path. astGrepError() tells them
      // apart via stderr (ignoring the shim's benign postinstall notice); a clean
      // no-match returns [] and is reported as "No matches found." by the caller.
      const error = astGrepError(matches, code, err)
      resolve(error ? { matches: [], error } : { matches })
    })
  })
}

export interface StructuralSearchOptions {
  pattern: string
  lang: string
  workspace: string
  searchRel: string
  /** Resolved ast-grep path, or null when no binary is available. */
  binPath: string | null
  max: number
  signal?: AbortSignal
}

/** Run a structural search and return a human/model-readable result string. */
export async function searchStructural(o: StructuralSearchOptions): Promise<string> {
  if (!o.pattern) throw new Error('pattern is required.')
  if (!o.lang) throw new Error('lang is required (e.g. "ts", "tsx", "py", "rust", "go").')
  if (!o.binPath) {
    throw new Error(
      'ast-grep is not available. The desktop app bundles it; on other setups (a source checkout or the standalone CLI) install it (e.g. `brew install ast-grep`) or set HOUSTON_AST_GREP to its path.'
    )
  }
  const { matches, error } = await runAstGrep({
    binPath: o.binPath,
    pattern: o.pattern,
    lang: o.lang,
    cwd: o.workspace,
    searchRel: o.searchRel,
    max: o.max,
    signal: o.signal
  })
  if (error) throw new Error(error)
  return matches.length ? matches.join('\n') : 'No matches found.'
}
