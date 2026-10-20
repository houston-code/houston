/**
 * A turn's receipt: what Houston itself recorded running while the agent worked.
 *
 * The agent's closing message is its own account of the work, and a model can
 * report checks it never ran ("tests pass", "verified in the browser") as easily as
 * ones it did. The receipt is the other account: the loop builds it from the tool
 * calls it executed (each command's exit code, parsed test counts, the files it
 * changed), and the model has no way to write to it. The clients show it beside the
 * model's final message so the two can be compared at a glance.
 *
 * This module holds the persisted shape and the wording every client shares, so the
 * GUI, the TUI, and headless describe a receipt the same way. It is pure: the main
 * process (agent/evidence.ts) does the recording and classification.
 */

/** What a command was for, as far as the receipt is concerned. */
export type CheckKind =
  | 'test'
  | 'typecheck'
  | 'build'
  | 'lint'
  | 'http'
  | 'browser'
  | 'install'
  | 'server'
  /** The user's own verify-on-stop command, when its command says nothing more specific. */
  | 'verify'

/**
 * Why a command failed, when the sandbox or the host made it fail: the same causes
 * run_shell already names in its hints to the model.
 */
export type BlockedReason = 'network' | 'egress' | 'sandbox-write' | 'sandbox-op' | 'runtime-missing'

/** Counts read from a test runner's own summary line. */
export interface TestCounts {
  passed: number
  /** Failures and errors together: either way the run did not pass. */
  failed: number
  skipped?: number
}

/** Why a check's outcome can't be told from what was recorded. */
export type UnknownReason =
  /** Started with background:true and gone from the registry before the turn ended. */
  | 'background'
  /** Started with background:true and still running when the turn ended. */
  | 'still-running'
  | 'exit-not-attributable'
  | 'http-status-unchecked'
  /** A browser check that loaded the page (and maybe acted on it) but checked nothing on it. */
  | 'not-asserted'

/** How a browser check's interaction steps went. */
export interface StepCounts {
  total: number
  passed: number
  /** Steps after the first failure, which never ran. */
  notRun: number
  /** The first failed step, described without any value it typed. */
  firstFailure?: string
  /** A page load problem (an HTTP error, a refused connection), when there was one. */
  loadError?: string
}

/** One command that bears on whether the work was checked, as of its last run this turn. */
export interface ReceiptCheck {
  kind: CheckKind
  /** The command as run, with secrets masked and whitespace collapsed; truncated. */
  label: string
  /**
   * true: it passed. false: it failed (non-zero exit, killed, timed out, or failures
   * in the runner's own summary). null: the outcome can't be told (see `unknown`).
   */
  ok: boolean | null
  /** Set when `ok` is null. */
  unknown?: UnknownReason
  /** The process exit code; null when it was killed. Absent for a background start. */
  exitCode?: number | null
  timedOut?: boolean
  counts?: TestCounts
  blocked?: BlockedReason
  /** Started with background:true. */
  background?: boolean
  /** For a browser check: how its steps went. */
  steps?: StepCounts
  /** Who ran it, when it wasn't the agent itself (a subagent's name). */
  by?: string
  /** The user's verify-on-stop command, run by Houston at the end of the turn. */
  gate?: true
  /**
   * It ran before the turn's last file change, so it may not cover the final code.
   * Informational: a later edit to a README makes an earlier test run no less real.
   */
  beforeLastWrite?: true
  /** How many times this same command ran this turn. The fields above describe the last. */
  runs: number
}

/** What Houston recorded about a turn. Saved on the turn's last assistant message. */
export interface TurnReceipt {
  v: 1
  /** Most recent last; capped at {@link RECEIPT_MAX_CHECKS}. */
  checks: ReceiptCheck[]
  /** Checks dropped by the cap (the oldest). */
  checksOmitted?: number
  /** Commands of no particular kind (ls, git status, cat): counted, not listed. */
  otherCommands: number
  /** Paths the turn's file tools changed, in first-change order; capped at {@link RECEIPT_MAX_FILES}. */
  filesChanged: string[]
  /** Every path changed, including any beyond the cap. */
  filesChangedCount: number
}

