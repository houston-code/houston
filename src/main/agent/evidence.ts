import { isAbsolute, relative, resolve } from 'node:path'
import {
  RECEIPT_LABEL_MAX,
  RECEIPT_MAX_CHECKS,
  RECEIPT_MAX_FILES,
  type BlockedReason,
  type CheckKind,
  type ReceiptCheck,
  type StepCounts,
  type TestCounts,
  type TurnReceipt,
  type UnknownReason
} from '@shared/evidence'
import type { RequiredCheck } from './todoEvidence'

/**
 * The run's evidence ledger: what the loop saw run, kept so the turn can end with a
 * receipt the model had no hand in (see @shared/evidence for why).
 *
 * Tools report what they executed through `ToolContext.recordEvidence` with the
 * structured result they already have (the exit code, not the "[exit code: N]" text
 * the model reads), and the loop records the files its write tools changed. Nothing
 * here runs a command or makes a model call: classification is pattern matching on
 * the command the tool just ran, and test counts come from the output it already
 * captured.
 *
 * The command splitting below exists only to classify. It is NOT a security
 * boundary and must never be used to decide what may run; permissions.ts owns that.
 */

/** What run_shell reports after it executes a command. */
export interface ShellEvidence {
  kind: 'shell'
  command: string
  background: boolean
  /** The registry id of a background shell, so its outcome can be read when the turn ends. */
  shellId?: string
  /** Null when the process was killed (or, for a background start, not yet known). */
  exitCode: number | null
  timedOut: boolean
  /** The command's output as returned to the model (already clamped), scanned for test counts. */
  output: string
  /** Set when run_shell attributed a failure to the sandbox or host. */
  blocked?: BlockedReason
}

/** The interaction steps view_localhost runs, as far as the receipt cares. */
export type BrowserAction = 'fill' | 'click' | 'dblclick' | 'press' | 'wait_for' | 'expect_text' | 'wait'

/** What view_localhost reports after it loads a page and runs its steps. */
export interface BrowserEvidence {
  kind: 'browser'
  /** The page's final URL. Shown as origin and path only; a query can carry a token. */
  url: string
  /** A non-fatal load problem the capture reported (HTTP error, refused, timeout). */
  loadError?: string
  /** Each step that ran, in order (it stops at the first failure). */
  steps: { step: string; ok: boolean; action: BrowserAction }[]
  /** How many steps were asked for, so the ones never reached count as not run. */
  planned: number
}

/** Anything a tool can record. */
export type EvidenceDraft = ShellEvidence | BrowserEvidence

/** What the background-shell registry says about a shell when the turn ends. */
export interface ShellPeek {
  running: boolean
  exitCode: number | null
  /** The tail of what it printed, scanned for test counts. */
  output: string
}

// ---------------------------------------------------------------------------
// Command classification
// ---------------------------------------------------------------------------

/** A simple command between control operators, with the operators around it. */
interface Segment {
  text: string
  /** The operator before this segment (null at the start). */
  before: string | null
  /** The operator after this segment (null at the end). */
  after: string | null
}

/**
 * Split a command line on its control operators (`&&`, `||`, `;`, `|`, `|&`, a
 * lone `&`, newline), outside quotes and `$(...)`. Approximate by design: it reads
 * enough of the shell to tell which part of a compound command is the test run.
 */
