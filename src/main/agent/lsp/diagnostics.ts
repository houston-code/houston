/**
 * Post-edit diagnostics from a language server: after the agent writes a file a server
 * covers, report the problems the edit introduced, as a diff against what the server
 * reported for the file before the edit. Only errors and a few warnings, so an edit to
 * a file that already had problems doesn't repeat them on every write, and a clean
 * edit adds nothing to the tool result.
 */
import { promises as fs } from 'node:fs'
import type { Diagnostic, LspClient } from './client'
import type { LspManager } from './manager'

/** Most new errors listed; the rest are counted. */
export const MAX_ERRORS = 20
/** Most new warnings listed (warnings are capped harder: they rarely block). */
export const MAX_WARNINGS = 5

export interface EditDiagnosticsOptions {
  manager: Pick<LspManager, 'clientFor'>
  /** Absolute path of the file written. */
  abs: string
  /** The path as the model named it, for the report. */
  rel: string
  roots: string[]
  /** The file's content before the write, or null when the write created it. */
  before: string | null
  signal?: AbortSignal
  /** Quiet period after the last publish before the list counts as settled. */
  settleMs?: number
  /** How long to wait for each publish (before and after the edit). */
  timeoutMs?: number
  /** How long to wait for a server that is still starting; later edits use it once it's up. */
  startBudgetMs?: number
}

export interface EditDiagnosticsResult {
  /** A server covered the file and answered. */
  ran: boolean
  /** The server's display name, when one was used. */
  server?: string
  /** The block to append to the tool result; absent when the edit added no problems. */
  block?: string
  /** The server didn't publish in time; the caller may fall back to another checker. */
  timedOut?: boolean
}

const DEFAULT_SETTLE_MS = 300
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_START_BUDGET_MS = 15_000

/** Error for a severity per the spec: an absent severity is the client's call; treat it as an error. */
export function isError(d: Diagnostic): boolean {
  return d.severity === undefined || d.severity === 1
}
export function isWarning(d: Diagnostic): boolean {
  return d.severity === 2
}

/** What identifies "the same problem" across an edit that may have shifted its line. */
function diagKey(d: Diagnostic): string {
  return `${d.severity ?? 1}\0${d.source ?? ''}\0${d.code ?? ''}\0${d.message}`
}

/**
 * The diagnostics in `after` that weren't in `before`. Compared by severity, source,
 * code, and message (not position, since an edit above a problem moves it), as a
 * multiset: a second copy of an existing problem counts as new.
 */
export function newDiagnostics(before: Diagnostic[], after: Diagnostic[]): Diagnostic[] {
  const remaining = new Map<string, number>()
  for (const d of before) remaining.set(diagKey(d), (remaining.get(diagKey(d)) ?? 0) + 1)
  const fresh: Diagnostic[] = []
  for (const d of after) {
    const k = diagKey(d)
    const n = remaining.get(k) ?? 0
    if (n > 0) remaining.set(k, n - 1)
    else fresh.push(d)
  }
  return fresh
}

function oneLine(s: string, max = 300): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function formatDiag(rel: string, d: Diagnostic): string {
  const where = `${rel}:${d.range.start.line + 1}:${d.range.start.character + 1}`
  const sev = isError(d) ? 'error' : isWarning(d) ? 'warning' : 'info'
  const code = d.code !== undefined && d.code !== '' ? ` ${d.source === 'ts' || d.source === 'typescript' ? 'TS' : ''}${d.code}` : ''
  return `${where} ${sev}${code}: ${oneLine(d.message)}`
}

/**
 * The report block for `fresh` problems, or undefined when there are none worth
 * showing. `compared` is false when the before-edit list wasn't available, so every
 * problem is listed and the header says so.
 */
