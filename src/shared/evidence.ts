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

/** A command a subagent ran that isn't a check (see TurnReceipt.delegated). */
export interface DelegatedCommand {
  label: string
  /** Null when it was killed or still running. */
  exitCode: number | null
  by: string
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
  /**
   * Commands of no particular kind that a subagent ran, listed with who ran them (the
   * user didn't watch them happen, so they're named rather than counted). Most recent
   * last; capped at {@link RECEIPT_MAX_DELEGATED}.
   */
  delegated?: DelegatedCommand[]
  /** Delegated commands dropped by the cap (the oldest). */
  delegatedOmitted?: number
  /** For files a subagent changed: who changed them, keyed by the path in `filesChanged`. */
  filesBy?: Record<string, string>
  /** Paths the turn's file tools changed, in first-change order; capped at {@link RECEIPT_MAX_FILES}. */
  filesChanged: string[]
  /** Every path changed, including any beyond the cap. */
  filesChangedCount: number
  /**
   * Todo items the agent marked completed this turn that claim a check ran (tests, a
   * build, a browser check) with no passing run of it recorded. At most 10.
   */
  todoGaps?: string[]
  /** Progress against the plan the user accepted, while it is still being carried out. */
  plan?: PlanProgress
}

/** How one of an accepted plan's checks stands, across every turn since it was accepted. */
export interface PlanCheckStatus {
  /** The check as the plan put it ("pytest", "curl POST /todos"). */
  step: string
  /** passed: a run of it passed. failed: it ran and nothing passed. skipped: the user said not to. */
  status: 'passed' | 'failed' | 'not-run' | 'skipped'
}

/**
 * An accepted plan held against what every turn since its acceptance recorded: the
 * files it said it would change that no turn has, and each of its checks.
 */
export interface PlanProgress {
  title: string
  /** When the plan was accepted (epoch ms), so later turns can tell files changed since. */
  acceptedAt?: number
  filesTotal: number
  /** Planned files not changed yet, at most 10. */
  filesPending: string[]
  /** How many planned files are not changed yet, including any beyond the list. */
  filesPendingCount: number
  checks: PlanCheckStatus[]
  /** Every planned file changed and every check passed. Shown once, then the plan is done. */
  complete: boolean
}

/** The receipt's heading in every client. Local wording: nothing here leaves the machine. */
export const RECEIPT_TITLE = 'What ran'

export const RECEIPT_MAX_CHECKS = 24
export const RECEIPT_MAX_FILES = 200
export const RECEIPT_MAX_DELEGATED = 12
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
  // An unchecked HTTP request's exit code only says curl ran, not how the server answered.
  else if (c.unknown === 'http-status-unchecked') parts.push('response not checked')
  else if (c.exitCode === null) parts.push('killed')
  else if (c.exitCode !== undefined) parts.push(`exit ${c.exitCode}`)
  if (c.unknown === 'exit-not-attributable') parts.push('exit code is from another part of the command')
  if (c.unknown === 'not-asserted') parts.push('nothing on the page was checked')
  if (c.blocked) parts.push(BLOCKED_TEXT[c.blocked])
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
  if (c.unknown === 'http-status-unchecked') return 'HTTP response not checked'
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
  if (r.plan) parts.push(planPhrase(r.plan))
  const gaps = r.todoGaps?.length ?? 0
  if (gaps) parts.push(`${gaps} todo${gaps === 1 ? '' : 's'} marked done with nothing recorded`)
  const delegated = (r.delegated?.length ?? 0) + (r.delegatedOmitted ?? 0)
  if (delegated) parts.push(`${delegated} subagent command${delegated === 1 ? '' : 's'} ran`)
  if (!parts.length && r.otherCommands > 0) {
    parts.push(`${r.otherCommands} command${r.otherCommands === 1 ? '' : 's'} ran`)
  }
  const line = parts.join(' · ')
  return line.charAt(0).toUpperCase() + line.slice(1)
}

