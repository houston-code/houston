/**
 * What a turn's edits did to the project's tests.
 *
 * The cheapest way for an agent to turn a red suite green is to change the suite: delete
 * the failing test, skip it, drop its assertion, or tell the runner to stop looking. The
 * prompt tells the model not to; this module is how Houston notices when it did anyway.
 * Given each file the turn changed, as it stood before the turn and as it stands now, it
 * reports the edits that loosen a test, tuned to stay quiet on ordinary test work: a new
 * test file, added assertions, a test moved to another file with its assertions, a skip
 * that was already there.
 *
 * Pure: the loop reads the snapshots (checkpoints.ts) and the receipt carries the result.
 */
import type { TestEdit } from '@shared/evidence'

/** One file a turn changed. `null` content: it didn't exist (before) or was deleted (after). */
export interface FileChange {
  path: string
  before: string | null
  after: string | null
}

/**
 * A file that is test code: `*.test.*`/`*.spec.*`, `test_*.py`, `*_test.py`/`*_test.go`,
 * `*_spec.rb`, or code under a `__tests__/`, `tests/`, `test/`, or `spec/` directory.
 * Aligned with evidence.ts's TEST_SCRIPT, widened to the languages a test edit is made in.
 */
const TEST_FILE =
  /(^|\/)(__tests__|tests?|specs?)\/(.*\/)?[^/]+\.(m?[jt]sx?|cjs|py|go|rs|rb|php|java|kt|cs|swift)$|[._-](test|spec)\.(m?[jt]sx?|cjs)$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|_spec\.rb$/i
/** JVM/.NET/Swift test classes (`FooTest.java`). Case-sensitive, so `latest.java` isn't one. */
const CLASS_TEST_FILE = /(^|\/)[^/]*(Test|Tests|Spec)\.(java|kt|cs|swift)$/

function norm(path: string): string {
  return path.replace(/\\/g, '/')
}

function basename(path: string): string {
  return norm(path).split('/').pop() ?? path
}

export function isTestPath(path: string): boolean {
  const p = norm(path)
  return TEST_FILE.test(p) || CLASS_TEST_FILE.test(p)
}

/** JS runner configs read whole: everything in them is about which tests run. */
const JS_TEST_CONFIG = /^((vitest|jest|playwright|cypress)\.config|vitest\.workspace)\.[cm]?[jt]s$|^jest\.config\.json$|^\.mocharc(\.[a-z]+)?$/
/** A vite config, read only inside its `test: { ... }` block (the rest is the app's build). */
const VITE_CONFIG = /^vite\.config\.[cm]?[jt]s$/
/** Python configs, read only inside their pytest section. */
const PY_CONFIG: Record<string, RegExp> = {
  'pytest.ini': /^\[pytest\]/,
  'pyproject.toml': /^\[tool\.pytest(\.ini_options)?\]/,
  'setup.cfg': /^\[tool:pytest\]/,
  'tox.ini': /^\[pytest\]/
}

/** Whether a change to this file could change which tests run or whether they can fail. */
export function isTestConfigPath(path: string): boolean {
  const b = basename(path)
  return b === 'package.json' || JS_TEST_CONFIG.test(b) || VITE_CONFIG.test(b) || b in PY_CONFIG
}

/** The files worth reading for {@link detectTestEdits}. */
export function isTestRelevantPath(path: string): boolean {
  return isTestPath(path) || isTestConfigPath(path)
}

