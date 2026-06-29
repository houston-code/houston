import { describe, it, expect } from 'vitest'
import { highlightFile, languageForPath, MAX_HIGHLIGHT_BYTES } from './highlight'

describe('languageForPath', () => {
  it('maps known extensions to highlight.js languages', () => {
    expect(languageForPath('src/app.ts')).toBe('typescript')
    expect(languageForPath('a/b/c.tsx')).toBe('typescript')
    expect(languageForPath('main.py')).toBe('python')
    expect(languageForPath('style.css')).toBe('css')
    expect(languageForPath('icon.svg')).toBe('xml')
    expect(languageForPath('README.md')).toBe('markdown')
  })

  it('maps extensionless well-known filenames', () => {
    expect(languageForPath('build/Makefile')).toBe('makefile')
  })

  it('returns null for unknown or absent extensions', () => {
    expect(languageForPath('notes.txt')).toBeNull()
    expect(languageForPath('LICENSE')).toBeNull()
    expect(languageForPath('data.unknownext')).toBeNull()
  })
})

describe('highlightFile', () => {
  it('returns hljs token HTML for a known language', () => {
    const html = highlightFile('a.ts', 'const x = 1')
    expect(html).toContain('hljs-keyword') // `const`
    expect(html).toContain('hljs-number') // `1`
  })

  it('escapes HTML in the source (safe to inject)', () => {
    const html = highlightFile('a.ts', 'const s = "<img>"')
    expect(html).not.toContain('<img>')
    expect(html).toContain('&lt;img&gt;')
  })

  it('returns null for an unknown language', () => {
    expect(highlightFile('notes.txt', 'plain text')).toBeNull()
  })

  it('returns null past the size cap (falls back to plain rendering)', () => {
    expect(highlightFile('big.ts', 'a'.repeat(MAX_HIGHLIGHT_BYTES + 1))).toBeNull()
  })
})
