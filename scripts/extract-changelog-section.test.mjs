import { describe, it, expect } from 'vitest'
import { extractSection } from './extract-changelog-section.mjs'

const CHANGELOG = `# Changelog

## v0.2.0 — 2026-06-28

Summary here.

### Breaking changes
- Renamed channel (#43)

### Added
- Public feed (#42)

## v0.1.0 — 2026-06-01

### Added
- First release
`

describe('extractSection', () => {
  it('returns just the requested version section, heading excluded', () => {
    const out = extractSection(CHANGELOG, '0.2.0')
    expect(out).toContain('Summary here.')
    expect(out).toContain('- Renamed channel (#43)')
    expect(out).toContain('- Public feed (#42)')
    // Stops before the next version's heading and body.
    expect(out).not.toContain('v0.1.0')
    expect(out).not.toContain('First release')
    expect(out.startsWith('## v')).toBe(false)
  })

  it('extracts the last section (terminated by EOF, not a following heading)', () => {
    const out = extractSection(CHANGELOG, '0.1.0')
    expect(out).toContain('- First release')
    expect(out).not.toContain('v0.2.0')
  })

  it('does not let the version dots match arbitrary characters', () => {
    // "0.2.0" must not match a heading like "## v0x2y0" — dots are escaped.
    const cl = '# Changelog\n\n## v0x2y0 — x\n\n- nope\n'
    expect(extractSection(cl, '0.2.0')).toBe('')
  })

  it('returns empty string when the version is absent', () => {
    expect(extractSection(CHANGELOG, '9.9.9')).toBe('')
  })

  it('handles an empty changelog', () => {
    expect(extractSection('', '0.1.0')).toBe('')
  })
})