function splitSegments(command: string): Segment[] {
  const segments: Segment[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let depth = 0
  let pendingOp: string | null = null
  const push = (op: string | null): void => {
    const text = current.trim()
    if (text) segments.push({ text, before: pendingOp, after: op })
    else if (segments.length && op) segments[segments.length - 1].after = op
    current = ''
    pendingOp = op
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    const next = command[i + 1]
    if (quote) {
      current += ch
      if (ch === '\\' && quote === '"' && next !== undefined) {
        current += next
        i++
      } else if (ch === quote) quote = null
      continue
    }
    if (ch === '\\' && next !== undefined) {
      current += ch + next
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '$' && next === '(') {
      depth++
      current += '$('
      i++
      continue
    }
    if (depth > 0) {
      if (ch === '(') depth++
      else if (ch === ')') depth--
      current += ch
      continue
    }
    if (ch === '#' && (current === '' || /\s$/.test(current))) {
      // A comment runs to the end of the line.
      while (i + 1 < command.length && command[i + 1] !== '\n') i++
      continue
    }
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      push(ch + next)
      i++
      continue
    }
    if (ch === '|') {
      if (next === '&') i++
      push('|')
      continue
    }
    if (ch === ';' || ch === '\n') {
      push(';')
      continue
    }
    if (ch === '&') {
      // `2>&1`, `>&2`, `<&3`, `&>file` are redirections, not operators.
      const prev = current[current.length - 1]
      if (prev === '>' || prev === '<' || next === '>') {
        current += ch
        continue
      }
      push('&')
      continue
    }
    current += ch
  }
  push(null)
  return segments
}

/** Words of a simple command, quotes removed. Good enough to name the program. */
function words(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ''))
}

/** Leading words that wrap the real program: env assignments, wrappers, runners. */
function stripWrappers(w: string[]): string[] {
  let i = 0
  const at = (k: number): string => (w[i + k] ?? '').toLowerCase()
  for (;;) {
    const word = at(0)
    if (!word) break
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) i++
    else if (['(', '{', '!', 'time', 'command', 'exec', 'env', 'nice', 'nohup', 'do', 'then', 'else'].includes(word)) i++
    else if (['npx', 'bunx', 'uvx', 'pnpx'].includes(word)) {
      i++
      while (at(0).startsWith('-')) i++
    } else if (['pnpm', 'yarn'].includes(word) && ['exec', 'dlx'].includes(at(1))) i += 2
    else if (['uv', 'poetry', 'pipenv', 'hatch', 'pdm', 'rye', 'bundle'].includes(word) && ['run', 'exec'].includes(at(1))) i += 2
    else if (/^(python[0-9.]*|py)$/.test(word) && at(1) === '-m' && at(2)) {
      // `python -m pytest` runs pytest; `python -m pip install` runs pip.
      return [w[i + 2], ...w.slice(i + 3)]
    } else break
  }
  return w.slice(i)
}

/** The program's bare name: `./node_modules/.bin/vitest` is `vitest`. */
function programName(word: string): string {
  const base = word.replace(/\\/g, '/').split('/').pop() ?? word
  return base.toLowerCase().replace(/\.(exe|cmd|bat)$/, '')
}

const LOOPBACK = /\b(localhost|127\.0\.0\.1|0\.0\.0\.0)\b|\[::1\]/i

/** A script file that is itself a test: `test.mjs`, `tests/api.test.js`, `test_app.py`. */
const TEST_SCRIPT =
  /(^|\/)(tests?|specs?)(\/|[._-][^/]*\.(m?[jt]sx?|cjs|py)$|\.(m?[jt]sx?|cjs|py)$)|[._-](test|spec)\.(m?[jt]sx?|cjs)$|(^|\/)test_[^/]*\.py$|_test\.py$/i

/** Package-script names by kind, for `npm run <name>` and friends. */
function scriptKind(name: string): CheckKind | null {
  const n = name.toLowerCase()
  if (/^(test|tests|spec|e2e|unit|integration)([:-].*)?$/.test(n) || n === 't') return 'test'
  if (/^(typecheck|type-check|types|check-types|tsc|check)([:-].*)?$/.test(n)) return 'typecheck'
  if (/^(build|compile|bundle)([:-].*)?$/.test(n)) return 'build'
  if (/^lint([:-].*)?$/.test(n)) return 'lint'
  if (/^(dev|start|serve|preview)([:-].*)?$/.test(n)) return 'server'
  return null
}

