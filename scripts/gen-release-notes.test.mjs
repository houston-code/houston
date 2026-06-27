import { describe, it, expect } from 'vitest'
import { parseTitle, categorize, buildNotes, prependToChangelog } from './gen-release-notes.mjs'

describe('parseTitle', () => {
  it('splits conventional-commit titles into type/breaking/summary', () => {
    expect(parseTitle('feat(updater): add delta downloads')).toEqual({
      type: 'feat',
      breaking: false,
      summary: 'add delta downloads'
    })
  })

  it('detects the breaking ! marker', () => {
    expect(parseTitle('feat!: drop node 18 support')).toEqual({
      type: 'feat',
      breaking: true,
      summary: 'drop node 18 support'
    })
  })

  it('treats a non-conventional title as type-less', () => {
    expect(parseTitle('Just a plain title')).toEqual({
      type: null,
      breaking: false,
      summary: 'Just a plain title'
    })
  })
})

describe('categorize', () => {
  it('routes feat → Added and fix → Fixed', () => {
    expect(categorize({ title: 'feat: x' }).section).toBe('Added')
    expect(categorize({ title: 'fix: y' }).section).toBe('Fixed')
  })

  it('routes perf/refactor/revert → Changed', () => {
    expect(categorize({ title: 'perf: faster' }).section).toBe('Changed')
    expect(categorize({ title: 'refactor: tidy' }).section).toBe('Changed')
  })

  it('omits non-user-facing types (chore/docs/test/ci)', () => {
    expect(categorize({ title: 'chore: bump deps' })).toBeNull()
    expect(categorize({ title: 'docs: readme' })).toBeNull()
    expect(categorize({ title: 'ci: tweak workflow' })).toBeNull()
  })

  it('promotes a breaking ! to the Breaking section over its type', () => {
    expect(categorize({ title: 'feat!: new api' }).section).toBe('Breaking')
  })

  it('promotes via a breaking label even without the ! marker', () => {
    expect(categorize({ title: 'feat: new api', labels: [{ name: 'breaking' }] }).section).toBe(
      'Breaking'
    )
  })

  it('promotes via a BREAKING CHANGE body footer', () => {
    expect(categorize({ title: 'fix: thing', body: 'BREAKING CHANGE: removed flag' }).section).toBe(
      'Breaking'
    )
  })
})

describe('buildNotes', () => {
  const prs = [
    { number: 10, title: 'feat: add export button' },
    { number: 11, title: 'fix: crash on empty input' },
    { number: 12, title: 'chore: bump deps' }, // dropped
    { number: 13, title: 'feat!: rename config key' }
  ]

  it('groups entries and always emits a summary placeholder + Required steps', () => {
    const md = buildNotes({ version: '0.2.0', date: '2026-06-28', prs })
    expect(md).toContain('## v0.2.0 — 2026-06-28')
    expect(md).toContain('2–3 sentence plain-English summary')
    expect(md).toContain('### Required steps')
    expect(md).toContain('### Breaking changes')
    expect(md).toContain('- Rename config key (#13)')
    expect(md).toContain('### Added')
    expect(md).toContain('- Add export button (#10)')
    expect(md).toContain('### Fixed')
    expect(md).toContain('- Crash on empty input (#11)')
  })

  it('drops the chore PR from user-facing notes', () => {
    const md = buildNotes({ version: '0.2.0', date: '2026-06-28', prs })
    expect(md).not.toContain('bump deps')
  })

  it('shows _None._ for breaking when there are none, and omits empty Added/Fixed/Changed', () => {
    const md = buildNotes({
      version: '0.1.1',
      date: '2026-06-28',
      prs: [{ number: 1, title: 'fix: small bug' }]
    })
    expect(md).toMatch(/### Breaking changes\n_None\._/)
    expect(md).not.toContain('### Added')
    expect(md).not.toContain('### Changed')
    expect(md).toContain('### Fixed')
  })

  it('handles an empty PR set without throwing', () => {
    const md = buildNotes({ version: '0.0.1', date: '2026-06-28', prs: [] })
    expect(md).toContain('## v0.0.1 — 2026-06-28')
    expect(md).toMatch(/### Breaking changes\n_None\._/)
  })
})

describe('prependToChangelog', () => {
  it('inserts the new section directly under the H1, above older entries', () => {
    const existing = '# Changelog\n\n## v0.1.0 — 2026-06-01\n\n### Added\n- First release\n'
    const section = '## v0.2.0 — 2026-06-28\n\n### Added\n- New thing\n'
    const out = prependToChangelog(existing, section)
    expect(out.indexOf('v0.2.0')).toBeLessThan(out.indexOf('v0.1.0'))
    expect(out.startsWith('# Changelog\n')).toBe(true)
    expect(out).toContain('- First release')
  })

  it('creates a clean file when there is no existing changelog', () => {
    const out = prependToChangelog('', '## v0.1.0 — 2026-06-28\n\n### Added\n- First\n')
    expect(out).toBe('# Changelog\n\n## v0.1.0 — 2026-06-28\n\n### Added\n- First\n')
  })
})
