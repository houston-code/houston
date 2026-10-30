import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  formatReceiptLines,
  receiptSummary,
  RECEIPT_LABEL_MAX,
  RECEIPT_MAX_CHECKS,
  RECEIPT_MAX_DELEGATED,
  RECEIPT_MAX_FILES
} from '@shared/evidence'
import { classifyCommand, EvidenceLedger, parseTestCounts, type BrowserEvidence, type ShellEvidence } from './evidence'

const shell = (command: string, over: Partial<ShellEvidence> = {}): ShellEvidence => ({
  kind: 'shell',
  command,
  background: false,
  exitCode: 0,
  timedOut: false,
  output: '',
  ...over
})

describe('classifyCommand', () => {
  it.each([
    // test runners, directly and through wrappers
    ['pytest', 'test'],
    ['pytest -q tests/test_api.py', 'test'],
    ['python -m pytest -x', 'test'],
    ['python3 -m unittest discover', 'test'],
    ['uv run pytest', 'test'],
    ['poetry run pytest -k api', 'test'],
    ['npm test', 'test'],
    ['npm t', 'test'],
    ['npm run test:unit', 'test'],
    ['yarn test --watch=false', 'test'],
    ['pnpm test', 'test'],
    ['bun test', 'test'],
    ['npx vitest run', 'test'],
    ['./node_modules/.bin/jest --ci', 'test'],
    ['node --test', 'test'],
    ['node test.mjs', 'test'],
    ['node tests/api.js', 'test'],
    ['node src/app.test.js', 'test'],
    ['python test_app.py', 'test'],
    ['python manage.py test', 'test'],
    ['go test ./...', 'test'],
    ['cargo test', 'test'],
    ['make test', 'test'],
    ['CI=1 npm test', 'test'],
    // typecheck, build, lint
    ['npx tsc --noEmit', 'typecheck'],
    ['npm run typecheck', 'typecheck'],
    ['mypy app', 'typecheck'],
    ['cargo check', 'typecheck'],
    ['npm run build', 'build'],
    ['yarn build', 'build'],
    ['vite build', 'build'],
    ['tsc -p .', 'build'],
    ['go build ./...', 'build'],
    ['make', 'build'],
    ['npm run lint', 'lint'],
    ['ruff check .', 'lint'],
    ['eslint src', 'lint'],
    // installs and scaffolders
    ['pip install -r requirements.txt', 'install'],
    ['python -m pip install fastapi', 'install'],
    ['npm install', 'install'],
    ['npm ci', 'install'],
    ['yarn', 'install'],
    ['npm create vite@latest frontend -- --template react', 'install'],
    ['npx create-react-app web', 'install'],
    ['uv sync', 'install'],
    // servers and local HTTP
    ['uvicorn main:app --port 8000', 'server'],
    ['npm run dev', 'server'],
    ['npm start', 'server'],
    ['python -m http.server 8080', 'server'],
    ['python manage.py runserver', 'server'],
    ['curl -s http://localhost:8000/todos', 'http'],
    ['curl -X POST 127.0.0.1:8000/todos -d "{}"', 'http']
  ])('%s is %s', (command, kind) => {
    expect(classifyCommand(command).kind).toBe(kind)
  })

  it.each([
    'ls -la',
    'git status',
    'cat package.json',
    'mkdir -p backend',
    'echo "npm test"',
    'npm init -y',
    'curl -s https://example.com/install.sh',
    'python app.py',
    'grep -rn pytest .'
  ])('%s is no particular kind', (command) => {
    expect(classifyCommand(command).kind).toBeNull()
  })

  it('names a compound command by its most telling part', () => {
    expect(classifyCommand('cd backend && pip install -r requirements.txt && pytest').kind).toBe('test')
    expect(classifyCommand('npm ci && npm run build').kind).toBe('build')
    expect(classifyCommand('cd frontend && npm install').kind).toBe('install')
    expect(classifyCommand('uvicorn main:app & sleep 2 && curl -s localhost:8000/').kind).toBe('http')
  })

  it('treats a background start of an unknown command as a server, and keeps a backgrounded test a test', () => {
    expect(classifyCommand('python app.py', true).kind).toBe('server')
    expect(classifyCommand('npm test', true).kind).toBe('test')
  })

  it('knows when a zero exit speaks for the test part', () => {
    expect(classifyCommand('pytest').exitAttributable).toBe(true)
    expect(classifyCommand('cd api && source .venv/bin/activate && pytest -q').exitAttributable).toBe(true)
    expect(classifyCommand('npm ci; npm test').exitAttributable).toBe(true)
    expect(classifyCommand('pytest && echo ok').exitAttributable).toBe(true)
    // The status that comes back belongs to a later command, or the test may not have run.
    expect(classifyCommand('pytest; echo done').exitAttributable).toBe(false)
    expect(classifyCommand('pytest | tail -5').exitAttributable).toBe(false)
    expect(classifyCommand('pytest || true').exitAttributable).toBe(false)
    expect(classifyCommand('false || pytest').exitAttributable).toBe(false)
    expect(classifyCommand('set -o pipefail; pytest | tail -5').exitAttributable).toBe(true)
    expect(classifyCommand('set -euo pipefail; pytest | tail -5').exitAttributable).toBe(true)
  })

  it('finds the line an echo of `$?` prints for the part before it', () => {
    expect(classifyCommand('node test.mjs; echo "exit=$?"').statusEcho).toMatchObject({ count: 1, nth: 0 })
    expect(classifyCommand('pytest -q; echo Exit code: $?; ls -la').statusEcho).toMatchObject({ count: 1, nth: 0 })
    // Every echo of the same line prints one; the test's is the one right after it.
    expect(
      classifyCommand('npm ci; echo "exit $?"; npm test; echo "exit $?"; npm view x; echo "exit $?"').statusEcho
    ).toMatchObject({ count: 3, nth: 1 })
    // A status the exit code already proves needs no echo.
    expect(classifyCommand('pytest && echo "exit=$?"').statusEcho).toBeUndefined()
  })

  it.each([
    ["pytest; echo 'exit=$?'", 'single quotes keep $? literal'],
    ['pytest; echo -n $?', 'a flag'],
    ['pytest; echo "$? in $PWD"', 'another expansion'],
    ['pytest; echo "exit=$?" > status.txt', 'a redirection'],
    ['pytest; echo "exit=$?" | true', 'its line is piped away'],
    ['pytest; echo "exit=$?" &', 'it runs in the background'],
    ['pytest; ls; echo $?', 'the echo is not right after the test'],
    ['pytest | tail -3; echo $?', "the status is tail's"],
    ['false || pytest; echo $?', 'the test may not have run'],
    ['pytest; echo done', 'no $?']
  ])('reads no echoed status from `%s` (%s)', (command) => {
    expect(classifyCommand(command).statusEcho).toBeUndefined()
  })

  it('does not split inside quotes, substitutions, or redirections', () => {
    expect(classifyCommand('echo "a && pytest"').kind).toBeNull()
    expect(classifyCommand('echo $(pytest --version)').kind).toBeNull()
    expect(classifyCommand('pytest 2>&1').exitAttributable).toBe(true)
    expect(classifyCommand('pytest > out.log 2>&1').exitAttributable).toBe(true)
    expect(classifyCommand('ls # && pytest').kind).toBeNull()
  })

  it('reads whether an HTTP request fails on an error status', () => {
    expect(classifyCommand('curl -s localhost:8000/').httpStatusChecked).toBe(false)
    expect(classifyCommand('curl -sf localhost:8000/').httpStatusChecked).toBe(true)
    expect(classifyCommand('curl --fail http://127.0.0.1:3000/api').httpStatusChecked).toBe(true)
    expect(classifyCommand('wget -qO- localhost:8000/').httpStatusChecked).toBe(true)
    expect(classifyCommand('http --check-status :8000/ localhost').httpStatusChecked).toBe(true)
  })
})

