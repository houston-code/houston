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
    ).toBe('Server started · HTTP requests sent, status not checked')
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
      'Recorded by Houston: Tests passed (4) · 1 file changed',
      '  ✓ tests: npm test (4 passed)',
      '  plus 2 earlier checks',
      '  plus 5 other commands'
    ])
  })

  it('never uses an em dash in what the user sees', () => {
    const r = receipt({
      checks: [
        check({ ok: false, exitCode: 1, blocked: 'sandbox-write', runs: 2 }),
        check({ kind: 'http', label: 'curl localhost', ok: null, unknown: 'http-status-unchecked' })
      ],
      otherCommands: 1,
      filesChanged: ['a.py'],
      filesChangedCount: 1
    })
    expect(formatReceiptLines(r).join('\n')).not.toContain('—')
  })
})

describe('receiptHasFailure', () => {
  it('is true only when some check failed', () => {
    expect(receiptHasFailure(receipt({ checks: [check({}), check({ ok: null })] }))).toBe(false)
    expect(receiptHasFailure(receipt({ checks: [check({ ok: false })] }))).toBe(true)
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
    expect(checkDetail(check({ ok: false, exitCode: 1, background: true }))).toBe('exit 1, ran in the background')
  })

  it('credits a subagent, marks the verify command, and flags a check older than the last edit', () => {
    expect(checkDetail(check({ by: 'test-writer' }))).toBe('exit 0, run by test-writer')
    expect(checkDetail(check({ gate: true, exitCode: undefined }))).toBe('your verify command')
    expect(checkDetail(check({ beforeLastWrite: true }))).toBe('exit 0, ran before the last file change')
  })
})
