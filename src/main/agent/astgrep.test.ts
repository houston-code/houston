import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  resolveAstGrep,
  parseAstGrepStream,
  runAstGrep,
  searchStructural,
  stripAstGrepNoise,
  astGrepError
} from './astgrep'

/** The two-line benign notice the @ast-grep/cli npm shim prints when postinstall didn't run. */
const POSTINSTALL_WARNING =
  '[warn] postinstall script did not run; falling back to runtime binary resolution.\n' +
  'Enable postinstall to avoid the per-invocation overhead.'

/** Build `--json=stream` output: one JSON object per line. */
const stream = (objs: object[]): string => objs.map((o) => JSON.stringify(o)).join('\n') + '\n'

describe('resolveAstGrep', () => {
  it('prefers the HOUSTON_AST_GREP override when it exists', () => {
    const exists = (p: string): boolean => p === '/custom/ast-grep'
    expect(
      resolveAstGrep({ env: { HOUSTON_AST_GREP: '/custom/ast-grep', PATH: '' }, exists, candidates: [] })
    ).toBe('/custom/ast-grep')
  })

  it('finds ast-grep on PATH', () => {
    const exists = (p: string): boolean => p === '/usr/local/bin/ast-grep'
    expect(resolveAstGrep({ env: { PATH: '/nope:/usr/local/bin' }, exists, candidates: [] })).toBe(
      '/usr/local/bin/ast-grep'
    )
  })

  it('looks for ast-grep.exe on PATH on Windows', () => {
    const dir = 'C:\\tools'
    const exists = (p: string): boolean => p === join(dir, 'ast-grep.exe')
    expect(resolveAstGrep({ platform: 'win32', env: { PATH: dir }, exists, candidates: [] })).toBe(
      join(dir, 'ast-grep.exe')
    )
  })

  it('falls back to a known candidate dir', () => {
    const exists = (p: string): boolean => p === '/opt/homebrew/bin/ast-grep'
    expect(
      resolveAstGrep({ env: { PATH: '' }, exists, candidates: ['/opt/homebrew/bin/ast-grep'] })
    ).toBe('/opt/homebrew/bin/ast-grep')
  })

  it('returns null when nothing is found', () => {
    expect(resolveAstGrep({ env: { PATH: '/nope' }, exists: () => false, candidates: [] })).toBeNull()
  })
})

describe('parseAstGrepStream', () => {
  it('formats stream JSON into 1-based path:line:col: text entries', () => {
    const out = stream([
      { file: 'src/a.ts', text: 'console.log(x)', range: { start: { line: 4, column: 2 } } },
      { file: 'src/b.ts', text: 'console.log(y)', range: { start: { line: 0, column: 0 } } }
    ])
    expect(parseAstGrepStream(out, 100)).toEqual([
      'src/a.ts:5:3: console.log(x)',
      'src/b.ts:1:1: console.log(y)'
    ])
  })

  it('uses only the first line of a multi-line match and trims it', () => {
    const out = stream([
      { file: 'a.ts', text: '  function f() {\n  return 1\n}', range: { start: { line: 0, column: 0 } } }
    ])
    expect(parseAstGrepStream(out, 100)).toEqual(['a.ts:1:1: function f() {'])
  })

  it('respects the max limit', () => {
    const out = stream(
      Array.from({ length: 5 }, (_, i) => ({ file: `f${i}.ts`, text: 'x', range: { start: { line: 0, column: 0 } } }))
    )
    expect(parseAstGrepStream(out, 2)).toHaveLength(2)
  })

  it('keeps complete lines and skips a truncated trailing line (the output-cap case)', () => {
    const full = stream([
      { file: 'a.ts', text: 'one', range: { start: { line: 0, column: 0 } } },
      { file: 'b.ts', text: 'two', range: { start: { line: 1, column: 0 } } }
    ])
    // Simulate the 5MB cap cutting the stream mid-way through a third object.
    const truncated = full + '{"file":"c.ts","text":"thr'
    expect(parseAstGrepStream(truncated, 100)).toEqual(['a.ts:1:1: one', 'b.ts:2:1: two'])
  })

  it('returns [] for empty or all-garbled input', () => {
    expect(parseAstGrepStream('', 100)).toEqual([])
    expect(parseAstGrepStream('not json\n', 100)).toEqual([])
    expect(parseAstGrepStream('\n\n', 100)).toEqual([])
  })
})

describe('stripAstGrepNoise', () => {
  it('drops the benign postinstall notice entirely', () => {
    expect(stripAstGrepNoise(POSTINSTALL_WARNING)).toBe('')
  })

  it('keeps a real diagnostic while dropping the postinstall notice', () => {
    const stderr = POSTINSTALL_WARNING + "\nerror: invalid value 'not-a-language' for '--lang <LANG>'"
    expect(stripAstGrepNoise(stderr)).toBe("error: invalid value 'not-a-language' for '--lang <LANG>'")
  })

  it('keeps an ERROR: line (missing path) while dropping the notice', () => {
    const stderr = POSTINSTALL_WARNING + '\nERROR: does-not-exist: No such file or directory (os error 2)'
    expect(stripAstGrepNoise(stderr)).toBe('ERROR: does-not-exist: No such file or directory (os error 2)')
  })

  it('leaves stderr with no benign lines unchanged', () => {
    expect(stripAstGrepNoise('error: boom')).toBe('error: boom')
    expect(stripAstGrepNoise('')).toBe('')
  })
})

