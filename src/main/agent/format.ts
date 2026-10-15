import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import { joinFor, pathDelimiter } from '../binaries'
import { resolveInRoots } from './tools'
import { backendShellSyntax, runSandboxed, type SandboxRunResult, type ShellSyntax } from '../sandbox'

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

/** Standard developer bin dirs to check for a formatter beyond PATH (POSIX only). */
const EXTRA_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

/**
 * Windows file suffixes {@link resolveBinaryPath} accepts by default: native executables
 * only, which every caller can spawn directly (openInEditor spawns without a shell).
 * PATHEXT is deliberately not consulted: it also lists `.cmd`/`.bat`/`.vbs`/`.js`/`.ps1`,
 * none of which can be spawned without an interpreter, and `.cmd`/`.bat` in particular
 * only run through cmd.exe, which re-parses the argv (`&`, `^`, `%VAR%`), so a file path
 * argument could inject commands (Node refuses to spawn them shell-less since
 * CVE-2024-27980 for the same reason).
 */
export const WIN_DIRECT_EXTENSIONS: readonly string[] = ['.exe', '.com']

/**
 * Windows suffixes for a tool run by name through Git Bash (format-on-save and
 * diagnostics): the native executables plus the extensionless `#!/bin/sh` shim npm
 * installs beside every `.cmd` shim (`prettier`, `eslint`), which bash runs directly.
 * `.cmd`/`.bat` stay excluded even here: MSYS hands them to cmd.exe, reintroducing the
 * re-parse described on {@link WIN_DIRECT_EXTENSIONS}.
 */
export const WIN_BASH_EXTENSIONS: readonly string[] = ['.exe', '.com', '']

export interface BinLookupOptions {
  env?: NodeJS.ProcessEnv
  exists?: (p: string) => boolean
  /** Platform override (defaults to process.platform); injected in tests. */
  platform?: NodeJS.Platform
  /**
   * Windows only: the suffixes to try, in order, for each PATH dir (default
   * {@link WIN_DIRECT_EXTENSIONS}). Ignored elsewhere, where the bare name is probed.
   */
  extensions?: readonly string[]
}

/**
 * The full path to `bin` if found on PATH or in the standard install dirs, else
 * null. Pure name (no slash) only — a formatter/editor binary is never an arbitrary
 * path. Returns the resolved path (not just a boolean) so callers that must *spawn*
 * the binary work even when launched with a stripped PATH (e.g. from the macOS Dock,
 * where a shim in /usr/local/bin or /opt/homebrew/bin wouldn't be on PATH).
 *
 * On Windows each PATH dir is probed for `bin` + each of `opts.extensions` (dir-major,
 * like the OS search), and the POSIX install dirs are skipped.
 */
export function resolveBinaryPath(bin: string, opts: BinLookupOptions = {}): string | null {
  const env = opts.env ?? process.env
  const exists = opts.exists ?? existsSync
  const platform = opts.platform ?? process.platform
  const joinP = joinFor(platform)
  if (!bin || bin.includes('/') || bin.includes('\\')) return null
  const win = platform === 'win32'
  // `C:x` is a drive-relative path on Windows, not a name.
  if (win && bin.includes(':')) return null
  const suffixes = win ? (opts.extensions ?? WIN_DIRECT_EXTENSIONS) : ['']
  const dirs = (env.PATH ?? '').split(pathDelimiter(platform)).filter(Boolean)
  if (!win) dirs.push(...EXTRA_BIN_DIRS)
  for (const dir of dirs) {
    for (const ext of suffixes) {
      const candidate = joinP(dir, bin + ext)
      if (exists(candidate)) return candidate
    }
  }
  return null
}

/**
 * Whether `bin` can be found on PATH or in the standard install dirs. Pure name
 * (no slash) only — a formatter binary is never an arbitrary path.
 */
export function hasBinary(bin: string, opts: BinLookupOptions = {}): boolean {
  return resolveBinaryPath(bin, opts) !== null
}

/** A tool (formatter or checker) run on one file: the binary and its argv builder. */
export interface FileTool {
  bin: string
  args: (absPath: string) => string[]
}

