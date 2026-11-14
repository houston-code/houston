import { describe, expect, it } from 'vitest'
import {
  checkDetail,
  checkGlyph,
  formatReceiptLines,
  receiptHasFailure,
  receiptSummary,
  type ReceiptCheck,
  type TurnReceipt
} from './evidence'

const receipt = (over: Partial<TurnReceipt> = {}): TurnReceipt => ({
  v: 1,
  checks: [],
  otherCommands: 0,
  filesChanged: [],
  filesChangedCount: 0,
  ...over
})

const check = (over: Partial<ReceiptCheck>): ReceiptCheck => ({
  kind: 'test',
  label: 'pytest',
  ok: true,
  exitCode: 0,
  runs: 1,
  ...over
})

describe('receiptSummary', () => {
  it('leads with "no tests ran" when code changed and nothing tested it', () => {
    // The todo-app turn this exists for: the install failed offline, so pytest never ran.
    const r = receipt({
      checks: [
        check({ kind: 'install', label: 'pip install -r requirements.txt', ok: false, exitCode: 1, blocked: 'network' }),
        check({ kind: 'build', label: 'npm run build', ok: false, exitCode: 1 })
      ],
      filesChanged: ['backend/main.py', 'frontend/src/App.jsx'],
      filesChangedCount: 14
    })
    expect(receiptSummary(r)).toBe('No tests ran · build failed · install failed (no network) · 14 files changed')
  })

  it('does not say "no tests ran" for a docs-only change', () => {
    const r = receipt({ filesChanged: ['README.md', 'docs/guide.mdx'], filesChangedCount: 2 })
    expect(receiptSummary(r)).toBe('2 files changed')
  })

  it('reports the last test run by its counts', () => {
    expect(receiptSummary(receipt({ checks: [check({ counts: { passed: 12, failed: 0 } })] }))).toBe('Tests passed (12)')
    expect(
      receiptSummary(receipt({ checks: [check({ ok: false, exitCode: 1, counts: { passed: 11, failed: 1 } })] }))
    ).toBe('Tests failed (1 of 12)')
    expect(receiptSummary(receipt({ checks: [check({ ok: false, exitCode: 0, counts: { passed: 0, failed: 0 } })] }))).toBe(
      'No tests were found'
    )
    expect(receiptSummary(receipt({ checks: [check({ ok: false, exitCode: 1, blocked: 'network' })] }))).toBe(
      'Test command failed (no network)'
    )
    expect(receiptSummary(receipt({ checks: [check({ ok: false, exitCode: null, timedOut: true })] }))).toBe(
      'Tests timed out'
    )
  })

  it('says how many tests the last run skipped, and when it ran fewer or skipped more than before', () => {
    const t = (over: Partial<ReceiptCheck>): string => receiptSummary(receipt({ checks: [check(over)] }))
    expect(t({ counts: { passed: 12, failed: 0, skipped: 2 } })).toBe('Tests passed (12, 2 skipped)')
    expect(t({ counts: { passed: 11, failed: 0 }, shrunk: { from: 12, to: 11 } })).toBe('Tests passed (11, down from 12)')
    expect(t({ counts: { passed: 12, failed: 0, skipped: 3 }, skippedRose: { from: 1, to: 3 } })).toBe(
      'Tests passed (12, 3 skipped, up from 1)'
    )
    expect(
      t({ counts: { passed: 11, failed: 0, skipped: 1 }, shrunk: { from: 12, to: 11 }, skippedRose: { from: 0, to: 1 } })
    ).toBe('Tests passed (11, down from 12, 1 skipped, up from 0)')
    expect(t({ ok: false, exitCode: 1, counts: { passed: 9, failed: 1 }, shrunk: { from: 12, to: 10 } })).toBe(
      'Tests failed (1 of 10, down from 12)'
    )
  })

  it('says when the last passing test run came before the last file change', () => {
    const r = receipt({
      checks: [check({ counts: { passed: 12, failed: 0 }, beforeLastWrite: true })],
      filesChanged: ['src/a.ts'],
      filesChangedCount: 1
    })
    expect(receiptSummary(r)).toBe('Tests passed (12) before the last change · 1 file changed')
    expect(receiptSummary(receipt({ checks: [check({ exitCode: 0, beforeLastWrite: true })] }))).toBe(
      'Tests passed before the last change'
    )
  })

  it('says when an outcome is unknown instead of calling it a pass', () => {
    expect(receiptSummary(receipt({ checks: [check({ ok: null, unknown: 'exit-not-attributable' })] }))).toBe(
      'Test result unknown'
    )
    expect(
      receiptSummary(
        receipt({
          checks: [
            check({ kind: 'server', label: 'npm run dev', ok: null, unknown: 'background', exitCode: undefined, background: true }),
            check({ kind: 'http', label: 'curl -s localhost:5173', ok: null, unknown: 'http-status-unchecked' })
          ]
        })
      )
    ).toBe('Server started · HTTP response not checked')
  })

  it('names each other kind by its last run', () => {
    const r = receipt({
      checks: [
        check({ kind: 'build', label: 'npm run build', ok: false, exitCode: 2 }),
        check({ kind: 'typecheck', label: 'tsc --noEmit' }),
        check({ kind: 'build', label: 'npm run build' })
      ],
      filesChanged: ['src/a.ts'],
      filesChangedCount: 1
    })
    expect(receiptSummary(r)).toBe('No tests ran · typecheck passed · build passed · 1 file changed')
  })
})

