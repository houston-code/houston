import { describe, it, expect } from 'vitest'
import { upsertSection } from './changelog-upsert.mjs'

const CHANGELOG = `# Changelog

## v0.9.0 - 2026-10-20

Nine.

### Added
- Thing (#1)

## v0.8.0 - 2026-10-01

Eight.
`

describe('upsertSection', () => {
  it('replaces the section for a version that is already there, leaving the others alone', () => {
    const out = upsertSection(CHANGELOG, '## v0.9.0 - 2026-10-21\n\nNine, again.\n', '0.9.0')
    expect(out).toContain('Nine, again.')
    expect(out).not.toContain('- Thing (#1)')
    expect(out).toContain('## v0.8.0 - 2026-10-01\n\nEight.')
    expect(out.match(/## v0\.9\.0/g)).toHaveLength(1)
    expect(out.indexOf('## v0.9.0')).toBeLessThan(out.indexOf('## v0.8.0'))
  })

  it('replaces the last section without swallowing a trailing newline', () => {
    const out = upsertSection(CHANGELOG, '## v0.8.0\n\nEight, again.', '0.8.0')
    expect(out.endsWith('Eight, again.\n')).toBe(true)
    expect(out).toContain('- Thing (#1)')
  })

  it('puts a new newest version at the top, under the title', () => {
    const out = upsertSection(CHANGELOG, '## v0.10.0\n\nTen.', '0.10.0')
    expect(out.startsWith('# Changelog\n\n## v0.10.0\n\nTen.\n\n## v0.9.0')).toBe(true)
  })

  it('puts a patch to an older line in version order, below newer releases', () => {
    const out = upsertSection(CHANGELOG, '## v0.8.1\n\nEight point one.', '0.8.1')
    expect(out.indexOf('## v0.9.0')).toBeLessThan(out.indexOf('## v0.8.1'))
    expect(out.indexOf('## v0.8.1')).toBeLessThan(out.indexOf('## v0.8.0'))
  })

  it('appends a version older than everything listed, and starts an empty changelog', () => {
    expect(upsertSection(CHANGELOG, '## v0.7.0\n\nSeven.', '0.7.0').trimEnd().endsWith('## v0.7.0\n\nSeven.')).toBe(true)
    expect(upsertSection('', '## v0.1.0\n\nOne.', '0.1.0')).toBe('# Changelog\n\n## v0.1.0\n\nOne.\n')
  })

  it('matches the exact version, not a prefix of it', () => {
    const out = upsertSection('# Changelog\n\n## v0.9.10\n\nTen.\n', '## v0.9.1\n\nOne.', '0.9.1')
    expect(out).toContain('## v0.9.10\n\nTen.')
    expect(out.indexOf('## v0.9.10')).toBeLessThan(out.indexOf('## v0.9.1\n'))
  })
})