/** What one simple command is for, or null when it's none of the receipt's kinds. */
function classifySegment(segment: string): CheckKind | null {
  const w = stripWrappers(words(segment))
  if (!w.length) return null
  const prog = programName(w[0])
  const args = w.slice(1)
  const a0 = (args[0] ?? '').toLowerCase()
  const has = (flag: string): boolean => args.includes(flag)

  switch (prog) {
    case 'pytest':
    case 'py.test':
    case 'unittest':
    case 'nose2':
    case 'tox':
    case 'nox':
    case 'vitest':
    case 'jest':
    case 'mocha':
    case 'ava':
    case 'playwright':
    case 'cypress':
    case 'rspec':
    case 'phpunit':
    case 'ctest':
      return a0 === 'install' ? 'install' : 'test'
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      if (['test', 't', 'tst'].includes(a0)) return 'test'
      if (['install', 'i', 'ci', 'add', 'create', 'update', 'upgrade'].includes(a0)) return 'install'
      // `npm init vite@latest` fetches a scaffolder; a bare `npm init -y` only writes package.json.
      if (a0 === 'init') return args.slice(1).some((x) => !x.startsWith('-')) ? 'install' : null
      if (prog === 'yarn' && args.length === 0) return 'install'
      if (a0 === 'run' || a0 === 'run-script') return scriptKind(args[1] ?? '')
      if (prog === 'npm') return a0 === 'start' ? 'server' : null
      return scriptKind(a0)
    }
    case 'node':
    case 'deno':
    case 'python':
    case 'python3':
    case 'tsx':
    case 'ts-node': {
      if (has('--test') || (prog === 'deno' && a0 === 'test')) return 'test'
      const at = args.findIndex((x) => !x.startsWith('-'))
      const script = at === -1 ? '' : args[at].replace(/\\/g, '/')
      if (/(^|\/)manage\.py$/.test(script)) {
        const sub = args[at + 1] ?? ''
        return sub === 'test' ? 'test' : sub === 'runserver' ? 'server' : null
      }
      return script && script.length <= 256 && TEST_SCRIPT.test(script) ? 'test' : null
    }
    case 'http.server':
      return 'server'
    case 'go':
      if (a0 === 'test') return 'test'
      if (a0 === 'vet') return 'typecheck'
      if (a0 === 'build') return 'build'
      return ['get', 'mod'].includes(a0) ? 'install' : null
    case 'cargo':
      if (['test', 'nextest'].includes(a0)) return 'test'
      if (a0 === 'check') return 'typecheck'
      if (a0 === 'build') return 'build'
      if (a0 === 'clippy') return 'lint'
      if (['fetch', 'install', 'add'].includes(a0)) return 'install'
      return null
    case 'dotnet':
    case 'swift':
    case 'mix':
    case 'mvn':
    case 'gradle':
    case 'gradlew':
      if (a0 === 'test') return 'test'
      if (['build', 'compile', 'package'].includes(a0)) return 'build'
      if (['restore', 'install', 'deps.get', 'add'].includes(a0)) return 'install'
      return null
    case 'make': {
      const target = args.find((x) => !x.startsWith('-') && !x.includes('=')) ?? ''
      if (['test', 'tests', 'check'].includes(target)) return 'test'
      if (target === 'lint') return 'lint'
      if (['', 'all', 'build', 'compile'].includes(target)) return 'build'
      return ['dev', 'run', 'serve', 'start'].includes(target) ? 'server' : null
    }
    case 'tsc':
    case 'vue-tsc':
      return has('--noEmit') || has('-noEmit') ? 'typecheck' : 'build'
    case 'mypy':
    case 'pyright':
    case 'flow':
      return 'typecheck'
    case 'eslint':
    case 'ruff':
    case 'flake8':
    case 'pylint':
    case 'golangci-lint':
    case 'stylelint':
    case 'biome':
      return 'lint'
    case 'prettier':
      return has('--check') ? 'lint' : null
    case 'vite':
      return a0 === 'build' ? 'build' : a0 === 'preview' || a0 === '' || a0 === 'dev' || a0 === 'serve' ? 'server' : null
    case 'next':
    case 'nuxt':
    case 'nuxi':
    case 'astro':
    case 'remix':
    case 'electron-vite':
      return a0 === 'build' ? 'build' : ['dev', 'start', 'preview'].includes(a0) ? 'server' : null
    case 'webpack':
    case 'rollup':
    case 'esbuild':
    case 'parcel':
      return has('serve') || has('--watch') ? null : 'build'
    case 'pip':
    case 'pip3':
      return ['install', 'download'].includes(a0) ? 'install' : null
    case 'uv':
      return a0 === 'sync' || a0 === 'add' || (a0 === 'pip' && args[1] === 'install') ? 'install' : null
    case 'poetry':
    case 'pipenv':
    case 'pdm':
    case 'composer':
    case 'gem':
      return ['install', 'add', 'sync', 'update'].includes(a0) ? 'install' : null
    case 'bundle':
      return a0 === 'install' || a0 === '' ? 'install' : null
    case 'uvicorn':
    case 'gunicorn':
    case 'hypercorn':
    case 'http-server':
    case 'serve':
    case 'live-server':
      return 'server'
    case 'flask':
      return a0 === 'run' ? 'server' : null
    case 'rails':
      return a0 === 'server' || a0 === 's' ? 'server' : a0 === 'test' ? 'test' : null
    case 'curl':
    case 'wget':
    case 'http':
    case 'https':
    case 'xh':
      return LOOPBACK.test(segment) ? 'http' : null
    default:
      // `npx create-react-app app`, `npm exec create-vite`: a scaffolder fetched from the registry.
      return prog.startsWith('create-') ? 'install' : null
  }
}