describe('checkDetail and checkGlyph', () => {
  it('describes what the last run came to', () => {
    expect(checkDetail(check({ counts: { passed: 3, failed: 1, skipped: 2 } }))).toBe('3 passed, 1 failed, 2 skipped')
    expect(checkDetail(check({ ok: false, exitCode: 1, blocked: 'egress' }))).toBe('exit 1, blocked by the egress allowlist')
    expect(checkDetail(check({ ok: false, exitCode: null }))).toBe('killed')
    expect(checkDetail(check({ ok: false, exitCode: null, timedOut: true }))).toBe('timed out')
    expect(checkDetail(check({ ok: null, unknown: 'exit-not-attributable' }))).toBe(
      'exit 0, exit code is from another part of the command'
    )
    expect(checkDetail(check({ ok: null, unknown: 'background', exitCode: undefined, background: true }))).toBe(
      'started in the background'
    )
    expect(checkDetail(check({ runs: 3 }))).toBe('exit 0, ran 3 times, last run shown')
  })

  it('says what an earlier run of the same command ran and skipped, when the last ran fewer or skipped more', () => {
    expect(
      checkDetail(
        check({
          counts: { passed: 11, failed: 0, skipped: 1 },
          shrunk: { from: 12, to: 11 },
          skippedRose: { from: 0, to: 1 },
          runs: 2
        })
      )
    ).toBe('11 passed, 1 skipped, an earlier run ran 12 tests, an earlier run skipped none, ran 2 times, last run shown')
    expect(checkDetail(check({ counts: { passed: 4, failed: 0, skipped: 3 }, skippedRose: { from: 1, to: 3 }, runs: 2 }))).toBe(
      '4 passed, 3 skipped, an earlier run skipped 1, ran 2 times, last run shown'
    )
  })

  it('marks passed, failed, and unknown differently', () => {
    expect([check({}), check({ ok: false }), check({ ok: null })].map(checkGlyph)).toEqual(['✓', '✗', '○'])
  })
})

describe('formatReceiptLines', () => {
  it('lists the summary, each check, and what was left out', () => {
    const r = receipt({
      checks: [check({ label: 'npm test', counts: { passed: 4, failed: 0 } })],
      checksOmitted: 2,
      otherCommands: 5,
      filesChanged: ['src/a.ts'],
      filesChangedCount: 1
    })
    expect(formatReceiptLines(r)).toEqual([
      'What ran: Tests passed (4) · 1 file changed',
      '  ✓ tests: npm test (4 passed)',
      '  plus 2 earlier checks',
      '  plus 5 other commands'
    ])
  })

  it('never uses an em dash in what the user sees', () => {
    const r = receipt({
      checks: [
        check({ ok: false, exitCode: 1, blocked: 'sandbox-write', runs: 2 }),
        check({ kind: 'http', label: 'curl localhost', ok: null, unknown: 'http-status-unchecked' }),
        check({
          counts: { passed: 11, failed: 0, skipped: 1 },
          shrunk: { from: 12, to: 11 },
          skippedRose: { from: 0, to: 1 },
          beforeLastWrite: true,
          runs: 2
        })
      ],
      otherCommands: 1,
      filesChanged: ['a.py'],
      filesChangedCount: 1,
      todoGaps: ['Run the build'],
      todoStale: ['Run the tests']
    })
    expect(formatReceiptLines(r).join('\n')).not.toContain('—')
  })
})