export const RECEIPT_MAX_CHECKS = 24
export const RECEIPT_MAX_FILES = 200
export const RECEIPT_LABEL_MAX = 160

const KIND_LABEL: Record<CheckKind, string> = {
  test: 'tests',
  typecheck: 'typecheck',
  build: 'build',
  lint: 'lint',
  http: 'HTTP',
  browser: 'browser',
  install: 'install',
  server: 'server',
  verify: 'verify command'
}

/** The short name a client shows for a check's kind. */
export function checkKindLabel(kind: CheckKind): string {
  return KIND_LABEL[kind]
}

const BLOCKED_TEXT: Record<BlockedReason, string> = {
  network: 'no network',
  egress: 'blocked by the egress allowlist',
  'sandbox-write': 'the sandbox blocked a write',
  'sandbox-op': 'blocked by the sandbox',
  'runtime-missing': 'runtime not installed'
}

function countsText(c: TestCounts): string {
  const parts = [`${c.passed} passed`]
  if (c.failed) parts.push(`${c.failed} failed`)
  if (c.skipped) parts.push(`${c.skipped} skipped`)
  return parts.join(', ')
}

function stepsText(s: StepCounts): string {
  if (s.loadError) return `the page did not load: ${s.loadError}`
  if (s.total === 0) return 'loaded'
  const parts = [`${s.passed} of ${s.total} steps passed`]
  if (s.firstFailure) parts.push(`failed at ${s.firstFailure}`)
  if (s.notRun) parts.push(`${s.notRun} not run`)
  return parts.join(', ')
}

/** The detail a client shows after a check's command: what its last run came to. */
export function checkDetail(c: ReceiptCheck): string {
  const parts: string[] = []
  if (c.steps) parts.push(stepsText(c.steps))
  else if (c.unknown === 'background') parts.push('started in the background')
  else if (c.unknown === 'still-running') parts.push('still running')
  else if (c.timedOut) parts.push('timed out')
  else if (c.counts) parts.push(countsText(c.counts))
  else if (c.exitCode === null) parts.push('killed')
  else if (c.exitCode !== undefined) parts.push(`exit ${c.exitCode}`)
  if (c.unknown === 'exit-not-attributable') parts.push('exit code is from another part of the command')
  if (c.unknown === 'http-status-unchecked') parts.push('HTTP status not checked')
  if (c.unknown === 'not-asserted') parts.push('nothing on the page was checked')
  if (c.blocked) parts.push(BLOCKED_TEXT[c.blocked])
  if (c.background && c.exitCode !== undefined) parts.push('ran in the background')
  if (c.gate) parts.push('your verify command')
  if (c.by) parts.push(`run by ${c.by}`)
  if (c.beforeLastWrite) parts.push('ran before the last file change')
  if (c.runs > 1) parts.push(`ran ${c.runs} times, last run shown`)
  return parts.join(', ')
}

/** A one-character mark for a check's outcome, for the terminal clients. */
export function checkGlyph(c: ReceiptCheck): string {
  return c.ok === true ? '✓' : c.ok === false ? '✗' : '○'
}

/** Files that are documentation, for which "no tests ran" would be noise. */
const DOC_FILE = /(\.(md|mdx|markdown|txt|rst|adoc)|(^|[/\\])(LICENSE|NOTICE|AUTHORS|CODEOWNERS)(\.[a-z]+)?)$/i

function onlyDocsChanged(r: TurnReceipt): boolean {
  return (
    r.filesChangedCount > 0 &&
    r.filesChangedCount === r.filesChanged.length &&
    r.filesChanged.every((p) => DOC_FILE.test(p))
  )
}

function lastOf(r: TurnReceipt, kind: CheckKind): ReceiptCheck | undefined {
  for (let i = r.checks.length - 1; i >= 0; i--) if (r.checks[i].kind === kind) return r.checks[i]
  return undefined
}

