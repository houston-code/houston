/**
 * Finding the dynamic context in a custom command's template: `@path` (a file's
 * contents) and `` !`command` `` (what a command prints). Pure, so the clients can
 * tell a command that needs the main process to fill it in, and the trust
 * fingerprint can see a project command's shell commands. Filling it in lives in
 * src/main/agent/commandContext.ts.
 */

/** A 1-based, inclusive line range: `@path#20-45` (or `#20` for one line). */
export interface LineRange {
  start: number
  end: number
}

export type ContextPiece = { kind: 'file'; path: string; lines?: LineRange } | { kind: 'shell'; command: string }

/**
 * Split a `#20-45` (or `#20`) line range off a mentioned path. Plain line numbers
 * only (no leading zero), so a range that names no file can be written back exactly
 * as it was. A range that ends before it starts is still returned, so the reader can
 * say what is wrong with it rather than treating it as part of the name.
 */
export function splitLineRange(raw: string): { path: string; lines?: LineRange } {
  const m = /^(.*[^#])#([1-9]\d{0,8})(?:-([1-9]\d{0,8}))?$/.exec(raw)
  if (!m) return { path: raw }
  const start = Number(m[2])
  const end = m[3] === undefined ? start : Number(m[3])
  return { path: m[1], lines: { start, end } }
}

/** How a range reads in a header or a message: `20-45`, or `20` for one line. */
export function lineRangeLabel(r: LineRange): string {
  return r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`
}

/** Placeholder for piece `i` while the template's own arguments are filled in. */
export const contextSentinel = (i: number): string => `\u0000HOUSTON_CONTEXT_${i}\u0000`
/** Matches a {@link contextSentinel}, capturing its index. */
// eslint-disable-next-line no-control-regex -- the placeholders are NUL-delimited on purpose
export const CONTEXT_SENTINEL_RE = /\u0000HOUSTON_CONTEXT_(\d+)\u0000/g

/** `` !`command` `` on one line; the command is everything between the backticks. */
const SHELL_RE = /!`([^`\n]+)`/g
/**
 * `@path` at the start of a word, naming something path-like (it holds a `/` or a
 * `.`), so a handle like `@octocat` or an address like `me@host` stays text.
 */
const FILE_RE = /(^|[\s(])@([^\s`'"(),;<>]+)/g

/**
 * Find the dynamic pieces in a template, and the template with each replaced by a
 * placeholder.
 */
export function findContext(template: string): { pieces: ContextPiece[]; template: string } {
  const pieces: ContextPiece[] = []
  let out = template.replace(SHELL_RE, (_m, command: string) => {
    pieces.push({ kind: 'shell', command: command.trim() })
    return contextSentinel(pieces.length - 1)
  })
  out = out.replace(FILE_RE, (m, lead: string, raw: string) => {
    // Sentence punctuation after a path belongs to the sentence ("see @a/b.ts.").
    const word = raw.replace(/[.,:;!?]+$/, '')
    const { path, lines } = splitLineRange(word)
    if (!path || !/[./]/.test(path) || path.includes('\u0000')) return m
    pieces.push({ kind: 'file', path, ...(lines ? { lines } : {}) })
    return `${lead}${contextSentinel(pieces.length - 1)}${raw.slice(word.length)}`
  })
  return { pieces, template: out }
}

/** The shell commands a template runs, in order. */
export function contextCommands(template: string): string[] {
  return findContext(template).pieces.flatMap((p) => (p.kind === 'shell' ? [p.command] : []))
}

/** Whether a template pulls in any `@file` or `` !`command` `` context. */
export function hasContext(template: string): boolean {
  return findContext(template).pieces.length > 0
}