/** The order a compound command's kinds are weighed in: the first one present names it. */
const KIND_PRIORITY: CheckKind[] = ['test', 'typecheck', 'build', 'lint', 'http', 'install', 'server']

/**
 * Whether a zero exit from the whole command proves the given segment succeeded.
 * The status is the last pipeline's, so it speaks for a segment only when nothing
 * after it could change it (only `&&` follows, never `;`, `||`, or a pipe without
 * pipefail) and the segment wasn't skipped by a `||` before it.
 */
function zeroExitProves(segments: Segment[], index: number, pipefail: boolean): boolean {
  const seg = segments[index]
  if (seg.before === '||') return false
  for (let i = index; i < segments.length; i++) {
    const op = segments[i].after
    if (op === null) break
    if (op === '|' && pipefail) continue
    if (op !== '&&') return false
  }
  return true
}

/** How a command classifies: its kind, and whether its exit code speaks for that part. */
export interface CommandClass {
  /** Null for a command of no particular kind (ls, git status, cat). */
  kind: CheckKind | null
  /** A zero exit proves the classified part succeeded. */
  exitAttributable: boolean
  /** For an HTTP request: a non-2xx/3xx response would have failed the command. */
  httpStatusChecked: boolean
}

/** Classify a command line by what it does, for the receipt. */
export function classifyCommand(command: string, background = false): CommandClass {
  const segments = splitSegments(command)
  const kinds = segments.map((s) => classifySegment(s.text))
  let kind: CheckKind | null = null
  let index = -1
  for (const k of KIND_PRIORITY) {
    const at = kinds.indexOf(k)
    if (at !== -1) {
      kind = k
      index = at
      break
    }
  }
  // A background start with nothing more specific in it is a server (the reason
  // run_shell has background mode); a backgrounded test run stays a test run.
  if (background && kind === null) {
    kind = 'server'
    index = segments.length - 1
  }
  if (kind === null || index === -1) return { kind, exitAttributable: false, httpStatusChecked: false }
  const pipefail = /\bset\s+-[a-z]*o\s+pipefail\b|\bset\s+-o\s+pipefail\b/.test(command)
  const seg = segments[index]
  let httpStatusChecked = false
  if (kind === 'http') {
    const w = words(seg.text)
    const prog = programName(stripWrappers(w)[0] ?? '')
    if (prog === 'wget') httpStatusChecked = true
    else if (prog === 'curl') {
      httpStatusChecked = w.some((x) => x === '--fail' || x === '--fail-with-body' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(x))
    } else httpStatusChecked = w.includes('--check-status')
  }
  return { kind, exitAttributable: zeroExitProves(segments, index, pipefail), httpStatusChecked }
}

