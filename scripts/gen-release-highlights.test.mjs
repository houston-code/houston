import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { generateReleaseHighlights, popupSummary } from './gen-release-highlights.mjs'

describe('popupSummary', () => {
  it('uses the one-sentence summary that opens the section', () => {
    expect(popupSummary('Parallel test runs land.\n\nMore context.\n\n### Added\n- x')).toBe('Parallel test runs land.')
  })

  it("takes the first sentence of a longer opening paragraph (v0.3.0's shape)", () => {
    expect(
      popupSummary(
        "This is Houston's first public release, published from github.com/houston-code/houston. Since 0.2.0, the terminal client grew.",
      ),
    ).toBe("This is Houston's first public release, published from github.com/houston-code/houston.")
  })

  it('shows plain text, not Markdown', () => {
    expect(popupSummary('**Steer** runs with `Esc`, see [docs](https://x).')).toBe('Steer runs with Esc, see docs.')
  })

  it('returns null when there is no usable summary, so the popup stays off', () => {
    expect(popupSummary('<!-- Replace this line with ONE sentence -->\n\n### Added')).toBeNull()
    expect(popupSummary('### Added\n- x')).toBeNull()
    expect(popupSummary('')).toBeNull()
    expect(popupSummary(`${'word '.repeat(40).trim()}.`)).toBeNull()
  })
})

describe('generateReleaseHighlights', () => {
  function fixture(changelog, version = '1.4.0') {
    const dir = mkdtempSync(join(tmpdir(), 'houston-highlights-'))
    writeFileSync(join(dir, 'CHANGELOG.md'), changelog)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }))
    return { changelogPath: join(dir, 'CHANGELOG.md'), packagePath: join(dir, 'package.json'), out: join(dir, 'out.ts') }
  }

  it("bundles the package version's summary", () => {
    const paths = fixture('# Changelog\n\n## v1.4.0 - 2026-10-01\n\nFaster startup everywhere.\n\n## v1.3.0 - x\n\nOlder.')
    const r = generateReleaseHighlights(paths)
    expect(r).toMatchObject({ version: '1.4.0', summary: 'Faster startup everywhere.', written: true })
    expect(readFileSync(paths.out, 'utf8')).toContain('"summary": "Faster startup everywhere."')
    // Unchanged content is not rewritten (it runs on every Vitest start).
    expect(generateReleaseHighlights(paths).written).toBe(false)
  })

  it('bundles null when the version has no section yet', () => {
    const paths = fixture('## v1.3.0 - x\n\nOlder.')
    generateReleaseHighlights(paths)
    expect(readFileSync(paths.out, 'utf8')).toContain('| null = null')
  })
})
