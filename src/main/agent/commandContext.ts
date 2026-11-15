import { promises as fs, lstatSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { expandTemplate } from '@shared/commands'
import { CONTEXT_SENTINEL_RE, findContext, lineRangeLabel, type LineRange } from '@shared/commandContext'
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
 * (`npm i @types/node`, an `@/alias` import) or names a folder (`@src/`) stays text.
 */

/** Largest part of one file put into the prompt. */
export const MAX_CONTEXT_FILE_BYTES = 50_000
/** Largest file a line range (`@path#20-45`) is taken from: the lines are found by reading it. */
export const MAX_RANGE_SOURCE_BYTES = 10 * 1024 * 1024
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

/** Cap `text` at {@link MAX_CONTEXT_FILE_BYTES} on a character boundary, with a marker saying so. */
function capContext(text: string, what: string): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= MAX_CONTEXT_FILE_BYTES) return text
  const kept = utf8Prefix(buf.subarray(0, MAX_CONTEXT_FILE_BYTES))
  return `${kept}\n[truncated: ${what} is ${buf.length} bytes; only the first ${Buffer.byteLength(kept)} are shown]`
}

/**
 * Read one context file, capped, as a fenced block under a header naming it: the
 * whole file, or with `lines` only those lines (`Lines 20-45 of \`src/a.ts\`:`).
 * Shared by a command template's `@file` and a message's `@path#20-45`.
 */
export async function readContextFile(
  abs: string,
  shown: string,
  lines?: LineRange
): Promise<{ text: string } | { error: string }> {
  const named = lines ? `${shown}#${lineRangeLabel(lines)}` : shown
  if (lines && lines.end < lines.start) return { error: `@${named}: the range ends before it starts` }
  let handle
  try {
    handle = await fs.open(abs, 'r')
  } catch {
    return { error: `@${named}: no such file` }
  }
  try {
    const st = await handle.stat()
    if (!st.isFile()) return { error: `@${named} is not a file` }
    if (!lines) {
      const buf = Buffer.alloc(Math.min(st.size, MAX_CONTEXT_FILE_BYTES))
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
      const head = buf.subarray(0, bytesRead)
      if (head.includes(0)) return { error: `@${shown} is not a text file` }
      let text = utf8Prefix(head)
      if (st.size > bytesRead) {
        text += `\n[truncated: ${shown} is ${st.size} bytes; only the first ${bytesRead} are shown]`
      }
      return { text: fenced(`Contents of \`${shown}\`:`, text) }
    }
    if (st.size > MAX_RANGE_SOURCE_BYTES) {
      return { error: `@${named}: ${shown} is too large to take lines from (over ${MAX_RANGE_SOURCE_BYTES / 1024 / 1024} MB)` }
    }
    const buf = Buffer.alloc(st.size)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    const all = buf.subarray(0, bytesRead)
    if (all.includes(0)) return { error: `@${named}: ${shown} is not a text file` }
    const rows = utf8Prefix(all).split('\n')
    // A final newline ends the last line; it does not start one more.
    if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop()
    if (lines.start > rows.length) {
      return { error: `@${named}: ${shown} has only ${rows.length} ${rows.length === 1 ? 'line' : 'lines'}` }
    }
    const end = Math.min(lines.end, rows.length)
    const label = lineRangeLabel({ start: lines.start, end })
    const header =
      end < lines.end
        ? `Lines ${label} of \`${shown}\` (the file ends at line ${rows.length}):`
        : `${lines.start === end ? 'Line' : 'Lines'} ${label} of \`${shown}\`:`
    const body = capContext(rows.slice(lines.start - 1, end).join('\n'), `${shown} lines ${label}`)
    return { text: fenced(header, body) }
  } finally {
    await handle.close()
  }
}

/** `header`, then `text` in a fence it can't close. */
function fenced(header: string, text: string): string {
  const fence = fenceFor(text)
  return `${header}\n${fence}\n${text}\n${fence}`
}

/** Where a mentioned path resolves, or why it can't be read. */
export type ResolvedContextFile =
  | { kind: 'file'; abs: string; shown: string; sensitive: boolean }
  | { kind: 'outside' }
  | { kind: 'missing' }

/**
 * Resolve a mentioned path inside the workspace roots, through symlinks, exactly
 * as `read_file` requires. `missing` (it names no file, or names a folder) means the
 * word stays text.
 * `sensitive` is judged by the name written, where it points and what it really is,
 * so an innocent-looking link to `.env` still asks.
 */
export function resolveContextFile(roots: string[], workspace: string, path: string): ResolvedContextFile {
  let abs: string
  try {
    abs = resolveInRoots(roots, path)
  } catch {
    // Outside the roots: refused only when it names something that is there (a
    // real file, or a link that leads out). `@/components/x` (an import alias) or
    // `@../x` that names nothing stays text.
    const base = roots[0] ?? workspace
    const outside = isAbsolute(path) ? resolve(path) : resolve(base, path)
    try {
      lstatSync(outside)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' }
    }
    return { kind: 'outside' }
  }
  let real: string
  try {
    real = realpathSync(abs)
  } catch {
    return { kind: 'missing' }
  }
  // A folder (`@src/`) is a mention, not a file to put in the prompt.
  if (statSync(real).isDirectory()) return { kind: 'missing' }
  // Shown with forward slashes on every platform, the way the template names it.
  const shown = relative(workspace, abs).split(sep).join('/') || path
  return { kind: 'file', abs, shown, sensitive: isSensitivePath(path) || isSensitivePath(abs) || isSensitivePath(real) }
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
    const r = resolveContextFile(opts.roots, opts.workspace, p.path)
    if (r.kind === 'outside') return { ok: false, error: `@${p.path} is outside this project` }
    if (r.kind === 'missing') {
      literal.add(i) // names no file: it stays text
      continue
    }
    files.set(i, { abs: r.abs, shown: r.shown })
    if (r.sensitive && !sensitiveFiles.includes(r.shown)) sensitiveFiles.push(r.shown)
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
      filled[i] = `@${p.path}${p.lines ? `#${lineRangeLabel(p.lines)}` : ''}`
      continue
    }
    if (p.kind === 'file') {
      const f = files.get(i)!
      const read = await readContextFile(f.abs, f.shown, p.lines)
      if ('error' in read) return { ok: false, error: read.error }
      filled[i] = read.text
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
