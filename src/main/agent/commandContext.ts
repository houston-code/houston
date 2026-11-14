import { promises as fs, realpathSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { expandTemplate } from '@shared/commands'
import { CONTEXT_SENTINEL_RE, findContext } from '@shared/commandContext'
import { captureUserShell, type ShellCapture } from '../userShell'
import { isSensitivePath } from './sensitive-paths'
import { resolveInRoots } from './tools'

/**
 * Dynamic context in a custom command's template.
 *
 * `@path` inside a template becomes that file's contents, and `` !`command` ``
 * becomes what the command printed, both filled in when the command runs, so a
 * template like "Review this diff: !`git diff --stat`" hands the model the facts
 * instead of asking it to go and get them.
 *
 * Both are trust boundaries, because a project's command files come from the
 * repository:
 *
 *  - A file must resolve inside the workspace roots, through symlinks, exactly as
 *    `read_file` requires, and a credential file asks first in every case, as a
 *    `read_file` of it does. Files are capped in size with a clear marker.
 *  - A shell command runs in the user's own shell (as the composer's `!` escape
 *    does), so before running one the user sees the exact commands and says yes,
 *    unless the command file is their own (`~/.houston/commands`) or the folder is
 *    trusted. Where nobody can be asked, it is refused instead.
 *
 * Expansion is all or nothing: a refused, failed or timed-out piece stops the send
 * with a message, so the model never gets a half-filled prompt. The arguments the
 * user typed are filled in after the context and never reach a shell command, so
 * `/deploy "; rm -rf ~"` can't turn into one. A path-like `@word` that names no file
 * (`npm i @types/node`) stays text.
 */

/** Largest part of one file put into the prompt. */
export const MAX_CONTEXT_FILE_BYTES = 50_000
/** Most output kept from one command. */
export const MAX_CONTEXT_SHELL_BYTES = 32_000
/** How long one command may run. */
export const CONTEXT_SHELL_TIMEOUT_MS = 30_000
/** Most `@file` and shell pieces one template may hold. */
const MAX_CONTEXT_ITEMS = 20

/** What the user is asked to allow before the expansion runs. */
export interface ContextConsent {
  /** Shell commands, exactly as they will run. */
  commands: string[]
  /** Credential files the template reads (workspace-relative). */
  sensitiveFiles: string[]
}

/**
 * What a client shows when asking: the command, then each shell command exactly
 * as it will run and each credential file it reads. Lines, so the terminal can
 * indent them and a dialog can join them.
 */
export function describeContextConsent(name: string, consent: ContextConsent): { title: string; lines: string[] } {
  const lines = [
    ...consent.commands.map((c) => `$ ${c}`),
    ...consent.sensitiveFiles.map((f) => `read ${f} (a credential file)`)
  ]
  const what =
    consent.commands.length && consent.sensitiveFiles.length
      ? 'run these commands and read a credential file'
      : consent.commands.length
        ? `run ${consent.commands.length === 1 ? 'this command' : 'these commands'} in your shell`
        : 'read a credential file'
  return { title: `${name} wants to ${what} to fill in its prompt:`, lines }
}

export interface ExpandContextOptions {
  workspace: string
  /** The workspace roots files must resolve inside (the workspace first). */
  roots: string[]
  /**
   * The command runs without asking: it is the user's own (`~/.houston/commands`)
   * or the folder is trusted. Credential files still ask.
   */
  preapproved: boolean
  /**
   * Ask the user to allow the expansion. Absent where nobody can be asked: then
   * anything that needs asking is refused.
   */
  confirm?: (consent: ContextConsent) => Promise<boolean>
  /** Run one command (injected by tests). Defaults to the user's shell, bounded. */
  runShell?: (command: string) => Promise<ShellCapture>
}

export type ExpandContextResult = { ok: true; text: string } | { ok: false; error: string }

/** A fence longer than any backtick run in `text`, so file contents can't close it. */
function fenceFor(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((r) => r.length))
  return '`'.repeat(longest + 1)
}

/** The longest leading part of `buf` that is whole UTF-8 characters. */
function utf8Prefix(buf: Buffer): string {
  let end = buf.length
  // Step back over a trailing partial character (continuation bytes 10xxxxxx).
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const b = buf[end - i]
    if ((b & 0xc0) === 0x80) continue
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1
    if (need > i) end -= i
    break
  }
  return buf.subarray(0, end).toString('utf8')
}

/** Read one context file, capped. */
async function readContextFile(abs: string, shown: string): Promise<{ text: string } | { error: string }> {
  let handle
  try {
    handle = await fs.open(abs, 'r')
  } catch {
    return { error: `@${shown}: no such file` }
  }
  try {
    const st = await handle.stat()
    if (!st.isFile()) return { error: `@${shown} is not a file` }
    const buf = Buffer.alloc(Math.min(st.size, MAX_CONTEXT_FILE_BYTES))
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    const head = buf.subarray(0, bytesRead)
    if (head.includes(0)) return { error: `@${shown} is not a text file` }
    let text = utf8Prefix(head)
    if (st.size > bytesRead) {
      text += `\n[truncated: ${shown} is ${st.size} bytes; only the first ${bytesRead} are shown]`
    }
    return { text }
  } finally {
    await handle.close()
  }
}