export function formatEditDiagnostics(args: {
  server: string
  rel: string
  fresh: Diagnostic[]
  compared: boolean
  /** Problems already present before the edit (not listed). */
  preexisting?: number
}): string | undefined {
  const errors = args.fresh.filter(isError).sort(byPosition)
  const warnings = args.fresh.filter(isWarning).sort(byPosition)
  if (errors.length === 0 && warnings.length === 0) return undefined
  const shownErrors = errors.slice(0, MAX_ERRORS)
  const shownWarnings = warnings.slice(0, MAX_WARNINGS)
  const parts: string[] = []
  if (errors.length) parts.push(`${errors.length} ${args.compared ? 'new ' : ''}error${errors.length === 1 ? '' : 's'}`)
  if (warnings.length) parts.push(`${warnings.length} ${args.compared ? 'new ' : ''}warning${warnings.length === 1 ? '' : 's'}`)
  const header = `[diagnostics: ${args.server} reports ${parts.join(' and ')} in ${args.rel}${args.compared ? ' after this edit' : ''}]`
  const lines = [...shownErrors, ...shownWarnings].map((d) => formatDiag(args.rel, d))
  const notes: string[] = []
  if (errors.length > shownErrors.length) notes.push(`${errors.length - shownErrors.length} more errors not shown`)
  if (warnings.length > shownWarnings.length) notes.push(`${warnings.length - shownWarnings.length} more warnings not shown`)
  if (!args.compared) notes.push('the problems from before this edit could not be read, so all are listed')
  else if (args.preexisting) notes.push(`${args.preexisting} problem${args.preexisting === 1 ? '' : 's'} from before this edit not shown`)
  return `\n\n${header}\n${lines.join('\n')}${notes.length ? `\n(${notes.join('; ')})` : ''}`
}

function byPosition(a: Diagnostic, b: Diagnostic): number {
  return a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character
}

/** Resolve with `p`, or null once `ms` pass or `signal` aborts. */
function within<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null)
    const t = setTimeout(() => done(null), ms)
    const onAbort = (): void => done(null)
    signal?.addEventListener('abort', onAbort, { once: true })
    let settled = false
    const done = (v: T | null): void => {
      if (settled) return
      settled = true
      clearTimeout(t)
      signal?.removeEventListener('abort', onAbort)
      resolve(v)
    }
    p.then(done, () => done(null))
  })
}

/** Publish-and-settle for `text`: sync it and wait for the server's verdict on it. */
async function diagnosticsFor(
  client: LspClient,
  abs: string,
  text: string,
  opts: { settleMs: number; timeoutMs: number }
): Promise<Diagnostic[] | null> {
  // Already holding exactly this text, with a verdict on it (often from the read that
  // preceded the edit, see LspManager.noteRead): no need to ask again.
  const cached = client.currentDiagnostics(abs)
  if (client.openText(abs) === text && cached !== undefined) return cached
  const mark = client.diagnosticsMark(abs)
  const version = await client.sync(abs, text)
  return client.waitForDiagnostics(abs, { mark, version, ...opts })
}

/**
 * Run the covering server's diagnostics on a file the agent just wrote and return the
 * problems the write introduced. Never throws; `{ ran: false }` when no server covers
 * the file (or it couldn't start in time), so the caller can fall back to a checker.
 */
export async function lspEditDiagnostics(opts: EditDiagnosticsOptions): Promise<EditDiagnosticsResult> {
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  try {
    const client = await within(
      opts.manager.clientFor(opts.abs, opts.roots),
      opts.startBudgetMs ?? DEFAULT_START_BUDGET_MS,
      opts.signal
    )
    if (!client) return { ran: false }
    const server = `${client.server.spec.name} language server`
    let after: string
    try {
      after = await fs.readFile(opts.abs, 'utf8')
    } catch {
      return { ran: false }
    }
    if (opts.before === after) {
      // Nothing changed on disk; just make sure the server holds the current text.
      await client.sync(opts.abs, after)
      return { ran: true, server }
    }
    const before =
      opts.before === null ? [] : await within(diagnosticsFor(client, opts.abs, opts.before, { settleMs, timeoutMs }), timeoutMs + settleMs, opts.signal)
    const post = await within(diagnosticsFor(client, opts.abs, after, { settleMs, timeoutMs }), timeoutMs + settleMs, opts.signal)
    if (post === null) {
      // Leave the server holding the file as it is on disk even though it was slow.
      await client.sync(opts.abs, after).catch(() => {})
      return { ran: false, server, timedOut: true }
    }
    const compared = before !== null
    const fresh = compared ? newDiagnostics(before, post) : post
    const preexisting = compared
      ? post.filter((d) => isError(d) || isWarning(d)).length - fresh.filter((d) => isError(d) || isWarning(d)).length
      : 0
    const block = formatEditDiagnostics({ server, rel: opts.rel, fresh, compared, preexisting })
    return { ran: true, server, ...(block ? { block } : {}) }
  } catch {
    return { ran: false }
  }
}