describe('receiptHasFailure', () => {
  it('is true only when some check failed', () => {
    expect(receiptHasFailure(receipt({ checks: [check({}), check({ ok: null })] }))).toBe(false)
    expect(receiptHasFailure(receipt({ checks: [check({ ok: false })] }))).toBe(true)
  })

  it('is true when a test command ran fewer tests or skipped more than an earlier run of it', () => {
    expect(receiptHasFailure(receipt({ checks: [check({ shrunk: { from: 12, to: 11 } })] }))).toBe(true)
    expect(receiptHasFailure(receipt({ checks: [check({ skippedRose: { from: 0, to: 1 } })] }))).toBe(true)
    // A pass from before the last change is shown as such, not flagged on its own.
    expect(receiptHasFailure(receipt({ checks: [check({ beforeLastWrite: true })] }))).toBe(false)
  })

  it('reads a receipt saved before these fields existed', () => {
    const old = JSON.parse(
      '{"v":1,"checks":[{"kind":"test","label":"npm test","ok":true,"exitCode":0,"counts":{"passed":12,"failed":0},"runs":2}],"otherCommands":0,"filesChanged":["a.ts"],"filesChangedCount":1}'
    ) as TurnReceipt
    expect(receiptSummary(old)).toBe('Tests passed (12) · 1 file changed')
    expect(receiptHasFailure(old)).toBe(false)
    expect(formatReceiptLines(old)[1]).toBe('  ✓ tests: npm test (12 passed, ran 2 times, last run shown)')
  })
})

describe('wording for browser checks, background runs, and who ran what', () => {
  it('describes a browser check by its steps', () => {
    expect(checkDetail(check({ kind: 'browser', label: 'http://localhost:5173/', steps: { total: 3, passed: 3, notRun: 0 } }))).toBe(
      '3 of 3 steps passed'
    )
    expect(
      checkDetail(
        check({ kind: 'browser', ok: false, steps: { total: 4, passed: 1, notRun: 2, firstFailure: 'click "#add"' } })
      )
    ).toBe('1 of 4 steps passed, failed at click "#add", 2 not run')
    expect(
      checkDetail(check({ kind: 'browser', ok: null, unknown: 'not-asserted', steps: { total: 0, passed: 0, notRun: 0 } }))
    ).toBe('loaded, nothing on the page was checked')
    expect(
      checkDetail(check({ kind: 'browser', ok: false, steps: { total: 0, passed: 0, notRun: 0, loadError: 'ERR_CONNECTION_REFUSED' } }))
    ).toBe('the page did not load: ERR_CONNECTION_REFUSED')
  })

  it('names browser outcomes in the summary', () => {
    const r = (c: Partial<ReceiptCheck>): string =>
      receiptSummary(receipt({ checks: [check({ kind: 'browser', steps: { total: 1, passed: 1, notRun: 0 }, ...c })] }))
    expect(r({})).toBe('Browser check passed')
    expect(r({ ok: false })).toBe('Browser check failed')
    expect(r({ ok: null, unknown: 'not-asserted' })).toBe('Browser: nothing on the page was checked')
  })

  it('says a server is still running, and how a background run ended', () => {
    expect(
      receiptSummary(receipt({ checks: [check({ kind: 'server', ok: null, unknown: 'still-running', background: true })] }))
    ).toBe('Server running')
    expect(checkDetail(check({ ok: false, exitCode: 1, background: true }))).toBe('exit 1')
  })

  it('says an unchecked HTTP request\'s response was not checked, without curl\'s exit code', () => {
    expect(checkDetail(check({ kind: 'http', ok: null, unknown: 'http-status-unchecked', exitCode: 0 }))).toBe(
      'response not checked'
    )
  })

  it('credits a subagent, marks the verify command, and flags a check older than the last edit', () => {
    expect(checkDetail(check({ by: 'test-writer' }))).toBe('exit 0, run by test-writer')
    expect(checkDetail(check({ gate: true, exitCode: undefined }))).toBe('your verify command')
    expect(checkDetail(check({ beforeLastWrite: true }))).toBe('exit 0, ran before the last file change')
  })
})

