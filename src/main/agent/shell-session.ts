import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxRunOptions, SandboxRunResult } from '../sandbox'

/**
 * Persistent shell state for a single agent run.
 *
 * Plain `run_shell` calls are each an isolated `bash -c`, so `cd` and exported
 * variables don't survive from one command to the next — `cd build` followed by
 * `make` would run `make` back at the project root. A ShellSession threads the
 * working directory and exported environment between foreground commands within a
 * run, so the agent gets "same terminal" behavior: change
 * directory once, activate a virtualenv once, and later commands inherit it.
 *
 * Implementation: each command is wrapped so it (1) restores the captured env and
 * cwd, (2) runs the command, then (3) writes the resulting cwd and `export -p`
 * snapshot to out-of-band temp files. The command's own stdout/stderr stay
 * pristine; only the captured state travels between calls. The Seatbelt sandbox
 * remains the security boundary — this only affects *where* and *with what env*
 * commands run, never *what* they may touch.
 */
export interface ShellSession {
  /** Working directory for the next foreground command (persists `cd`). */
  cwd: string
  /** `export -p` snapshot from the last command (persists exported env vars). */
  env: string
}

export function createShellSession(workspace: string): ShellSession {
  return { cwd: workspace, env: '' }
}

/** Escape a string for safe embedding inside a single-quoted bash literal. */
export function singleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export interface CapturePaths {
  /** File the wrapper writes the post-command `pwd` to. */
  cwdOut: string
  /** File the wrapper writes the post-command `export -p` to. */
  envOut: string
  /** File holding the env snapshot to restore before the command (may not exist). */
  envIn: string
}

/**
 * Build the wrapped command: restore env + cwd, run the command, then capture the
 * resulting cwd and exported env to the out files. Prelude failures are silenced
 * so they never leak into the command's stderr; the command's exit code is
 * preserved as the wrapper's exit code.
 */
export function buildSessionCommand(
  command: string,
  session: ShellSession,
  paths: CapturePaths
): string {
  const lines: string[] = []
  if (session.env) lines.push(`source ${singleQuote(paths.envIn)} 2>/dev/null`)
  lines.push(`cd ${singleQuote(session.cwd)} 2>/dev/null || true`)
  lines.push(command)
  lines.push('__houston_ec=$?')
  lines.push(`pwd > ${singleQuote(paths.cwdOut)} 2>/dev/null`)
  lines.push(`export -p > ${singleQuote(paths.envOut)} 2>/dev/null`)
  lines.push('exit $__houston_ec')
  return lines.join('\n')
}

/**
 * Fold the captured cwd/env (file *contents*) back into the session. Empty
 * captures (e.g. a command that was killed before the wrapper could write) leave
 * the previous state intact.
 */
export function applySessionResult(
  session: ShellSession,
  captured: { cwd: string; env: string }
): void {
  const cwd = captured.cwd.trim()
  if (cwd) session.cwd = cwd
  if (captured.env.trim()) session.env = captured.env
}

export type SandboxRunner = (opts: SandboxRunOptions) => Promise<SandboxRunResult>

/**
 * Run one foreground command inside a persistent session: wrap it, execute it via
 * the injected sandbox runner starting in the session cwd, then update the session
 * from the captured state. Temp files are always cleaned up.
 */
export async function runInSession(opts: {
  command: string
  session: ShellSession
  workspace: string
  roots?: string[]
  allowNetwork: boolean
  timeoutMs?: number
  signal?: AbortSignal
  run: SandboxRunner
  fileOps?: Pick<typeof fs, 'readFile' | 'writeFile' | 'rm'>
}): Promise<SandboxRunResult> {
  const io = opts.fileOps ?? fs
  const stamp = randomUUID().slice(0, 12)
  const paths: CapturePaths = {
    cwdOut: join(tmpdir(), `houston-sh-${stamp}.cwd`),
    envOut: join(tmpdir(), `houston-sh-${stamp}.env`),
    envIn: join(tmpdir(), `houston-sh-${stamp}.envin`)
  }

  if (opts.session.env) {
    try {
      await io.writeFile(paths.envIn, opts.session.env, 'utf8')
    } catch {
      // If we can't stage the env, fall through with the cwd-only prelude.
    }
  }

  const wrapped = buildSessionCommand(opts.command, opts.session, paths)
  const result = await opts.run({
    command: wrapped,
    cwd: opts.session.cwd,
    workspace: opts.workspace,
    roots: opts.roots,
    allowNetwork: opts.allowNetwork,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal
  })

  const read = async (p: string): Promise<string> => {
    try {
      return await io.readFile(p, 'utf8')
    } catch {
      return ''
    }
  }
  applySessionResult(opts.session, { cwd: await read(paths.cwdOut), env: await read(paths.envOut) })

  for (const p of [paths.cwdOut, paths.envOut, paths.envIn]) {
    try {
      await io.rm(p, { force: true })
    } catch {
      // best-effort cleanup
    }
  }

  return result
}
