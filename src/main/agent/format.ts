import { existsSync } from 'node:fs'
import { delimiter, extname, join } from 'node:path'
import { resolveInRoots } from './tools'
import { runSandboxed, type SandboxRunResult } from '../sandbox'

/**
 * Opt-in "format on save": after a successful write-kind tool the agent runs, the
 * loop can format the file the agent just wrote, the way an editor would on save.
 *
 * Each entry maps a file extension to a formatter: the binary it needs and the
 * argv to run (with the absolute file path appended). A formatter only fires when
 *   - the binary is present on PATH / in the usual install dirs, AND
 *   - the target resolves inside the agent's allowed roots (workspace + added dirs)
 * so an unconfigured machine or an out-of-tree path is a silent no-op rather than
 * an error. The formatter is run through the same Seatbelt sandbox as run_shell
 * (no network, writes confined to the roots).
 */

/** A formatter: the binary to look for and the argv to run it with. */
export interface Formatter {
  /** The executable name (looked up on PATH and in the standard install dirs). */
  bin: string
  /** Build the argv (after `bin`) for formatting `absPath` in place. */
  args: (absPath: string) => string[]
}

/**
 * Extension → formatter registry. Prettier covers the web/text formats; the rest
 * are the canonical per-language formatters. Extensions are lower-cased and keyed
 * without the dot. Multiple formatters could apply to one extension in principle;
 * the first present binary wins (see {@link formatterFor}).
 */
export const FORMATTERS: Record<string, Formatter[]> = (() => {
  const prettier: Formatter = {
    bin: 'prettier',
    args: (p) => ['--write', p]
  }
  const prettierExts = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'jsonc', 'css', 'scss', 'less', 'md', 'markdown', 'html', 'yaml', 'yml']
  const reg: Record<string, Formatter[]> = {}
  for (const ext of prettierExts) reg[ext] = [prettier]
  reg.go = [{ bin: 'gofmt', args: (p) => ['-w', p] }]
  reg.rs = [{ bin: 'rustfmt', args: (p) => [p] }]
  // Python: prefer ruff (fast, increasingly standard), fall back to black.
  reg.py = [
    { bin: 'ruff', args: (p) => ['format', p] },
    { bin: 'black', args: (p) => ['-q', p] }
  ]
  reg.pyi = reg.py
  return reg
})()

/** Standard developer bin dirs to check for a formatter beyond PATH. */
const EXTRA_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

export interface BinLookupOptions {
  env?: NodeJS.ProcessEnv
  exists?: (p: string) => boolean
}

/**
 * Whether `bin` can be found on PATH or in the standard install dirs. Pure name
 * (no slash) only — a formatter binary is never an arbitrary path.
 */
export function hasBinary(bin: string, opts: BinLookupOptions = {}): boolean {
  const env = opts.env ?? process.env
  const exists = opts.exists ?? existsSync
  if (!bin || bin.includes('/')) return false
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && exists(join(dir, bin))) return true
  }
  for (const dir of EXTRA_BIN_DIRS) if (exists(join(dir, bin))) return true
  return false
}

/** Lower-cased extension of `path` without the leading dot (empty if none). */
function extKey(path: string): string {
  return extname(path).replace(/^\./, '').toLowerCase()
}

/**
 * The formatter to use for `path`, or null if the extension is unmapped or no
 * mapped binary is installed. When several formatters map to the extension (e.g.
 * ruff then black), the first whose binary is present wins.
 */
export function formatterFor(path: string, opts: BinLookupOptions = {}): Formatter | null {
  const candidates = FORMATTERS[extKey(path)]
  if (!candidates) return null
  return candidates.find((f) => hasBinary(f.bin, opts)) ?? null
}

export interface FormatOptions {
  /** The canonical workspace root (primary directory). */
  workspace: string
  /** All allowed roots (workspace + added directories). */
  roots: string[]
  signal?: AbortSignal
  /** Injectable for tests; defaults to the real sandbox runner. */
  run?: (opts: Parameters<typeof runSandboxed>[0]) => Promise<SandboxRunResult>
  /** Injectable binary-presence check (tests). */
  hasBin?: (bin: string) => boolean
}

export interface FormatResult {
  /** True if a formatter actually ran (binary present + path in roots). */
  formatted: boolean
  /** The binary that ran, when `formatted`. */
  bin?: string
  /** The formatter's exit code, when it ran. */
  exitCode?: number | null
}

/**
 * Format the file at `relPath` in place using the matching formatter, if one is
 * applicable and installed. Returns `{ formatted: false }` (never throws) when
 * there's no formatter, the binary is absent, or the path escapes the roots — the
 * caller treats formatting as best-effort. The formatter runs sandboxed with no
 * network, writes confined to the roots, exactly like run_shell.
 */
export async function formatFile(relPath: string, opts: FormatOptions): Promise<FormatResult> {
  const roots = opts.roots.length ? opts.roots : [opts.workspace]

  // The target must resolve inside the allowed roots, or we don't touch it.
  let abs: string
  try {
    abs = resolveInRoots(roots, relPath)
  } catch {
    return { formatted: false }
  }
  if (!existsSync(abs)) return { formatted: false }

  const hasBin = opts.hasBin ?? ((b: string) => hasBinary(b))
  const candidates = FORMATTERS[extKey(abs)]
  if (!candidates) return { formatted: false }
  const formatter = candidates.find((f) => hasBin(f.bin))
  if (!formatter) return { formatted: false }

  const run = opts.run ?? runSandboxed
  const command = [formatter.bin, ...formatter.args(abs)].map(shellQuote).join(' ')
  const result = await run({
    command,
    cwd: opts.workspace,
    workspace: opts.workspace,
    roots,
    allowNetwork: false,
    signal: opts.signal
  })
  return { formatted: true, bin: formatter.bin, exitCode: result.exitCode }
}

/** Single-quote an argv element for safe embedding in a `/bin/bash -c` string. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