export interface ToolRunOptions {
  /** Platform override (defaults to process.platform); injected in tests. */
  platform?: NodeJS.Platform
  /** The sandbox shell's syntax (defaults to the active backend's). */
  shellSyntax?: ShellSyntax
  /** Locate a tool: the path to run, or null when absent (default: the PATH probe). */
  resolveBin?: (bin: string) => string | null
  /** Legacy presence check (tests); the tool then runs by its bare name. */
  hasBin?: (bin: string) => boolean
  /** Environment for the default PATH probe. */
  env?: NodeJS.ProcessEnv
  /** Path-existence check for the default PATH probe. */
  exists?: (p: string) => boolean
}

/** The default tool resolver for `platform`: what the sandbox shell can run. */
function toolResolver(opts: ToolRunOptions, platform: NodeJS.Platform): (bin: string) => string | null {
  if (opts.resolveBin) return opts.resolveBin
  const { hasBin } = opts
  if (hasBin) return (b) => (hasBin(b) ? b : null)
  return (b) =>
    resolveBinaryPath(b, { platform, env: opts.env, exists: opts.exists, extensions: WIN_BASH_EXTENSIONS })
}

/**
 * Whether a format-on-save / diagnostics tool can run on this host: its binary is
 * found AND the sandbox shell can be handed a safely quoted command. Under the Windows
 * cmd.exe fallback that is never (see {@link planToolRun}).
 */
export function canRunTool(bin: string, opts: ToolRunOptions = {}): boolean {
  if ((opts.shellSyntax ?? backendShellSyntax()) === 'cmd') return false
  return toolResolver(opts, opts.platform ?? process.platform)(bin) !== null
}

/**
 * Pick the first of `candidates` that is installed and build the shell command that
 * runs it on `absPath`, or null when none can run.
 *
 * The command is bash-quoted, which is right for every shell the sandbox can use
 * except the Windows cmd.exe fallback (no Git Bash). cmd.exe cannot be made safe for
 * an arbitrary file path: `%VAR%` expands even inside double quotes and there is no
 * escape for it on a `/c` command line, so a file named `%PATH%.ts` or `a&calc.ts`
 * would be rewritten or run a second command. Rather than produce garbage (which
 * diagnostics would then report to the model as "problems"), tools are disabled there.
 *
 * On POSIX the tool runs by its bare name (the shell's own PATH lookup, as before).
 * On Windows (Git Bash) it runs by its resolved path, in forward-slash form so MSYS
 * reads it as a path, so exactly the file the lookup vetted is what executes.
 */
export function planToolRun<T extends FileTool>(
  candidates: readonly T[],
  absPath: string,
  opts: ToolRunOptions = {}
): { tool: T; command: string } | null {
  if ((opts.shellSyntax ?? backendShellSyntax()) === 'cmd') return null
  const platform = opts.platform ?? process.platform
  const resolve = toolResolver(opts, platform)
  for (const tool of candidates) {
    const resolved = resolve(tool.bin)
    if (!resolved) continue
    const exe = platform === 'win32' ? resolved.replace(/\\/g, '/') : tool.bin
    return { tool, command: [exe, ...tool.args(absPath)].map(shellQuote).join(' ') }
  }
  return null
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
  return candidates.find((f) => hasBinary(f.bin, { extensions: WIN_BASH_EXTENSIONS, ...opts })) ?? null
}

export interface FormatOptions extends ToolRunOptions {
  /** The canonical workspace root (primary directory). */
  workspace: string
  /** All allowed roots (workspace + added directories). */
  roots: string[]
  signal?: AbortSignal
  /** Injectable for tests; defaults to the real sandbox runner. */
  run?: (opts: Parameters<typeof runSandboxed>[0]) => Promise<SandboxRunResult>
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
 * there's no formatter, the binary is absent, the shell is the Windows cmd.exe
 * fallback, or the path escapes the roots — the
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

  const candidates = FORMATTERS[extKey(abs)]
  if (!candidates) return { formatted: false }
  const plan = planToolRun(candidates, abs, opts)
  if (!plan) return { formatted: false }
  const { tool: formatter, command } = plan

  const run = opts.run ?? runSandboxed
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
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