const SKIP_MARKER =
  /\.(skip|skipIf|todo|fixme)\s*\(|\b(xit|xdescribe|xtest|xcontext)\s*\(|@pytest\.mark\.(skip|skipif|xfail)\b|\bpytest\.skip\s*\(|@unittest\.(skip|skipIf|skipUnless|expectedFailure)\b|\bt\.Skip(Now|f)?\s*\(|#\[ignore\b/
const FOCUS_MARKER = /\.only\s*\(|\b(fit|fdescribe)\s*\(/
const ASSERTION =
  /\bassert\w*!?\s*[(.\s]|\bexpect\s*\(|\.should\b|\bt\.(Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(|\brequire\.\w+\s*\(/g
const TEST_CASE = /\b[xf]?(it|test)(\.\w+)*\s*\(|\bdef test_|\bfunc Test\w*\s*\(|#\[test\]/g

/**
 * The file's lines that are code, not comments: a commented-out assertion is a removed
 * one, and a commented-out `.skip` skips nothing. Whole-line comments only.
 */
function codeLines(text: string | null): string[] {
  if (text === null) return []
  return text.split(/\r?\n/).filter((l) => {
    const t = l.trimStart()
    return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || (t.startsWith('#') && !t.startsWith('#[')))
  })
}

function countAll(lines: string[], re: RegExp): number {
  let n = 0
  for (const l of lines) n += l.match(new RegExp(re.source, 'g'))?.length ?? 0
  return n
}

interface Stats {
  asserts: number
  cases: number
  skips: number
  focus: number
}

function stats(lines: string[]): Stats {
  return {
    asserts: countAll(lines, ASSERTION),
    cases: countAll(lines, TEST_CASE),
    skips: countAll(lines, SKIP_MARKER),
    focus: countAll(lines, FOCUS_MARKER)
  }
}

function clip(text: string, max = 80): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > max ? `${t.slice(0, max - 3)}...` : t
}

/** The first line matching `re` that the file didn't have before, for the edit's detail. */
function firstNewLine(before: string[], after: string[], re: RegExp): string | undefined {
  const had = new Map<string, number>()
  for (const l of before) had.set(l.trim(), (had.get(l.trim()) ?? 0) + 1)
  for (const l of after) {
    const k = l.trim()
    const n = had.get(k) ?? 0
    if (n > 0) {
      had.set(k, n - 1)
      continue
    }
    if (re.test(l)) return clip(l)
  }
  return undefined
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * The test edits among a turn's file changes. Test files are weighed together, so a
 * test moved from one file to another (its assertions and markers with it) reads as no
 * change; a drop or a new marker is reported against the file it happened in.
 */
export function detectTestEdits(files: FileChange[]): TestEdit[] {
  const edits: TestEdit[] = []
  const tests = files
    .filter((f) => isTestPath(f.path) && (f.before !== null || f.after !== null))
    .map((f) => {
      const before = codeLines(f.before)
      const after = codeLines(f.after)
      return { f, before, after, was: stats(before), now: stats(after) }
    })
  const total = (pick: (t: (typeof tests)[number]) => Stats, key: keyof Stats): number =>
    tests.reduce((n, t) => n + pick(t)[key], 0)
  const dropped = (key: keyof Stats): boolean => total((t) => t.now, key) < total((t) => t.was, key)
  const rose = (key: keyof Stats): boolean => total((t) => t.now, key) > total((t) => t.was, key)
  // A new test file is new work, except as the other half of a move: then a marker the
  // moved test gained there counts.
  const moved = tests.some((t) => t.f.before !== null && t.f.after === null)

  for (const t of tests) {
    const { f, was, now } = t
    if (f.after === null) {
      if (f.before !== null && (was.asserts > 0 || was.cases > 0) && (dropped('asserts') || dropped('cases'))) {
        const what = was.asserts > 0 ? plural(was.asserts, 'assertion') : plural(was.cases, 'test')
        edits.push({ path: f.path, kind: 'deleted', detail: `deleted, with ${what}` })
      }
      continue
    }
    if (f.before === null && !moved) continue
    if (now.skips > was.skips && rose('skips')) {
      const line = firstNewLine(t.before, t.after, SKIP_MARKER)
      edits.push({ path: f.path, kind: 'skip', detail: line ? `added ${line}` : `${plural(now.skips - was.skips, 'skip')} added` })
    }
    if (now.focus > was.focus && rose('focus')) {
      const line = firstNewLine(t.before, t.after, FOCUS_MARKER)
      edits.push({ path: f.path, kind: 'focus', detail: line ? `added ${line}` : 'focus marker added' })
    }
    if (f.before !== null && now.asserts < was.asserts && dropped('asserts')) {
      edits.push({ path: f.path, kind: 'asserts', detail: `${plural(now.asserts, 'assertion')}, down from ${was.asserts}` })
    }
  }

  for (const f of files) {
    if (f.before === null || f.after === null || isTestPath(f.path)) continue
    const b = basename(f.path)
    if (b === 'package.json') edits.push(...packageJsonEdits(f.path, f.before, f.after))
    else if (JS_TEST_CONFIG.test(b)) edits.push(...configEdits(f.path, f.before, f.after, 'js'))
    else if (VITE_CONFIG.test(b)) {
      edits.push(...configEdits(f.path, viteTestBlock(f.before), viteTestBlock(f.after), 'js'))
    } else if (b in PY_CONFIG) {
      const section = PY_CONFIG[b]
      edits.push(...configEdits(f.path, pySection(f.before, section), pySection(f.after, section), 'ini'))
    }
  }
  return edits
}

/** What makes a test script pass whatever its tests do, or run fewer of them. */
const SCRIPT_LOOSENERS: { re: RegExp; text: string }[] = [
  { re: /\|\|\s*(true|:|exit\s+0)\b/, text: 'an exit status that is always 0' },
  { re: /;\s*(exit\s+0|true)\s*$/, text: 'an exit status that is always 0' },
  { re: /--passWithNoTests|--pass-with-no-tests/, text: '--passWithNoTests' },
  { re: /--testPathIgnorePatterns|--exclude\b|--ignore\b|--deselect\b|(^|\s)-k\s/, text: 'a filter that leaves tests out' }
]

function packageJsonEdits(path: string, before: string, after: string): TestEdit[] {
  let was: { scripts?: Record<string, unknown>; jest?: unknown }
  let now: { scripts?: Record<string, unknown>; jest?: unknown }
  try {
    was = JSON.parse(before)
    now = JSON.parse(after)
  } catch {
    return []
  }
  if (!was || !now || typeof was !== 'object' || typeof now !== 'object') return []
  const edits: TestEdit[] = []
  const wasScripts = was.scripts && typeof was.scripts === 'object' ? was.scripts : {}
  const nowScripts = now.scripts && typeof now.scripts === 'object' ? now.scripts : {}
  for (const [name, script] of Object.entries(wasScripts)) {
    if (!/^test([:-].*)?$/.test(name) || typeof script !== 'string') continue
    const next = nowScripts[name]
    if (next === undefined) {
      edits.push({ path, kind: 'script', detail: `removed the "${clip(name, 40)}" script` })
      continue
    }
    if (typeof next !== 'string' || next === script) continue
    const gained = SCRIPT_LOOSENERS.find((l) => l.re.test(next) && !l.re.test(script))
    if (gained) {
      edits.push({ path, kind: 'script', detail: `"${clip(name, 40)}" gained ${gained.text}: ${clip(next)}` })
    } else if (/^\s*(echo\b|true\b|exit\s+0\b|:\s*$)/.test(next) && !/^\s*(echo\b|true\b|exit\s+0\b)/.test(script)) {
      edits.push({ path, kind: 'script', detail: `"${clip(name, 40)}" no longer runs tests: ${clip(next)}` })
    }
  }
  const jestKeys = (j: unknown): string =>
    j && typeof j === 'object'
      ? JSON.stringify(
          Object.fromEntries(Object.entries(j as Record<string, unknown>).filter(([k]) => JS_KEY.test(k)))
        )
      : '{}'
  if (jestKeys(was.jest) !== jestKeys(now.jest)) {
    edits.push({ path, kind: 'config', detail: 'changed which tests jest runs' })
  }
  return edits
}

/** JS runner config keys that decide which tests run or whether an empty run passes. */
const JS_KEY =
  /^(include|exclude|testMatch|testRegex|testPathIgnorePatterns|testIgnore|testDir|testNamePattern|passWithNoTests|grep|grepInvert|spec|ignore|roots)$/
const JS_KEY_LINE = new RegExp(`(^|[\\s{,])['"]?(${JS_KEY.source.slice(2, -2)})['"]?\\s*:`)
/** Pytest ini keys that decide which tests run. */
const PY_KEY = /^(addopts|testpaths|python_files|python_classes|python_functions|norecursedirs)$/
const PY_KEY_LINE = new RegExp(`^\\s*(${PY_KEY.source.slice(2, -2)})\\s*=`)

/** The `test: { ... }` block of a vite config, or '' when it has none. */
function viteTestBlock(text: string): string {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /(^|[\s{,])test\s*:\s*\{/.test(l))
  if (start === -1) return ''
  let depth = 0
  const out: string[] = []
  for (let i = start; i < lines.length; i++) {
    out.push(lines[i])
    depth += bracketDelta(lines[i])
    if (depth <= 0) break
  }
  return out.join('\n')
}

/** The lines of an ini/toml section whose header matches `header`, through the next header. */
function pySection(text: string, header: RegExp): string {
  const out: string[] = []
  let inside = false
  for (const l of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(l)) inside = header.test(l.trim())
    else if (inside) out.push(l)
  }
  return out.join('\n')
}

function bracketDelta(line: string): number {
  return (line.match(/[[{(]/g)?.length ?? 0) - (line.match(/[\]})]/g)?.length ?? 0)
}

/**
 * Each test-selection key's value, as written: the key's line plus what follows while a
 * bracket it opened is still open (JS), or while lines stay indented under it (ini).
 */
function keyValues(text: string, mode: 'js' | 'ini'): Map<string, string> {
  const lines = codeLines(text)
  const values = new Map<string, string>()
  const keyLine = mode === 'js' ? JS_KEY_LINE : PY_KEY_LINE
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(keyLine)
    if (!m) continue
    const key = mode === 'js' ? m[2] : m[1]
    const parts = [lines[i]]
    if (mode === 'js') {
      let depth = bracketDelta(lines[i])
      for (let j = i + 1; depth > 0 && j < lines.length && j < i + 40; j++) {
        parts.push(lines[j])
        depth += bracketDelta(lines[j])
      }
    } else {
      for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) parts.push(lines[j])
    }
    const value = parts.join(' ').replace(/\s+/g, '')
    values.set(key, values.has(key) ? `${values.get(key)}|${value}` : value)
  }
  return values
}

function configEdits(path: string, before: string, after: string, mode: 'js' | 'ini'): TestEdit[] {
  const was = keyValues(before, mode)
  const now = keyValues(after, mode)
  const changed = [...new Set([...was.keys(), ...now.keys()])].filter((k) => was.get(k) !== now.get(k))
  if (!changed.length) return []
  return [{ path, kind: 'config', detail: `changed ${changed.slice(0, 4).join(', ')}` }]
}

/**
 * The note the loop sends the model at a natural stop when the turn loosened a test,
 * once per turn. It asks, rather than tells: some of these are the right change (a test
 * for removed behavior, a flaky test the user asked to skip), and the model is told to
 * say so in its reply rather than to undo them blindly.
 */
export function testEditsNote(edits: TestEdit[]): string {
  const shown = edits.slice(0, 8).map((e) => `- ${e.path}: ${e.detail}`)
  const more = edits.length > shown.length ? `\n- and ${edits.length - shown.length} more` : ''
  return (
    'Before you finish: this turn changed tests in ways that can make a failing suite pass ' +
    'without fixing anything.\n' +
    `${shown.join('\n')}${more}\n` +
    'If a change was a shortcut around a failure, restore the test and fix the code instead. ' +
    'If it is the right change (the behavior was removed on purpose, or the user asked for it), ' +
    'say so plainly in your reply, naming each test you changed and why. These edits are listed ' +
    "on the turn's receipt either way."
  )
}
