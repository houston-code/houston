import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import { resolveInRoots } from './tools'
import { hasBinary, type BinLookupOptions } from './format'
import { runSandboxed, type SandboxRunResult } from '../sandbox'

/**
 * Opt-in "diagnostics on save": after a successful write-kind tool the agent runs,
 * the loop can run a fast file-appropriate checker (a linter) on the file just
 * written and feed any problems back to the model so it can self-correct in the
 * same turn — the editor-style "red squiggles after save" loop.
 *
 * Each entry maps a file extension to one or more checkers: the binary needed and
 * the (read-only) argv to run. A checker only fires when
 *   - the binary is present on PATH / in the usual install dirs, AND
 *   - the target resolves inside the agent's allowed roots (workspace + added dirs)
 * so an unconfigured machine or an out-of-tree path is a silent no-op rather than
 * an error. The checker runs through the same Seatbelt sandbox as run_shell (no
 * network, writes confined to the roots), and diagnostics are best-effort — a
 * missing binary or a crashing checker never fails the edit.
 *
 * This is the read-only sibling of {@link import('./format').formatFile}: it never
 * mutates the file, only reports.
 */

/** A checker: the binary to look for and the argv to run it with. */
export interface Checker {
  /** The executable name (looked up on PATH and in the standard install dirs). */
  bin: string
  /** Build the argv (after `bin`) to check `absPath` read-only. */
  args: (absPath: string) => string[]
}

/**
 * Extension → checker registry. ESLint covers the JS/TS family; Python prefers
 * ruff (fast, increasingly standard) and falls back to pyflakes; Go uses
 * `gofmt -l`, which lists the file when it isn't gofmt-clean. Extensions are
 * lower-cased and keyed without the dot. When several checkers map to one
 * extension, the first present binary wins (see {@link checkerFor}).
 */
export const CHECKERS: Record<string, Checker[]> = (() => {
  const eslint: Checker = { bin: 'eslint', args: (p) => [p] }
  const jsExts = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs']
  const reg: Record<string, Checker[]> = {}
  for (const ext of jsExts) reg[ext] = [eslint]
  reg.py = [
    { bin: 'ruff', args: (p) => ['check', p] },
    { bin: 'pyflakes', args: (p) => [p] }
  ]
  reg.pyi = reg.py
  // gofmt -l prints the path when the file isn't gofmt-formatted (and nothing
  // when it's clean) — a fast, file-level "needs attention" signal.
  reg.go = [{ bin: 'gofmt', args: (p) => ['-l', p] }]
  return reg
})()

/** Default cap on checker output surfaced to the model, in characters. */
const DEFAULT_MAX_CHARS = 4000
/** How long a checker may run before it's aborted (cold linters can be slow). */
const DEFAULT_TIMEOUT_MS = 20_000

/** Lower-cased extension of `path` without the leading dot (empty if none). */
function extKey(path: string): string {
  return extname(path).replace(/^\./, '').toLowerCase()
}

/**
 * The checker to use for `path`, or null if the extension is unmapped or no mapped
 * binary is installed. When several checkers map to the extension (e.g. ruff then
 * pyflakes), the first whose binary is present wins.
 */
export function checkerFor(path: string, opts: BinLookupOptions = {}): Checker | null {
  const candidates = CHECKERS[extKey(path)]
  if (!candidates) return null
  return candidates.find((c) => hasBinary(c.bin, opts)) ?? null
}

export interface DiagnosticsOptions {
  /** The canonical workspace root (primary directory). */
  workspace: string
  /** All allowed roots (workspace + added directories). */
  roots: string[]
  signal?: AbortSignal
  /** Max chars of checker output to surface (default 4000). */
  maxChars?: number
  /** Injectable for tests; defaults to the real sandbox runner. */
  run?: (opts: Parameters<typeof runSandboxed>[0]) => Promise<SandboxRunResult>
  /** Injectable binary-presence check (tests). */
  hasBin?: (bin: string) => boolean
}

export interface DiagnosticsResult {
  /** True if a checker actually ran (binary present + path in roots). */
  ran: boolean
  /** The binary that ran, when `ran`. */
  bin?: string
  /** The checker's exit code, when it ran. */
  exitCode?: number | null
  /**
   * A formatted block to append to the tool output, present only when the checker
   * surfaced problems. Absent when the file is clean (or nothing ran).
   */
  block?: string
}

/**
 * Run the matching checker on the file at `relPath`, if one is applicable and
 * installed, and return a block describing any problems for the model. Returns
 * `{ ran: false }` (never throws) when there's no checker, the binary is absent,
 * or the path escapes the roots — the caller treats diagnostics as best-effort.
 * The checker runs sandboxed with no network, exactly like run_shell, and never
 * modifies the file.
 */
export async function runPostEditDiagnostics(
  relPath: string,
  opts: DiagnosticsOptions
): Promise<DiagnosticsResult> {
  const roots = opts.roots.length ? opts.roots : [opts.workspace]

  // The target must resolve inside the allowed roots, or we don't touch it.
  let abs: string
  try {
    abs = resolveInRoots(roots, relPath)
  } catch {
    return { ran: false }
  }
  if (!existsSync(abs)) return { ran: false }

  const hasBin = opts.hasBin ?? ((b: string) => hasBinary(b))
  const candidates = CHECKERS[extKey(abs)]
  if (!candidates) return { ran: false }
  const checker = candidates.find((c) => hasBin(c.bin))
  if (!checker) return { ran: false }

  const run = opts.run ?? runSandboxed
  const command = [checker.bin, ...checker.args(abs)].map(shellQuote).join(' ')
  const result = await run({
    command,
    cwd: opts.workspace,
    workspace: opts.workspace,
    roots,
    allowNetwork: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    signal: opts.signal
  })

  // A non-empty diagnostic stream, a non-zero exit, or a timeout all mean the
  // file isn't clean. A clean run (exit 0, no output) produces no block so we
  // don't pad every successful edit with noise.
  const out = [result.stdout, result.stderr]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n')
  const failed = typeof result.exitCode === 'number' && result.exitCode !== 0
  if (!out && !failed && !result.timedOut) {
    return { ran: true, bin: checker.bin, exitCode: result.exitCode }
  }

  const block = formatDiagnosticsBlock({
    bin: checker.bin,
    output: out,
    timedOut: result.timedOut,
    workspace: opts.workspace,
    maxChars: opts.maxChars ?? DEFAULT_MAX_CHARS
  })
  return { ran: true, bin: checker.bin, exitCode: result.exitCode, block }
}

/**
 * Build the feedback block appended to the tool output. Absolute paths under the
 * workspace are relativised for readability, and long output is truncated to
 * `maxChars` so a noisy checker can't blow the context budget.
 */
export function formatDiagnosticsBlock(args: {
  bin: string
  output: string
  timedOut: boolean
  workspace: string
  maxChars: number
}): string {
  const { bin, timedOut, workspace, maxChars } = args
  let output = workspace ? args.output.split(`${workspace}/`).join('') : args.output
  if (output.length > maxChars) {
    const dropped = output.length - maxChars
    output = `${output.slice(0, maxChars)}\n… (truncated, ${dropped} more characters)`
  }
  const header = timedOut
    ? `[diagnostics: ${bin} timed out after ${DEFAULT_TIMEOUT_MS / 1000}s]`
    : `[diagnostics: ${bin} reported problems]`
  return `\n\n${header}${output ? `\n${output}` : ''}`
}

/** Single-quote an argv element for safe embedding in a `/bin/bash -c` string. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
