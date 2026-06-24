import { spawn } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import { join, relative, delimiter } from 'node:path'
import { minimatch } from 'minimatch'

/**
 * Content search for the `search_files` tool. Uses ripgrep when a binary can be
 * located (fast, skips binaries) and falls back to a pure-JS recursive walk
 * otherwise, so the tool works in any environment with no bundled binary.
 *
 * Both paths support the same options: case-insensitive matching, a file glob
 * filter, context lines, and a files-with-matches output mode.
 */

export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  'vendor',
  '.venv'
])

const MAX_LINE = 300
const RG_CANDIDATES = ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg', '/bin/rg']

export interface ResolveRgOptions {
  env?: NodeJS.ProcessEnv
  candidates?: string[]
  exists?: (p: string) => boolean
}

/** Locate a ripgrep binary (HOUSTON_RG override, then PATH, then common dirs), or null. */
export function resolveRipgrep(opts: ResolveRgOptions = {}): string | null {
  const env = opts.env ?? process.env
  const exists = opts.exists ?? existsSync
  const candidates = opts.candidates ?? RG_CANDIDATES
  const override = env.HOUSTON_RG
  if (override && exists(override)) return override
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && exists(join(dir, 'rg'))) return join(dir, 'rg')
  }
  for (const c of candidates) if (exists(c)) return c
  return null
}

const clip = (line: string): string => (line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line)

/** Match-shaping options shared by the ripgrep and JS-fallback paths. */
export interface MatchOptions {
  ignoreCase?: boolean
  /** Glob filter on file paths (e.g. "*.ts"). */
  glob?: string
  /** Lines of context to show before and after each match (ripgrep -C). */
  context?: number
  /** Output matching file paths only, not the matching lines. */
  filesWithMatches?: boolean
}

/**
 * Run ripgrep and collect up to `max` output lines. Resolves with an `error`
 * (rather than rejecting) when the pattern is invalid so the caller can surface
 * it. Paths are relative to `cwd`.
 */
export function runRipgrep(
  rgPath: string,
  pattern: string,
  cwd: string,
  searchRel: string,
  max: number,
  signal?: AbortSignal,
  opts: MatchOptions = {}
): Promise<{ matches: string[]; error?: string }> {
  return new Promise((resolve) => {
    const args = [
      '--no-heading',
      '--color=never',
      '--no-messages',
      '--no-ignore', // match the JS walk: search everything except the dirs below
      ...[...SKIP_DIRS].map((d) => `--glob=!${d}`)
    ]
    if (opts.ignoreCase) args.push('-i')
    if (opts.glob) args.push(`--glob=${opts.glob}`)
    if (opts.filesWithMatches) {
      args.push('--files-with-matches')
    } else {
      args.push('--line-number')
      if (opts.context && opts.context > 0) args.push('-C', String(opts.context))
    }
    args.push('-e', pattern, '--', searchRel || '.')

    let child
    try {
      child = spawn(rgPath, args, { cwd, signal })
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
      // rg exit codes: 0 = matches, 1 = no matches, 2 = error (e.g. bad regex).
      if (code === 2) {
        resolve({ matches: [], error: err.trim() || 'ripgrep error' })
        return
      }
      resolve({ matches: out.split('\n').filter(Boolean).map(clip).slice(0, max) })
    })
  })
}

/** Pure-JS recursive content search used when ripgrep is unavailable. */
async function jsWalk(
  dir: string,
  workspace: string,
  regex: RegExp,
  out: string[],
  max: number,
  opts: MatchOptions
): Promise<void> {
  if (out.length >= max) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= max) return
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await jsWalk(full, workspace, regex, out, max, opts)
    } else if (entry.isFile()) {
      const rel = relative(workspace, full)
      // matchBase mirrors ripgrep's gitignore-style globs: a slash-less pattern
      // like "*.ts" matches files at any depth, while "src/**/*.ts" matches by path.
      if (opts.glob && !minimatch(rel, opts.glob, { matchBase: true })) continue
      let content: string
      try {
        content = await fs.readFile(full, 'utf8')
      } catch {
        continue
      }
      if (content.includes(String.fromCharCode(0))) continue // skip binary files
      const lines = content.split('\n')
      const matchedLines: number[] = []
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) matchedLines.push(i)
      }
      if (matchedLines.length === 0) continue

      if (opts.filesWithMatches) {
        out.push(rel)
        if (out.length >= max) return
        continue
      }

      const ctx = opts.context && opts.context > 0 ? opts.context : 0
      const emitted = new Set<number>()
      for (const m of matchedLines) {
        const from = Math.max(0, m - ctx)
        const to = Math.min(lines.length - 1, m + ctx)
        for (let i = from; i <= to; i++) {
          if (emitted.has(i)) continue
          emitted.add(i)
          const sep = i === m ? ':' : '-'
          out.push(`${rel}:${i + 1}${sep} ${lines[i].trim().slice(0, 200)}`)
          if (out.length >= max) return
        }
      }
    }
  }
}

export interface SearchOptions extends MatchOptions {
  pattern: string
  /** Workspace root; ripgrep runs with this as cwd so output paths are workspace-relative. */
  workspace: string
  /** Search root relative to the workspace (ripgrep argument). */
  searchRel: string
  /** Absolute search root (JS fallback). */
  startAbs: string
  /** Resolved ripgrep path, or null to force the JS fallback. */
  rgPath: string | null
  max: number
  signal?: AbortSignal
}

/** Search file contents, preferring ripgrep and falling back to the JS walk. */
export async function searchContents(o: SearchOptions): Promise<string> {
  if (!o.pattern) throw new Error('pattern is required.')
  const matchOpts: MatchOptions = {
    ignoreCase: o.ignoreCase,
    glob: o.glob,
    context: o.context,
    filesWithMatches: o.filesWithMatches
  }
  if (o.rgPath) {
    const { matches, error } = await runRipgrep(
      o.rgPath,
      o.pattern,
      o.workspace,
      o.searchRel,
      o.max,
      o.signal,
      matchOpts
    )
    if (error) throw new Error(`Invalid regular expression: ${error}`)
    return matches.length ? matches.join('\n') : 'No matches found.'
  }
  let regex: RegExp
  try {
    regex = new RegExp(o.pattern, o.ignoreCase ? 'i' : undefined)
  } catch (e) {
    throw new Error(`Invalid regular expression: ${(e as Error).message}`, { cause: e })
  }
  const out: string[] = []
  await jsWalk(o.startAbs, o.workspace, regex, out, o.max, matchOpts)
  return out.length ? out.join('\n') : 'No matches found.'
}
