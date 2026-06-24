import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { SKIP_DIRS } from './search'

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
}

/** Locate an ast-grep binary (HOUSTON_AST_GREP override, then PATH, then common dirs), or null. */
export function resolveAstGrep(opts: ResolveAgOptions = {}): string | null {
  const env = opts.env ?? process.env
  const exists = opts.exists ?? existsSync
  const candidates = opts.candidates ?? AG_CANDIDATES
  const override = env.HOUSTON_AST_GREP
  if (override && exists(override)) return override
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && exists(join(dir, 'ast-grep'))) return join(dir, 'ast-grep')
  }
  for (const c of candidates) if (exists(c)) return c
  return null
}

/** A single match from ast-grep's `--json=compact` output (fields we use). */
interface AgMatch {
  file?: string
  text?: string
  lines?: string
  range?: { start?: { line?: number; column?: number } }
}

const clip = (s: string): string => (s.length > MAX_LINE ? s.slice(0, MAX_LINE) : s)

/**
 * Format ast-grep's compact-JSON output into "path:line:col: text" entries.
 * ast-grep reports 0-based line/column, so we add 1 to match editor/grep
 * conventions. Returns [] on unparseable input.
 */
export function formatAstGrepMatches(json: string, max: number): string[] {
  if (!json.trim()) return []
  let parsed: AgMatch[]
  try {
    parsed = JSON.parse(json) as AgMatch[]
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: string[] = []
  for (const m of parsed) {
    if (out.length >= max) break
    const line = (m.range?.start?.line ?? 0) + 1
    const col = (m.range?.start?.column ?? 0) + 1
    const text = (m.text ?? m.lines ?? '').split('\n')[0].trim()
    out.push(`${m.file ?? '?'}:${line}:${col}: ${clip(text)}`)
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
 * Run ast-grep and collect formatted matches. Resolves with an `error` (rather
 * than rejecting) when the pattern/lang is invalid so the caller can surface it.
 */
export function runAstGrep(o: AstGrepRunOptions): Promise<{ matches: string[]; error?: string }> {
  return new Promise((resolve) => {
    const args = ['run', '--pattern', o.pattern, '--lang', o.lang, '--json=compact']
    // Exclude build/dependency dirs even in repos without a .gitignore (ast-grep
    // respects .gitignore by default; --globs is belt-and-suspenders).
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
      // ast-grep exits 0 with `[]` when there are no matches; a non-zero exit
      // with no JSON output means a bad pattern/language or other error.
      if (code !== 0 && !out.trim()) {
        resolve({ matches: [], error: err.trim() || `ast-grep exited with code ${code}` })
        return
      }
      resolve({ matches: formatAstGrepMatches(out, o.max) })
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
      'ast-grep is not available. The packaged app bundles it; in development install it (e.g. `brew install ast-grep`) or set HOUSTON_AST_GREP to its path.'
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