describe('astGrepError', () => {
  // The regression: a successful-but-empty search (exit 1) whose only stderr is
  // the shim's postinstall notice must NOT be treated as an error — otherwise
  // searchStructural throws instead of returning "No matches found.".
  it('does not flag a no-match run whose stderr is only the postinstall notice', () => {
    expect(astGrepError([], 1, POSTINSTALL_WARNING)).toBeUndefined()
  })

  it('does not flag a run that produced matches, warning notwithstanding', () => {
    expect(astGrepError(['a.ts:1:1: x'], 0, POSTINSTALL_WARNING)).toBeUndefined()
    // Even on a (hypothetical) non-zero exit, matches present means success.
    expect(astGrepError(['a.ts:1:1: x'], 1, POSTINSTALL_WARNING)).toBeUndefined()
  })

  it('does not flag a clean no-match run (exit 1, empty stderr)', () => {
    expect(astGrepError([], 1, '')).toBeUndefined()
  })

  it('flags a real failure, surfacing only the diagnostic (notice stripped)', () => {
    const stderr = POSTINSTALL_WARNING + "\nerror: invalid value 'not-a-language' for '--lang <LANG>'"
    expect(astGrepError([], 2, stderr)).toBe("error: invalid value 'not-a-language' for '--lang <LANG>'")
  })

  it('flags a missing-path failure', () => {
    const stderr = POSTINSTALL_WARNING + '\nERROR: does-not-exist: No such file or directory (os error 2)'
    expect(astGrepError([], 1, stderr)).toBe('ERROR: does-not-exist: No such file or directory (os error 2)')
  })
})

describe('searchStructural (validation)', () => {
  it('requires a pattern', async () => {
    await expect(
      searchStructural({ pattern: '', lang: 'ts', workspace: '/w', searchRel: '.', binPath: '/x', max: 100 })
    ).rejects.toThrow(/pattern is required/)
  })

  it('requires a lang', async () => {
    await expect(
      searchStructural({ pattern: 'foo($A)', lang: '', workspace: '/w', searchRel: '.', binPath: '/x', max: 100 })
    ).rejects.toThrow(/lang is required/)
  })

  it('errors clearly when no ast-grep binary is available', async () => {
    await expect(
      searchStructural({ pattern: 'foo($A)', lang: 'ts', workspace: '/w', searchRel: '.', binPath: null, max: 100 })
    ).rejects.toThrow(/ast-grep is not available/)
  })
})

// Integration tests against the real ast-grep binary (the dev/build dependency).
// Skipped when the binary can't be located (e.g. an unsupported platform).
function findAstGrep(): string | null {
  const candidates = [
    resolve(process.cwd(), 'node_modules/@ast-grep/cli/ast-grep'),
    resolve(process.cwd(), 'node_modules/.bin/ast-grep')
  ]
  return candidates.find((p) => existsSync(p)) ?? resolveAstGrep()
}

// Each test spawns the real binary — and on a checkout where @ast-grep/cli's
// postinstall didn't run, that path is the node shim (node startup + runtime
// binary resolution per invocation). Give every test room under full-suite
// parallelism / contended CI runners so none can flake on the default 5s
// timeout (same rationale as git.test.ts).
describe('runAstGrep / searchStructural (ast-grep binary)', { timeout: 30_000 }, () => {
  const ag = findAstGrep()
  let workspace: string

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'houston-ag-')))
    mkdirSync(join(workspace, 'src'))
    writeFileSync(
      join(workspace, 'src', 'app.ts'),
      'function add(a, b) { return a + b }\nconsole.log(add(1, 2))\nconst x = 3\n'
    )
    // A skip-dir file that should be excluded from results.
    mkdirSync(join(workspace, 'node_modules'))
    writeFileSync(join(workspace, 'node_modules', 'dep.ts'), 'console.log(999)\n')
  })

  afterEach(() => rmSync(workspace, { recursive: true, force: true }))

  it.skipIf(!ag)('finds a structural match and excludes skip dirs', async () => {
    const out = await searchStructural({
      pattern: 'console.log($A)',
      lang: 'ts',
      workspace,
      searchRel: '.',
      binPath: ag,
      max: 100
    })
    expect(out).toContain('src/app.ts:2:')
    expect(out).not.toContain('node_modules')
  })

  it.skipIf(!ag)('returns "No matches found." when nothing matches', async () => {
    const out = await searchStructural({
      pattern: 'while ($C) { $$$ }',
      lang: 'ts',
      workspace,
      searchRel: '.',
      binPath: ag,
      max: 100
    })
    expect(out).toBe('No matches found.')
  })

  it.skipIf(!ag)('surfaces an invalid pattern/language as an error', async () => {
    const res = await runAstGrep({
      binPath: ag as string,
      pattern: 'console.log($A)',
      lang: 'not-a-language',
      cwd: workspace,
      searchRel: '.',
      max: 100
    })
    expect(res.error).toBeTruthy()
  })

  // ast-grep exits non-zero for a missing path but writes `[]`-ish output; make
  // sure that surfaces as an error rather than a misleading "No matches found."
  it.skipIf(!ag)('surfaces a non-existent search path as an error', async () => {
    const res = await runAstGrep({
      binPath: ag as string,
      pattern: 'console.log($A)',
      lang: 'ts',
      cwd: workspace,
      searchRel: 'does-not-exist',
      max: 100
    })
    expect(res.error).toBeTruthy()
  })

  // Scope parity with search_files: both ignore .gitignore (search everything
  // except SKIP_DIRS), so the two search tools return a consistent file set.
  it.skipIf(!ag)('searches .gitignored files (parity with search_files)', async () => {
    writeFileSync(join(workspace, '.gitignore'), 'generated.ts\n')
    writeFileSync(join(workspace, 'generated.ts'), 'console.log(7)\n')
    const out = await searchStructural({
      pattern: 'console.log($A)',
      lang: 'ts',
      workspace,
      searchRel: '.',
      binPath: ag,
      max: 100
    })
    expect(out).toContain('generated.ts:1:')
  })
})
