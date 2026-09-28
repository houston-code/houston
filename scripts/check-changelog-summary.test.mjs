import { describe, it, expect } from 'vitest'
import { changelogProblems, summaryProblems, SUMMARY_MAX } from './check-changelog-summary.mjs'
import { buildNotes } from './gen-release-notes.mjs'

const ok = (summary, rest = '### Breaking changes\n_None._') => `${summary}\n\n${rest}`

describe('summaryProblems', () => {
  it('passes one short sentence, optionally followed by more context', () => {
    expect(summaryProblems(ok('Houston now runs your tests in parallel.'))).toEqual([])
    expect(
      summaryProblems(ok('Parallel test runs and a faster CLI.', 'More detail in a second paragraph.\n\n### Added\n- x')),
    ).toEqual([])
  })

  it('does not count abbreviations or versions as sentence breaks', () => {
    expect(summaryProblems(ok('Adds search tools, e.g. ast-grep, and requires v0.3.0 or newer.'))).toEqual([])
  })

  it('rejects a multi-sentence opening paragraph (the v0.3.0 shape)', () => {
    const [p] = summaryProblems(ok('This is the first public release. Since 0.2.0, the terminal client has grown.'))
    expect(p).toContain('2 sentences')
  })

  it(`rejects a summary over ${SUMMARY_MAX} characters`, () => {
    const long = `${'Houston gets a lot of new things '.repeat(5).trim()}.`
    expect(summaryProblems(ok(long)).join()).toContain(`keep it to ${SUMMARY_MAX} or fewer`)
  })

  it('rejects a summary that is not a complete sentence', () => {
    expect(summaryProblems(ok('Faster startup'))).toEqual(['the summary must be a complete sentence ending in . ! or ?'])
  })

  it('rejects an empty section, a heading or list first, and the placeholder', () => {
    expect(summaryProblems('')[0]).toContain('empty')
    expect(summaryProblems('### Added\n- x')[0]).toContain('before any heading')
    expect(summaryProblems('- x\n- y')[0]).toContain('before any heading')
    expect(summaryProblems('<!-- Replace this line -->\n\n### Added')[0]).toContain('placeholder')
  })

  it("fails the deterministic generator's placeholder until a human writes the sentence", () => {
    const md = buildNotes({ version: '9.9.9', date: '2026-01-01', prs: [] })
    const body = md.slice(md.indexOf('\n') + 1)
    expect(summaryProblems(body)[0]).toContain('placeholder')
  })
})

describe('changelogProblems', () => {
  it('checks the requested section, and requires it to exist', () => {
    expect(changelogProblems('## v9.9.9 - x\n\nOne. Two.', '9.9.9')[0]).toContain('2 sentences')
    expect(changelogProblems('', '9.9.9')).toEqual(['CHANGELOG.md has no "## v9.9.9" section'])
    expect(changelogProblems('## v9.9.9 - x\n\nA fine release.\n\n### Added\n- y', '9.9.9')).toEqual([])
  })
})