describe('parseTestCounts', () => {
  it('reads pytest summaries', () => {
    expect(parseTestCounts('...\n============ 1 failed, 11 passed, 2 skipped in 0.12s ============\n')).toEqual({
      passed: 11,
      failed: 1,
      skipped: 2
    })
    expect(parseTestCounts('............\n12 passed in 0.05s\n')).toEqual({ passed: 12, failed: 0 })
    expect(parseTestCounts('==== 2 errors in 0.30s ====')).toEqual({ passed: 0, failed: 2 })
    expect(parseTestCounts('==== no tests ran in 0.01s ====')).toEqual({ passed: 0, failed: 0 })
  })

  it('reads vitest and jest summaries', () => {
    expect(parseTestCounts(' Test Files  1 failed | 3 passed (4)\n      Tests  1 failed | 11 passed (12)\n')).toEqual({
      passed: 11,
      failed: 1
    })
    expect(parseTestCounts('      Tests  10 passed | 2 skipped (12)\n')).toEqual({ passed: 10, failed: 0, skipped: 2 })
    expect(parseTestCounts('Test Suites: 1 failed, 2 passed, 3 total\nTests:       1 failed, 11 passed, 12 total\n')).toEqual(
      { passed: 11, failed: 1 }
    )
  })

  it('reads a vitest summary through its colour codes', () => {
    const summary =
      '\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m47 passed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[33m2 skipped\x1b[39m\x1b[90m (49)\x1b[39m\n'
    expect(parseTestCounts(summary)).toEqual({ passed: 47, failed: 0, skipped: 2 })
  })

  it('reads a vitest run whose filter matched no files as passing nothing', () => {
    expect(parseTestCounts('\x1b[31mNo test files found, exiting with code 1\n\x1b[39m\nfilter: src/a.test.ts\n')).toEqual({
      passed: 0,
      failed: 0
    })
  })

  it('reads mocha, node:test, cargo, and unittest summaries', () => {
    expect(parseTestCounts('\n  12 passing (30ms)\n  1 failing\n  2 pending\n')).toEqual({ passed: 12, failed: 1, skipped: 2 })
    expect(parseTestCounts('# tests 3\n# pass 3\n# fail 0\n')).toEqual({ passed: 3, failed: 0 })
    expect(parseTestCounts('ℹ tests 4\nℹ pass 3\nℹ fail 1\nℹ skipped 0\n')).toEqual({ passed: 3, failed: 1 })
    expect(
      parseTestCounts(
        'test result: ok. 5 passed; 0 failed; 1 ignored; 0 measured\ntest result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured\n'
      )
    ).toEqual({ passed: 7, failed: 1, skipped: 1 })
    expect(parseTestCounts('----\nRan 12 tests in 0.003s\n\nOK\n')).toEqual({ passed: 12, failed: 0 })
    expect(parseTestCounts('Ran 12 tests in 0.003s\n\nFAILED (failures=1, errors=1, skipped=2)\n')).toEqual({
      passed: 8,
      failed: 2,
      skipped: 2
    })
  })

  it('stays fast on output crafted to look almost like a summary', () => {
    // A test can print anything. Patterns that could match the same text two ways
    // would backtrack exponentially here and stall the main process.
    const started = Date.now()
    expect(parseTestCounts(`      Tests  ${'1 a  | '.repeat(5000)}(x`)).toBeUndefined()
    expect(parseTestCounts(`==== ${'1 passed, '.repeat(5000)} in x`)).toBeUndefined()
    expect(parseTestCounts(`Tests: ${'1 failed, '.repeat(5000)}`)).toBeUndefined()
    expect(parseTestCounts(`${' '.repeat(50_000)}x`)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('reads only the end of a long log', () => {
    const summary = '12 passed in 0.05s'
    expect(parseTestCounts(`${summary}\n${'.'.repeat(100_000)}`)).toBeUndefined()
    expect(parseTestCounts(`${'.'.repeat(100_000)}\n${summary}`)).toEqual({ passed: 12, failed: 0 })
  })

  it('returns undefined when there is no summary to read', () => {
    expect(parseTestCounts('ModuleNotFoundError: No module named fastapi')).toBeUndefined()
    expect(parseTestCounts('')).toBeUndefined()
  })
})

describe('EvidenceLedger', () => {
  it('has no receipt for a turn that ran nothing of note and changed nothing', () => {
    const l = new EvidenceLedger()
    expect(l.receipt()).toBeNull()
    l.recordShell(shell('git log --oneline -5'))
    expect(l.receipt()).toBeNull()
  })

  it('records a test run by its exit code and its runner summary', () => {
    const l = new EvidenceLedger()
    l.recordShell(shell('pytest -q', { output: '12 passed in 0.05s' }))
    expect(l.receipt()?.checks).toEqual([
      { kind: 'test', label: 'pytest -q', ok: true, exitCode: 0, counts: { passed: 12, failed: 0 }, runs: 1 }
    ])
  })

  it('trusts the runner summary over a zero exit that belongs to something else', () => {
    const l = new EvidenceLedger()
    l.recordShell(shell('pytest; echo done', { output: '==== 1 failed, 11 passed in 0.1s ====\ndone' }))
    expect(l.receipt()?.checks[0]).toMatchObject({ ok: false, counts: { passed: 11, failed: 1 } })
  })

  it('reads a coloured vitest summary through a pipe that hides the exit code', () => {
    const l = new EvidenceLedger()
    const out = '\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m3 passed\x1b[39m\x1b[22m\x1b[90m (3)\x1b[39m\n'
    l.recordShell(shell('npx vitest run a.test.ts 2>&1 | tail -20', { output: out }))
    expect(l.receipt()?.checks[0]).toMatchObject({ ok: true, counts: { passed: 3, failed: 0 } })
    l.recordShell(shell('npx vitest run b.test.ts 2>&1 | head', { output: 'No test files found, exiting with code 1\n' }))
    expect(l.receipt()?.checks[1]).toMatchObject({ ok: false, counts: { passed: 0, failed: 0 } })
  })

  it('fails a run that found no tests, even on exit 0', () => {
    const l = new EvidenceLedger()
    l.recordShell(shell('npm test', { output: '      Tests  0 passed (0)' }))
    expect(l.receipt()?.checks[0].ok).toBe(false)
  })

  it('marks outcomes it cannot tell as unknown rather than passed', () => {
    const l = new EvidenceLedger()
    l.recordShell(shell('pytest | tail -3'))
    l.recordShell(shell('curl -s localhost:8000/todos'))
    l.recordShell(shell('npm run dev', { background: true, exitCode: null }))
    const checks = l.receipt()!.checks
    expect(checks.map((c) => [c.ok, c.unknown])).toEqual([
      [null, 'exit-not-attributable'],
      [null, 'http-status-unchecked'],
      [null, 'background']
    ])
    expect(checks[2]).not.toHaveProperty('exitCode')
  })

  describe('reads the status an `echo $?` printed for the test', () => {
    const run = (command: string, output: string, exitCode = 0) => {
      const l = new EvidenceLedger()
      l.recordShell(shell(command, { output, exitCode }))
      return l.receipt()!.checks[0]
    }

    it('passes a test that echoed 0 and fails one that echoed 1', () => {
      expect(run('node test.mjs; echo "exit=$?"', 'ok\nexit=0')).toEqual({
        kind: 'test',
        label: 'node test.mjs; echo "exit=$?"',
        ok: true,
        exitCode: 0,
        runs: 1
      })
      expect(run('node test.mjs; echo "exit=$?"', 'exit=1\nAssertionError [ERR_ASSERTION]')).toMatchObject({
        ok: false,
        exitCode: 1
      })
    })

    // The command's status is the last part's: git's 128 outside a repo is not the test's.
    it('reports the test by its own status, not a later command\'s', () => {
      const failed = run('node test.mjs; echo "exit=$?"; git status --short', 'exit=1\nfatal: not a git repository', 128)
      expect(failed).toMatchObject({ ok: false, exitCode: 1 })
      expect(run('node test.mjs; echo "exit=$?"; git status --short', 'ok\nexit=0\nfatal: not a git repository', 128)).toMatchObject({
        ok: true,
        exitCode: 0
      })
    })

    it('picks the test\'s line out of the echoes of the same line', () => {
      const cmd = 'node test.mjs; echo "exit $?"; npm view slug-suite-helpers; echo "exit $?"'
      expect(run(cmd, 'ok\nexit 0\nnpm error 404\nexit 1')).toMatchObject({ ok: true, exitCode: 0 })
      expect(run(cmd, 'exit 1\nexit 0')).toMatchObject({ ok: false, exitCode: 1 })
    })

    // A look-alike line the program printed, or an echo line missing from clamped
    // output, makes the position unknowable: unknown, never a guess.
    it('leaves it unknown when the lines do not add up', () => {
      expect(run('node test.mjs; echo "exit=$?"', 'exit=0\nexit=1')).toMatchObject({ ok: null, unknown: 'exit-not-attributable' })
      expect(run('node test.mjs; echo "exit=$?"', '... 2048 bytes truncated ...')).toMatchObject({ ok: null })
    })

    // A live run's test passed and echoed so, then a whole-disk search after it ran
    // out the clock. The timeout is the search's, not the test's.
    it('keeps a test that echoed its status apart from a later part that timed out', () => {
      const l = new EvidenceLedger()
      const cmd = 'node test.mjs; echo "exit=$?"; grep -rl slug-suite-helpers / --include=package.json'
      l.recordShell(shell(cmd, { output: 'ok\nexit=0', exitCode: null, timedOut: true }))
      l.recordShell(shell('node test.mjs; echo "exit=$?"; find / -name x', { output: 'exit=1', exitCode: null }))
      const [passed, failed] = l.receipt()!.checks
      expect(passed).toEqual({ kind: 'test', label: cmd, ok: true, exitCode: 0, runs: 1 })
      expect(failed).toMatchObject({ ok: false, exitCode: 1 })
      expect(failed).not.toHaveProperty('timedOut')
    })

    it('still counts the timeout against a test whose echo never printed', () => {
      const l = new EvidenceLedger()
      l.recordShell(shell('node test.mjs; echo "exit=$?"', { output: 'running...', exitCode: null, timedOut: true }))
      expect(l.receipt()!.checks[0]).toMatchObject({ ok: false, exitCode: null, timedOut: true })
    })

    it('still trusts the runner summary first', () => {
      expect(run('pytest; echo "exit=$?"', '1 failed, 3 passed in 0.1s\nexit=0')).toMatchObject({ ok: false })
    })
  })

  it('records a failed install with the cause run_shell named', () => {
    const l = new EvidenceLedger()
    l.recordShell(
      shell('pip install -r requirements.txt && pytest', {
        exitCode: 1,
        output: 'ERROR: Could not find a version that satisfies the requirement fastapi',
        blocked: 'network'
      })
    )
    expect(l.receipt()?.checks[0]).toEqual({
      kind: 'test',
      label: 'pip install -r requirements.txt && pytest',
      ok: false,
      exitCode: 1,
      blocked: 'network',
      runs: 1
    })
  })

  it('counts a timeout or a kill as a failure', () => {
    const l = new EvidenceLedger()
    l.recordShell(shell('npm run build', { exitCode: null, timedOut: true }))
    l.recordShell(shell('npm test', { exitCode: null }))
    expect(l.receipt()!.checks.map((c) => c.ok)).toEqual([false, false])
  })

  it('keeps the last run of a repeated command, counts its runs, and moves it to the end', () => {
    const l = new EvidenceLedger()
    l.recordShell(shell('pytest', { exitCode: 1, output: '1 failed, 11 passed in 0.1s' }))
    l.recordShell(shell('npm run build'))
    l.recordShell(shell('pytest', { output: '12 passed in 0.1s' }))
    const checks = l.receipt()!.checks
    expect(checks.map((c) => c.label)).toEqual(['npm run build', 'pytest'])
    expect(checks[1]).toMatchObject({ ok: true, runs: 2, counts: { passed: 12, failed: 0 } })
  })

  it('keeps no blocked cause on a run that passed', () => {
    const l = new EvidenceLedger()
    l.recordShell(shell('npm test', { blocked: 'network' }))
    expect(l.receipt()!.checks[0]).not.toHaveProperty('blocked')
  })

  it('counts other commands without listing them', () => {
    const l = new EvidenceLedger()
    l.recordShell(shell('ls'))
    l.recordShell(shell('npm test'))
    l.recordShell(shell('git diff'))
    const r = l.receipt()!
    expect(r.checks).toHaveLength(1)
    expect(r.otherCommands).toBe(2)
  })

  it('caps the checks at the most recent ones', () => {
    const l = new EvidenceLedger()
    for (let i = 0; i < RECEIPT_MAX_CHECKS + 3; i++) l.recordShell(shell(`npm run build -- --n ${i}`))
    const r = l.receipt()!
    expect(r.checks).toHaveLength(RECEIPT_MAX_CHECKS)
    expect(r.checksOmitted).toBe(3)
    expect(r.checks.at(-1)?.label).toBe(`npm run build -- --n ${RECEIPT_MAX_CHECKS + 2}`)
  })

  it('collapses whitespace, drops control characters, and truncates long commands', () => {
    const l = new EvidenceLedger()
    l.recordShell(shell('npm  test\n  --  --ci\u001b]52;c;aGk=\u0007'))
    l.recordShell(shell(`npm run build -- ${'x'.repeat(400)}`))
    const [first, second] = l.receipt()!.checks
    expect(first.label).toBe('npm test -- --ci]52;c;aGk=')
    expect(second.label).toHaveLength(RECEIPT_LABEL_MAX)
    expect(second.label.endsWith('…')).toBe(true)
  })

  it('records changed files once each, relative to the workspace', () => {
    const ws = join('/tmp', 'ws')
    const l = new EvidenceLedger()
    l.recordFiles(ws, ['src/a.ts', './src/a.ts', join(ws, 'src', 'b.ts'), 'README.md'])
    l.recordFiles(ws, [join('/elsewhere', 'c.ts')])
    const r = l.receipt()!
    expect(r.filesChanged).toEqual([join('src', 'a.ts'), join('src', 'b.ts'), 'README.md', join('/elsewhere', 'c.ts')])
    expect(r.filesChangedCount).toBe(4)
    expect(r.checks).toEqual([])
  })

  it('caps the listed files but keeps the full count', () => {
    const l = new EvidenceLedger()
    l.recordFiles('/ws', Array.from({ length: RECEIPT_MAX_FILES + 5 }, (_, i) => `f${i}.ts`))
    const r = l.receipt()!
    expect(r.filesChanged).toHaveLength(RECEIPT_MAX_FILES)
    expect(r.filesChangedCount).toBe(RECEIPT_MAX_FILES + 5)
  })
})

describe('EvidenceLedger browser checks', () => {
  const page = (steps: Array<[string, boolean, BrowserEvidence['steps'][number]['action']]>, over: Partial<BrowserEvidence> = {}): BrowserEvidence => ({
    kind: 'browser',
    url: 'http://localhost:5173/todos?token=secret#x',
    steps: steps.map(([step, ok, action]) => ({ step, ok, action })),
    planned: steps.length,
    ...over
  })

  it('passes a flow only when a check of the page came after the last action', () => {
    const l = new EvidenceLedger()
    l.recordBrowser(
      page([
        ['fill "#new"', true, 'fill'],
        ['press Enter', true, 'press'],
        ['expect text "Buy milk"', true, 'expect_text']
      ])
    )
    expect(l.receipt()!.checks[0]).toEqual({
      kind: 'browser',
      label: 'http://localhost:5173/todos',
      ok: true,
      steps: { total: 3, passed: 3, notRun: 0 },
      runs: 1
    })
  })

  it('does not pass a flow that only clicked through, or a page that only loaded', () => {
    const clicked = new EvidenceLedger()
    clicked.recordBrowser(page([['expect text "Todos"', true, 'expect_text'], ['click ".delete"', true, 'click']]))
    expect(clicked.receipt()!.checks[0]).toMatchObject({ ok: null, unknown: 'not-asserted' })
    const loaded = new EvidenceLedger()
    loaded.recordBrowser(page([]))
    expect(loaded.receipt()!.checks[0]).toMatchObject({ ok: null, unknown: 'not-asserted', steps: { total: 0 } })
  })

  it('fails on a failed step, saying which one and how many never ran', () => {
    const l = new EvidenceLedger()
    l.recordBrowser(
      page([['fill "#new"', true, 'fill'], ['click "#add"', false, 'click']], { planned: 4 })
    )
    expect(l.receipt()!.checks[0]).toMatchObject({
      ok: false,
      steps: { total: 4, passed: 1, notRun: 2, firstFailure: 'click "#add"' }
    })
  })

  it('fails a page that did not load', () => {
    const l = new EvidenceLedger()
    l.recordBrowser(page([], { loadError: 'net::ERR_CONNECTION_REFUSED' }))
    expect(l.receipt()!.checks[0]).toMatchObject({ ok: false, steps: { loadError: 'net::ERR_CONNECTION_REFUSED' } })
  })
})

describe('EvidenceLedger background shells', () => {
  const started = (command: string): ShellEvidence =>
    shell(command, { background: true, shellId: 'sh1', exitCode: null })

  it('reports a server still up when the turn ends', () => {
    const l = new EvidenceLedger()
    l.recordShell(started('npm run dev'))
    const r = l.receipt(() => ({ running: true, exitCode: null, output: 'ready' }))!
    expect(r.checks[0]).toMatchObject({ kind: 'server', ok: null, unknown: 'still-running', background: true })
  })

  it('reads a backgrounded test run that finished, counts and all', () => {
    const l = new EvidenceLedger()
    l.recordShell(started('npm test'))
    const r = l.receipt(() => ({ running: false, exitCode: 1, output: '      Tests  1 failed | 4 passed (5)' }))!
    expect(r.checks[0]).toEqual({
      kind: 'test',
      label: 'npm test',
      ok: false,
      exitCode: 1,
      counts: { passed: 4, failed: 1 },
      background: true,
      runs: 1
    })
  })

  it('reads an echoed status from a backgrounded test run that finished', () => {
    const l = new EvidenceLedger()
    l.recordShell(started('node test.mjs; echo "exit=$?"'))
    const r = l.receipt(() => ({ running: false, exitCode: 0, output: 'exit=1' }))!
    expect(r.checks[0]).toMatchObject({ kind: 'test', ok: false, exitCode: 1 })
  })

  it('leaves a start unknown when the registry no longer knows the shell', () => {
    const l = new EvidenceLedger()
    l.recordShell(started('npm run dev'))
    expect(l.receipt(() => undefined)!.checks[0]).toMatchObject({ ok: null, unknown: 'background' })
  })
})

describe('EvidenceLedger attribution and order', () => {
  it('lists a subagent’s plain commands by name with exit code and who ran them', () => {
    const l = new EvidenceLedger()
    l.record(shell('node -e "require(1)"', { exitCode: 0 }), 'Writable subagent "Fix it"')
    l.record(shell('ls', { exitCode: 2 }), 'Writable subagent "Fix it"')
    l.record(shell('git status'))
    const r = l.receipt()!
    expect(r.delegated).toEqual([
      { label: 'node -e "require(1)"', exitCode: 0, by: 'Writable subagent "Fix it"' },
      { label: 'ls', exitCode: 2, by: 'Writable subagent "Fix it"' }
    ])
    // The agent's own plain command is only counted, as before.
    expect(r.otherCommands).toBe(1)
    expect(receiptSummary(r)).toBe('2 subagent commands ran')
    expect(formatReceiptLines(r)).toContain('  ✓ Command: node -e "require(1)" (exit 0 · by Writable subagent "Fix it")')
  })

  it('caps delegated commands, counting the oldest it drops', () => {
    const l = new EvidenceLedger()
    for (let i = 0; i < RECEIPT_MAX_DELEGATED + 3; i++) l.record(shell(`echo ${i}`), 'agent')
    const r = l.receipt()!
    expect(r.delegated).toHaveLength(RECEIPT_MAX_DELEGATED)
    expect(r.delegatedOmitted).toBe(3)
    expect(r.delegated![0].label).toBe('echo 3')
  })

  it('credits files a subagent changed, until the agent itself changes them', () => {
    const l = new EvidenceLedger()
    l.recordFiles('/ws', ['a.ts', 'b.ts'], 'Writable subagent "x"')
    l.recordFiles('/ws', ['b.ts'])
    const r = l.receipt()!
    expect(r.filesChanged).toEqual(['a.ts', 'b.ts'])
    expect(r.filesBy).toEqual({ 'a.ts': 'Writable subagent "x"' })
  })

  it('credits a subagent with what it ran', () => {
    const l = new EvidenceLedger()
    l.record(shell('pytest', { output: '3 passed in 0.1s' }), 'test-writer')
    expect(l.receipt()!.checks[0]).toMatchObject({ ok: true, by: 'test-writer' })
  })

  it('records the verify command by what it does, or as a verify command', () => {
    const l = new EvidenceLedger()
    l.recordGate('npm test', false)
    l.recordGate('./scripts/check-all.sh', true)
    expect(l.receipt()!.checks).toEqual([
      { kind: 'test', label: 'npm test', ok: false, gate: true, runs: 1 },
      { kind: 'verify', label: './scripts/check-all.sh', ok: true, gate: true, runs: 1 }
    ])
  })

  it('marks a check that ran before the last file change, and only checks of code', () => {
    const l = new EvidenceLedger()
    l.recordShell(shell('npm install'))
    l.recordShell(shell('npm test', { output: '# pass 2\n# fail 0' }))
    l.recordFiles('/ws', ['src/a.ts'])
    l.recordShell(shell('npm run build'))
    const checks = l.receipt()!.checks
    expect(checks.find((c) => c.kind === 'test')).toMatchObject({ beforeLastWrite: true })
    expect(checks.find((c) => c.kind === 'install')).not.toHaveProperty('beforeLastWrite')
    expect(checks.find((c) => c.kind === 'build')).not.toHaveProperty('beforeLastWrite')
  })
})

describe('EvidenceLedger.passed and todo gaps', () => {
  it('answers whether a check of a kind passed', () => {
    const l = new EvidenceLedger()
    l.recordShell(shell('npm install'))
    l.recordShell(shell('pytest', { exitCode: 1 }))
    l.recordShell(shell('npm run build'))
    expect(l.passed('build')).toBe(true)
    expect(l.passed('test')).toBe(false)
    expect(l.passed('any')).toBe(true)
    const installOnly = new EvidenceLedger()
    installOnly.recordShell(shell('npm install'))
    expect(installOnly.passed('any')).toBe(false)
  })

  it('makes a receipt for todo gaps alone, capped and cleaned', () => {
    const l = new EvidenceLedger()
    expect(l.receipt(undefined, { todoGaps: [] })).toBeNull()
    const r = l.receipt(undefined, { todoGaps: Array.from({ length: 12 }, (_, i) => `Run tests ${i}\u001b[2J`) })!
    expect(r.todoGaps).toHaveLength(10)
    expect(r.todoGaps?.[0]).toBe('Run tests 0[2J')
    expect(r.checks).toEqual([])
  })
})