/**
 * Fill in a template's `@file` and `` !`command` `` context and its arguments.
 * Returns the whole prompt, or why it could not be built (nothing half-expanded).
 */
export async function expandCommandContext(
  rawTemplate: string,
  args: string,
  opts: ExpandContextOptions
): Promise<ExpandContextResult> {
  const { pieces, template } = findContext(rawTemplate)
  if (!pieces.length) return { ok: true, text: expandTemplate(rawTemplate, args) }
  if (pieces.length > MAX_CONTEXT_ITEMS) {
    return { ok: false, error: `this command pulls in ${pieces.length} files and commands; the most is ${MAX_CONTEXT_ITEMS}` }
  }

  // Every file is checked before anything runs or anyone is asked, so a bad path
  // never costs the user a prompt or a command.
  const files = new Map<number, { abs: string; shown: string }>()
  const literal = new Set<number>()
  const sensitiveFiles: string[] = []
  for (const [i, p] of pieces.entries()) {
    if (p.kind !== 'file') continue
    let abs: string
    try {
      abs = resolveInRoots(opts.roots, p.path)
    } catch {
      return { ok: false, error: `@${p.path} is outside this project` }
    }
    let real: string
    try {
      real = realpathSync(abs)
    } catch {
      literal.add(i) // names no file: it stays text
      continue
    }
    // Shown with forward slashes on every platform, the way the template names it.
    const shown = relative(opts.workspace, abs).split(sep).join('/') || p.path
    files.set(i, { abs, shown })
    // Judged by the name written, where it points and what it really is, so an
    // innocent-looking link to `.env` still asks.
    const sensitive = isSensitivePath(p.path) || isSensitivePath(abs) || isSensitivePath(real)
    if (sensitive && !sensitiveFiles.includes(shown)) sensitiveFiles.push(shown)
  }
  const commands = pieces.flatMap((p) => (p.kind === 'shell' ? [p.command] : []))

  const consent: ContextConsent = { commands: opts.preapproved ? [] : commands, sensitiveFiles }
  if (consent.commands.length || consent.sensitiveFiles.length) {
    if (!opts.confirm) {
      return {
        ok: false,
        error: consent.commands.length
          ? "it runs shell commands, and there is no one here to approve them (run it from the terminal or the app, or trust this folder)"
          : 'it reads a credential file, and there is no one here to approve that'
      }
    }
    if (!(await opts.confirm(consent))) return { ok: false, error: 'not run: you declined its context' }
  }

  const filled: string[] = []
  for (const [i, p] of pieces.entries()) {
    if (p.kind === 'file' && literal.has(i)) {
      filled[i] = `@${p.path}`
      continue
    }
    if (p.kind === 'file') {
      const f = files.get(i)!
      const read = await readContextFile(f.abs, f.shown)
      if ('error' in read) return { ok: false, error: read.error }
      const fence = fenceFor(read.text)
      filled[i] = `Contents of \`${f.shown}\`:\n${fence}\n${read.text}\n${fence}`
      continue
    }
    let run: ShellCapture
    try {
      run = await (opts.runShell ?? ((c) =>
        captureUserShell(opts.workspace, c, { timeoutMs: CONTEXT_SHELL_TIMEOUT_MS, maxBytes: MAX_CONTEXT_SHELL_BYTES })))(p.command)
    } catch (e) {
      return { ok: false, error: `couldn't run \`${p.command}\`: ${(e as Error).message}` }
    }
    if (run.timedOut) return { ok: false, error: `\`${p.command}\` took longer than ${CONTEXT_SHELL_TIMEOUT_MS / 1000}s and was stopped` }
    if (run.exitCode !== 0) {
      const why = run.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)
      return { ok: false, error: `\`${p.command}\` exited ${run.exitCode}${why ? `: ${why}` : ''}` }
    }
    let out = run.stdout.replace(/\s+$/, '')
    if (run.truncated) out += `\n[truncated: \`${p.command}\` printed more than ${MAX_CONTEXT_SHELL_BYTES} bytes]`
    filled[i] = out
  }

  // The user's arguments go in last, around the filled context and never inside it
  // (a NUL in them could otherwise pose as a placeholder).
  // eslint-disable-next-line no-control-regex -- stripping NUL is the point
  const withArgs = expandTemplate(template, args.replace(/\u0000/g, ''))
  const text = withArgs.replace(CONTEXT_SENTINEL_RE, (_m, d: string) => filled[Number(d)] ?? '')
  return { ok: true, text }
}