// ---------------------------------------------------------------------------
// Test counts
// ---------------------------------------------------------------------------

function sumMatches(text: string, re: RegExp): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of text.matchAll(re)) out[m[2].toLowerCase()] = (out[m[2].toLowerCase()] ?? 0) + Number(m[1])
  return out
}

function lastMatch(text: string, re: RegExp): RegExpMatchArray | undefined {
  return [...text.matchAll(re)].at(-1)
}

/**
 * How much of a command's output is searched for a runner's summary. Every runner
 * prints it last, and keeping the search to the tail keeps it cheap on a long log.
 */
const SUMMARY_TAIL_CHARS = 16_000

/**
 * Read pass/fail counts from a test runner's own summary line, when the output has
 * one this recognizes: vitest, jest, pytest, mocha, node:test, cargo, unittest.
 * Undefined when there is no summary (the exit code then stands alone).
 *
 * The output is whatever the command printed, so a test can print anything here.
 * Every pattern is linear: no repeated group holds optional parts that could match
 * the same text two ways, which on crafted output would stall the main process.
 */
export function parseTestCounts(output: string): TestCounts | undefined {
  const text = output.slice(-SUMMARY_TAIL_CHARS)
  // vitest: "      Tests  1 failed | 11 passed (12)"
  const vitest = lastMatch(text, /^ *Tests +(\d[^(\n]*)\(\d+\) *$/gm)
  if (vitest) {
    const c = sumMatches(vitest[1], /(\d+) +(passed|failed|skipped|todo)\b/g)
    if (Object.keys(c).length) return withSkipped(c.passed ?? 0, c.failed ?? 0, (c.skipped ?? 0) + (c.todo ?? 0))
  }
  // jest: "Tests:       1 failed, 11 passed, 12 total"
  const jest = lastMatch(text, /^Tests: +(\d[^\n]*total) *$/gm)
  if (jest) {
    const c = sumMatches(jest[1], /(\d+) +(passed|failed|skipped|todo|pending)\b/g)
    return withSkipped(c.passed ?? 0, c.failed ?? 0, (c.skipped ?? 0) + (c.todo ?? 0) + (c.pending ?? 0))
  }
  // pytest: "===== 1 failed, 11 passed, 2 skipped in 0.12s =====", "12 passed in 0.05s",
  // "no tests ran in 0.01s". Read line by line, the last line that has both parts.
  const pytest = text
    .split('\n')
    .filter((line) => / in [\d.]+s\b/.test(line) && /\b(\d+ (passed|failed|errors?)|no tests ran)\b/.test(line))
    .at(-1)
  if (pytest) {
    if (/\bno tests ran\b/.test(pytest)) return { passed: 0, failed: 0 }
    const c = sumMatches(pytest, /(\d+) (passed|failed|errors?|skipped|xfailed|xpassed)\b/g)
    return withSkipped(
      (c.passed ?? 0) + (c.xfailed ?? 0),
      (c.failed ?? 0) + (c.error ?? 0) + (c.errors ?? 0) + (c.xpassed ?? 0),
      c.skipped ?? 0
    )
  }
  // mocha: "  12 passing (30ms)" / "  1 failing" / "  2 pending"
  const passing = lastMatch(text, /^ *(\d+) passing\b/gm)
  if (passing) {
    const failing = lastMatch(text, /^ *(\d+) failing\b/gm)
    const pending = lastMatch(text, /^ *(\d+) pending\b/gm)
    return withSkipped(Number(passing[1]), failing ? Number(failing[1]) : 0, pending ? Number(pending[1]) : 0)
  }
  // node:test: "# pass 12" / "# fail 0" (TAP) or "ℹ pass 12" (spec reporter)
  const nodePass = lastMatch(text, /^[#ℹ] pass (\d+) *$/gm)
  const nodeFail = lastMatch(text, /^[#ℹ] fail (\d+) *$/gm)
  if (nodePass && nodeFail) {
    const skipped = lastMatch(text, /^[#ℹ] skipped (\d+) *$/gm)
    return withSkipped(Number(nodePass[1]), Number(nodeFail[1]), skipped ? Number(skipped[1]) : 0)
  }
  // cargo: "test result: ok. 12 passed; 0 failed; 1 ignored; ..." (one per test binary)
  const cargo = [...text.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)]
  if (cargo.length) {
    const sum = (k: number): number => cargo.reduce((n, m) => n + Number(m[k]), 0)
    return withSkipped(sum(1), sum(2), sum(3))
  }
  // unittest: "Ran 12 tests in 0.003s" then "OK" / "OK (skipped=2)" / "FAILED (failures=1, errors=1)"
  const ran = lastMatch(text, /^Ran (\d+) tests? in [\d.]+s *$/gm)
  if (ran) {
    const status = lastMatch(text, /^(?:OK|FAILED)\b(?: \(([^)\n]*)\))? *$/gm)?.[1] ?? ''
    const field = (name: string): number => Number(status.match(new RegExp(`\\b${name}=(\\d+)`))?.[1] ?? 0)
    const failed = field('failures') + field('errors') + field('unexpected_successes')
    const skipped = field('skipped')
    return withSkipped(Math.max(0, Number(ran[1]) - failed - skipped), failed, skipped)
  }
  return undefined
}

function withSkipped(passed: number, failed: number, skipped: number): TestCounts {
  return skipped ? { passed, failed, skipped } : { passed, failed }
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/** One check as recorded, before it's folded into the receipt. */
interface CheckRecord extends Omit<ReceiptCheck, 'runs' | 'beforeLastWrite'> {
  /** When it ran, in the ledger's own order. */
  seq: number
  /** A background shell still to be settled when the receipt is built. */
  pending?: { shellId: string; command: string; cls: CommandClass }
}

/**
 * Control characters removed from anything the receipt shows. A command (or a path)
 * is model-written, and a receipt is printed straight to a terminal by the TUI and
 * headless, where an escape sequence could rewrite the screen or the clipboard.
 */
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g

/** Collapse whitespace, drop control characters, and cap the length of a text for display. */
function displayLabel(text: string, max = RECEIPT_LABEL_MAX): string {
  const flat = text.replace(/\s+/g, ' ').replace(CONTROL_CHARS, '').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** A page URL for display: origin and path, never the query or fragment (they can carry a token). */
function pageLabel(url: string): string {
  try {
    const u = new URL(url)
    return displayLabel(`${u.origin}${u.pathname}`)
  } catch {
    return displayLabel(url.split(/[?#]/)[0])
  }
}

/** Whether a shell run passed, failed, or can't be told, and why. */
function outcome(
  e: Pick<ShellEvidence, 'exitCode' | 'timedOut'>,
  cls: CommandClass,
  counts: TestCounts | undefined
): { ok: boolean | null; unknown?: UnknownReason } {
  if (e.timedOut || e.exitCode === null) return { ok: false }
  if (counts) {
    // The runner's summary is the stronger signal: `pytest; echo done` exits 0 with
    // failures in its summary, and a run that found no tests didn't pass anything.
    if (counts.failed > 0 || counts.passed === 0) return { ok: false }
    return { ok: e.exitCode === 0 }
  }
  if (e.exitCode !== 0) return { ok: false }
  if (cls.kind === 'http' && !cls.httpStatusChecked) return { ok: null, unknown: 'http-status-unchecked' }
  if (!cls.exitAttributable) return { ok: null, unknown: 'exit-not-attributable' }
  return { ok: true }
}

const ACTIONS: ReadonlySet<BrowserAction> = new Set(['fill', 'click', 'dblclick', 'press'])
const ASSERTIONS: ReadonlySet<BrowserAction> = new Set(['expect_text', 'wait_for'])

/**
 * Whether a browser check passed. Every step passing isn't enough: clicking through
 * a flow proves it didn't crash, not that it worked, the way a curl without --fail
 * proves a server answered, not that it answered well. It passes only when a check of
 * the page (expect_text, wait_for) passed after the last action on it.
 */
function browserOutcome(e: BrowserEvidence): { ok: boolean | null; unknown?: UnknownReason; steps: StepCounts } {
  const passed = e.steps.filter((s) => s.ok).length
  const failed = e.steps.find((s) => !s.ok)
  const steps: StepCounts = {
    total: e.planned,
    passed,
    notRun: Math.max(0, e.planned - e.steps.length),
    ...(failed ? { firstFailure: displayLabel(failed.step, 80) } : {}),
    ...(e.loadError ? { loadError: displayLabel(e.loadError, 80) } : {})
  }
  if (e.loadError || failed || steps.notRun > 0) return { ok: false, steps }
  let lastAction = -1
  let lastAssertion = -1
  e.steps.forEach((s, i) => {
    if (ACTIONS.has(s.action)) lastAction = i
    if (ASSERTIONS.has(s.action)) lastAssertion = i
  })
  return lastAssertion > lastAction ? { ok: true, steps } : { ok: null, unknown: 'not-asserted', steps }
}

/** The kinds a later file change can make out of date: they check the code. */
const CHECKS_CODE: ReadonlySet<CheckKind> = new Set(['test', 'typecheck', 'build', 'lint', 'http', 'browser', 'verify'])

/**
 * What one run did, as the loop and its tools saw it. Lives on the run's state for
 * as long as the run does; only the receipt it produces is persisted.
 */
export class EvidenceLedger {
  private seq = 0
  /** Checks keyed by kind + label; re-inserted on each run so the order is most recent last. */
  private readonly checks = new Map<string, { record: CheckRecord; runs: number }>()
  private otherCommands = 0
  private readonly files = new Set<string>()
  private lastWriteSeq = -1

  /** Record what a tool reported. Commands must already be redacted. `by` names a subagent. */
  record(e: EvidenceDraft, by?: string): void {
    if (e.kind === 'browser') this.recordBrowser(e, by)
    else this.recordShell(e, by)
  }

  /** Record a shell command run_shell executed. `command` must already be redacted. */
  recordShell(e: ShellEvidence, by?: string): void {
    const cls = classifyCommand(e.command, e.background)
    if (!cls.kind) {
      this.otherCommands++
      return
    }
    const label = displayLabel(e.command)
    const base = { kind: cls.kind, label, ...(by ? { by: displayLabel(by, 60) } : {}) }
    if (e.background) {
      this.put({
        ...base,
        ok: null,
        unknown: 'background',
        background: true,
        seq: this.seq++,
        ...(e.shellId ? { pending: { shellId: e.shellId, command: e.command, cls } } : {})
      })
      return
    }
    const counts = cls.kind === 'test' ? parseTestCounts(e.output) : undefined
    const { ok, unknown } = outcome(e, cls, counts)
    this.put({
      ...base,
      ok,
      ...(unknown ? { unknown } : {}),
      exitCode: e.exitCode,
      ...(e.timedOut ? { timedOut: true } : {}),
      ...(counts ? { counts } : {}),
      ...(e.blocked && ok !== true ? { blocked: e.blocked } : {}),
      seq: this.seq++
    })
  }

  /** Record a page view_localhost loaded and the steps it ran there. */
  recordBrowser(e: BrowserEvidence, by?: string): void {
    const { ok, unknown, steps } = browserOutcome(e)
    this.put({
      kind: 'browser',
      label: pageLabel(e.url),
      ok,
      ...(unknown ? { unknown } : {}),
      steps,
      ...(by ? { by: displayLabel(by, 60) } : {}),
      seq: this.seq++
    })
  }

  /** Record the user's verify-on-stop command, which Houston runs itself. Already redacted. */
  recordGate(command: string, passed: boolean): void {
    this.put({
      kind: classifyCommand(command).kind ?? 'verify',
      label: displayLabel(command),
      ok: passed,
      gate: true,
      seq: this.seq++
    })
  }

  /**
   * Record paths a write tool changed, as the tool was given them. Shown relative to
   * the workspace, so `./src/a.ts` and an absolute path to it count as one file; a
   * path in another root keeps its full form.
   */
  recordFiles(workspace: string, paths: string[]): void {
    let any = false
    for (const p of paths) {
      if (!p) continue
      const rel = relative(workspace, resolve(workspace, p))
      const shown = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : p
      this.files.add(shown.replace(CONTROL_CHARS, ''))
      any = true
    }
    if (any) this.lastWriteSeq = this.seq++
  }

  /**
   * Whether a check of `kind` passed this turn ('any': a check of the code of any kind).
   * An HTTP request whose status wasn't checked counts: it was made, which is what a
   * "curl the API" todo claims. A browser check counts only if it checked the page.
   */
  passed(kind: RequiredCheck): boolean {
    for (const { record } of this.checks.values()) {
      const ok = record.ok === true || (record.kind === 'http' && record.unknown === 'http-status-unchecked')
      if (!ok) continue
      if (kind === 'any' ? CHECKS_CODE.has(record.kind) : record.kind === kind) return true
    }
    return false
  }

  private put(record: CheckRecord): void {
    const key = `${record.kind}\u0000${record.label}`
    const prior = this.checks.get(key)
    this.checks.delete(key)
    this.checks.set(key, { record, runs: (prior?.runs ?? 0) + 1 })
  }

  /**
   * The receipt for the run so far, or null when there is nothing worth showing: no
   * command of a receipt kind ran and no file changed (a question answered, a
   * `git log` read). `peek` reads a background shell's state from the registry, so a
   * dev server still up or a backgrounded test run that finished is reported as such.
   */
  receipt(
    peek?: (shellId: string) => ShellPeek | undefined,
    extra: { todoGaps?: string[] } = {}
  ): TurnReceipt | null {
    const todoGaps = (extra.todoGaps ?? []).slice(0, 10).map((g) => displayLabel(g, 120))
    if (this.checks.size === 0 && this.files.size === 0 && todoGaps.length === 0) return null
    const all = [...this.checks.values()].map(({ record, runs }): ReceiptCheck => {
      const { seq, pending: _pending, ...check } = this.settle(record, peek)
      return {
        ...check,
        ...(CHECKS_CODE.has(check.kind) && seq < this.lastWriteSeq ? { beforeLastWrite: true as const } : {}),
        runs
      }
    })
    const checks = all.slice(-RECEIPT_MAX_CHECKS)
    const files = [...this.files]
    return {
      v: 1,
      checks,
      ...(all.length > checks.length ? { checksOmitted: all.length - checks.length } : {}),
      otherCommands: this.otherCommands,
      filesChanged: files.slice(0, RECEIPT_MAX_FILES),
      filesChangedCount: files.length,
      ...(todoGaps.length ? { todoGaps } : {})
    }
  }

  /** A background record as of now: still running, or finished with an exit code. */
  private settle(record: CheckRecord, peek?: (shellId: string) => ShellPeek | undefined): CheckRecord {
    if (!record.pending || !peek) return record
    const state = peek(record.pending.shellId)
    if (!state) return record
    if (state.running) return { ...record, unknown: 'still-running' }
    const { unknown: _unknown, ...rest } = record
    const counts = record.kind === 'test' ? parseTestCounts(state.output) : undefined
    const settled = outcome({ exitCode: state.exitCode, timedOut: false }, record.pending.cls, counts)
    return {
      ...rest,
      ok: settled.ok,
      ...(settled.unknown ? { unknown: settled.unknown } : {}),
      exitCode: state.exitCode,
      ...(counts ? { counts } : {})
    }
  }
}