function testsPhrase(r: TurnReceipt): string | null {
  const t = lastOf(r, 'test')
  if (!t) {
    // The line that matters most when code changed and nothing tested it, and only
    // noise when the turn edited a README.
    return r.filesChangedCount > 0 && !onlyDocsChanged(r) ? 'no tests ran' : null
  }
  if (t.ok === true) return t.counts ? `tests passed (${t.counts.passed})` : 'tests passed'
  if (t.ok === false) {
    if (t.timedOut) return 'tests timed out'
    if (t.counts && t.counts.failed > 0) {
      return `tests failed (${t.counts.failed} of ${t.counts.passed + t.counts.failed})`
    }
    if (t.counts && t.counts.passed === 0) return 'no tests were found'
    const why = t.blocked ? ` (${BLOCKED_TEXT[t.blocked]})` : ''
    return `test command failed${why}`
  }
  if (t.unknown === 'background') return 'tests started in the background'
  if (t.unknown === 'still-running') return 'tests still running'
  return 'test result unknown'
}

function otherPhrase(c: ReceiptCheck): string {
  const name = KIND_LABEL[c.kind]
  if (c.ok === true) return c.kind === 'browser' ? 'browser check passed' : `${name} passed`
  if (c.ok === false) {
    if (c.kind === 'browser') return 'browser check failed'
    const why = c.timedOut ? ' (timed out)' : c.blocked ? ` (${BLOCKED_TEXT[c.blocked]})` : ''
    return `${name} failed${why}`
  }
  if (c.unknown === 'background') return c.kind === 'server' ? 'server started' : `${name} started in the background`
  if (c.unknown === 'still-running') return c.kind === 'server' ? 'server running' : `${name} still running`
  if (c.unknown === 'http-status-unchecked') return 'HTTP requests sent, status not checked'
  if (c.unknown === 'not-asserted') return 'browser: nothing on the page was checked'
  return `${name} result unknown`
}

/**
 * The receipt in one line: the tests' outcome first (or that none ran), then each
 * other kind of check by its last run, then how many files changed.
 * "No tests ran · install failed (no network) · build failed · 14 files changed"
 */
export function receiptSummary(r: TurnReceipt): string {
  const parts: string[] = []
  const tests = testsPhrase(r)
  if (tests) parts.push(tests)
  const kinds: CheckKind[] = ['typecheck', 'build', 'lint', 'verify', 'install', 'server', 'http', 'browser']
  for (const kind of kinds) {
    const last = lastOf(r, kind)
    if (last) parts.push(otherPhrase(last))
  }
  if (r.filesChangedCount > 0) {
    parts.push(`${r.filesChangedCount} file${r.filesChangedCount === 1 ? '' : 's'} changed`)
  }
  if (!parts.length && r.otherCommands > 0) {
    parts.push(`${r.otherCommands} command${r.otherCommands === 1 ? '' : 's'} ran`)
  }
  const line = parts.join(' · ')
  return line.charAt(0).toUpperCase() + line.slice(1)
}

/** Whether any check in the receipt failed. */
export function receiptHasFailure(r: TurnReceipt): boolean {
  return r.checks.some((c) => c.ok === false)
}

/**
 * The receipt as plain lines for the terminal clients: the summary, then one line
 * per check, then a count of the commands not listed.
 */
export function formatReceiptLines(r: TurnReceipt): string[] {
  const lines = [`Recorded by Houston: ${receiptSummary(r)}`]
  for (const c of r.checks) {
    const detail = checkDetail(c)
    lines.push(`  ${checkGlyph(c)} ${KIND_LABEL[c.kind]}: ${c.label}${detail ? ` (${detail})` : ''}`)
  }
  if (r.checksOmitted) {
    lines.push(`  plus ${r.checksOmitted} earlier check${r.checksOmitted === 1 ? '' : 's'}`)
  }
  if (r.otherCommands > 0) {
    lines.push(`  plus ${r.otherCommands} other command${r.otherCommands === 1 ? '' : 's'}`)
  }
  return lines
}