describe('todo gaps in the receipt', () => {
  const r = receipt({ todoGaps: ['Backend tests with pytest', 'Verify: pytest, curl, build, browser'] })

  it('counts them in the summary, lists them, and treats them as a failure', () => {
    expect(receiptSummary(r)).toBe('2 todos marked done with nothing recorded')
    expect(formatReceiptLines(r)).toEqual([
      'What ran: 2 todos marked done with nothing recorded',
      '  ! marked done with nothing recorded: Backend tests with pytest',
      '  ! marked done with nothing recorded: Verify: pytest, curl, build, browser'
    ])
    expect(receiptHasFailure(r)).toBe(true)
  })

  it('lists todos backed only by a run before the last change apart, and treats them as a failure', () => {
    const s = receipt({ todoStale: ['Run the test suite'] })
    expect(receiptSummary(s)).toBe('1 todo marked done, checked only before the last change')
    expect(formatReceiptLines(s)).toEqual([
      'What ran: 1 todo marked done, checked only before the last change',
      '  ! marked done, checked only before the last change: Run the test suite'
    ])
    expect(receiptHasFailure(s)).toBe(true)
  })
})

describe('test edits in the receipt', () => {
  const edits = receipt({
    filesChanged: ['src/a.test.ts', 'package.json'],
    filesChangedCount: 2,
    testEdits: [
      { path: 'src/a.test.ts', kind: 'skip', detail: "added it.skip('rejects bad input'" },
      { path: 'package.json', kind: 'script', detail: '"test" gained an exit status that is always 0: vitest || true' }
    ]
  })

  it('counts them in the summary, lists them, and treats them as a failure', () => {
    expect(receiptSummary(edits)).toBe('No tests ran · 2 files changed · 2 test edits to review')
    expect(formatReceiptLines(edits)).toEqual([
      'What ran: No tests ran · 2 files changed · 2 test edits to review',
      "  ! test skipped: src/a.test.ts (added it.skip('rejects bad input')",
      '  ! test script loosened: package.json ("test" gained an exit status that is always 0: vitest || true)'
    ])
    expect(receiptHasFailure(edits)).toBe(true)
  })

  it('counts the ones past the cap', () => {
    const r = receipt({
      testEdits: [{ path: 'a_test.go', kind: 'deleted', detail: 'deleted, with 3 assertions' }],
      testEditsOmitted: 2
    })
    expect(receiptSummary(r)).toBe('3 test edits to review')
    expect(formatReceiptLines(r).at(-1)).toBe('  plus 2 more test edits')
  })

  it('is not a failure without them', () => {
    expect(receiptHasFailure(receipt({ testEdits: [] }))).toBe(false)
  })
})

describe('plan progress in the receipt', () => {
  const plan = {
    title: 'Todo app',
    filesTotal: 11,
    filesPending: ['web/App.jsx', 'web/api.js'],
    filesPendingCount: 2,
    checks: [
      { step: 'pytest', status: 'passed' as const },
      { step: 'npm run build', status: 'failed' as const },
      { step: 'add a todo in the browser', status: 'not-run' as const }
    ],
    complete: false
  }

  it('sums it up and lists each check and the files still to change', () => {
    const r = receipt({ plan, filesChanged: ['app.py'], filesChangedCount: 1 })
    expect(receiptSummary(r)).toBe('No tests ran · 1 file changed · plan: 9 of 11 files, 1 of 3 checks passed')
    expect(formatReceiptLines(r).slice(1)).toEqual([
      '  plan "Todo app":',
      '    ✓ pytest (passed)',
      '    ✗ npm run build (ran, nothing passed)',
      '    ○ add a todo in the browser (not run yet)',
      '    files not changed yet: web/App.jsx, web/api.js'
    ])
  })

  it('says once that the plan is complete', () => {
    const r = receipt({ plan: { ...plan, complete: true } })
    expect(receiptSummary(r)).toBe('Plan complete')
    expect(formatReceiptLines(r)).toEqual(['What ran: Plan complete'])
  })
})