/** The plan's progress in a few words: "plan: 9 of 11 files, 1 of 3 checks passed". */
export function planPhrase(p: PlanProgress): string {
  if (p.complete) return 'plan complete'
  const parts: string[] = []
  if (p.filesTotal) parts.push(`${p.filesTotal - p.filesPendingCount} of ${p.filesTotal} files`)
  if (p.checks.length) {
    const passed = p.checks.filter((c) => c.status === 'passed').length
    parts.push(`${passed} of ${p.checks.length} checks passed`)
  }
  return `plan: ${parts.join(', ')}`
}

const PLAN_CHECK_TEXT: Record<PlanCheckStatus['status'], string> = {
  passed: 'passed',
  failed: 'ran, nothing passed',
  'not-run': 'not run yet',
  skipped: 'skipped, as you asked'
}

/** A plan check's status in words. */
export function planCheckText(c: PlanCheckStatus): string {
  return PLAN_CHECK_TEXT[c.status]
}

/** Whether any check in the receipt failed, or a todo claims a check nothing backs. */
export function receiptHasFailure(r: TurnReceipt): boolean {
  return r.checks.some((c) => c.ok === false) || (r.todoGaps?.length ?? 0) > 0
}

/**
 * The receipt as plain lines for the terminal clients: the summary, then one line
 * per check, then a count of the commands not listed.
 */
export function formatReceiptLines(r: TurnReceipt): string[] {
  const lines = [`${RECEIPT_TITLE}: ${receiptSummary(r)}`]
  for (const c of r.checks) {
    const detail = checkDetail(c)
    lines.push(`  ${checkGlyph(c)} ${KIND_LABEL[c.kind]}: ${c.label}${detail ? ` (${detail})` : ''}`)
  }
  if (r.checksOmitted) {
    lines.push(`  plus ${r.checksOmitted} earlier check${r.checksOmitted === 1 ? '' : 's'}`)
  }
  for (const d of r.delegated ?? []) {
    lines.push(`  ${delegatedGlyph(d)} Command: ${d.label} (${delegatedDetail(d)})`)
  }
  if (r.delegatedOmitted) {
    lines.push(`  plus ${r.delegatedOmitted} earlier subagent command${r.delegatedOmitted === 1 ? '' : 's'}`)
  }
  if (r.otherCommands > 0) {
    lines.push(`  plus ${r.otherCommands} other command${r.otherCommands === 1 ? '' : 's'}`)
  }
  const byFiles = Object.entries(r.filesBy ?? {})
  for (const [file, by] of byFiles) lines.push(`  changed ${file} (by ${by})`)
  for (const g of r.todoGaps ?? []) lines.push(`  ! marked done with nothing recorded: ${g}`)
  if (r.plan && !r.plan.complete) {
    lines.push(`  plan "${r.plan.title}":`)
    for (const c of r.plan.checks) {
      lines.push(`    ${c.status === 'passed' ? '✓' : c.status === 'failed' ? '✗' : '○'} ${c.step} (${planCheckText(c)})`)
    }
    if (r.plan.filesPendingCount) {
      const more = r.plan.filesPendingCount - r.plan.filesPending.length
      lines.push(`    files not changed yet: ${r.plan.filesPending.join(', ')}${more > 0 ? `, and ${more} more` : ''}`)
    }
  }
  return lines
}

/** ✓ for a delegated command that exited 0, ✗ for one that didn't, ? when unknown. */
export function delegatedGlyph(d: DelegatedCommand): string {
  return d.exitCode === null ? '?' : d.exitCode === 0 ? '✓' : '✗'
}

/** "exit 0 · by Writable subagent "Fix the bug"". */
export function delegatedDetail(d: DelegatedCommand): string {
  return `${d.exitCode === null ? 'exit unknown' : `exit ${d.exitCode}`} · by ${d.by}`
}
