import { describe, expect, it } from 'vitest'
import { cleanCommitMessage, MAX_COMMIT_MESSAGE, parsePrView, summarizeChecks } from './gitActions'

describe('cleanCommitMessage', () => {
  it('trims, normalizes line endings and drops control characters', () => {
    expect(cleanCommitMessage('  Fix it\r\n\r\nBody\u0007 line \n')).toBe('Fix it\n\nBody line')
    expect(cleanCommitMessage('tab\there')).toBe('tab\there')
  })

  it('refuses empty, non-string and oversized messages', () => {
    expect(cleanCommitMessage('   \n ')).toBeNull()
    expect(cleanCommitMessage(42)).toBeNull()
    expect(cleanCommitMessage('x'.repeat(MAX_COMMIT_MESSAGE + 1))).toBeNull()
  })
})

describe('summarizeChecks', () => {
  it('fails on any failure, else pends on anything running, else passes', () => {
    expect(
      summarizeChecks([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'IN_PROGRESS', conclusion: '' },
        { state: 'FAILURE' }
      ])
    ).toEqual({ checks: 'failing', counts: { passing: 1, failing: 1, pending: 1 } })
    expect(summarizeChecks([{ status: 'QUEUED' }, { state: 'SUCCESS' }]).checks).toBe('pending')
    expect(summarizeChecks([{ state: 'PENDING' }]).checks).toBe('pending')
    expect(summarizeChecks([{ status: 'COMPLETED', conclusion: 'SKIPPED' }, { state: 'SUCCESS' }]).checks).toBe('passing')
    expect(summarizeChecks([]).checks).toBe('none')
    expect(summarizeChecks(undefined).checks).toBe('none')
    expect(summarizeChecks([null, 'x']).checks).toBe('none')
  })
})

describe('parsePrView', () => {
  const view = {
    number: 42,
    title: 'Add a thing',
    state: 'OPEN',
    isDraft: false,
    url: 'https://github.com/o/r/pull/42',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }]
  }

  it('reads the fields the chip needs', () => {
    expect(parsePrView(JSON.stringify(view))).toEqual({
      number: 42,
      title: 'Add a thing',
      state: 'OPEN',
      isDraft: false,
      url: 'https://github.com/o/r/pull/42',
      checks: 'passing',
      counts: { passing: 1, failing: 0, pending: 0 }
    })
  })

  it('refuses anything that does not look like a pull request link', () => {
    expect(parsePrView('not json')).toBeNull()
    expect(parsePrView(JSON.stringify({ ...view, url: 'javascript:alert(1)' }))).toBeNull()
    expect(parsePrView(JSON.stringify({ ...view, url: 'http://github.com/o/r/pull/42' }))).toBeNull()
    expect(parsePrView(JSON.stringify({ ...view, number: -1 }))).toBeNull()
    expect(parsePrView(JSON.stringify({ ...view, state: 'WEIRD' }))).toBeNull()
  })
})
