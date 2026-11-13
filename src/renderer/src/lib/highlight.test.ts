import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import hljs from 'highlight.js/lib/common'
import {
  clearHighlightCache,
  highlightCacheStats,
  highlightCode,
  highlightFile,
  languageForPath,
  MAX_CODE_CACHE_CHARS,
  MAX_HIGHLIGHT_BYTES
} from './highlight'

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

describe('highlightCode cache', () => {
  beforeEach(() => clearHighlightCache())
  afterEach(() => vi.restoreAllMocks())

  it('returns the identical HTML from cache without tokenizing again', () => {
    const spy = vi.spyOn(hljs, 'highlight')
    const first = highlightCode('ts', 'const x = 1')
    const second = highlightCode('ts', 'const x = 1')
    expect(second).toBe(first)
    expect(first).toBe(hljs.highlight('const x = 1', { language: 'typescript', ignoreIllegals: true }).value)
    // Two from highlightCode would be 3 here; the cache served the repeat.
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('shares an entry across aliases of one language, and keeps languages apart', () => {
    const spy = vi.spyOn(hljs, 'highlight')
    highlightCode('ts', 'let a = 2')
    highlightCode('TypeScript', 'let a = 2')
    expect(spy).toHaveBeenCalledTimes(1)
    highlightCode('js', 'let a = 2')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('still returns null for an unknown language or oversized block, and caches neither', () => {
    expect(highlightCode('nope-lang', 'x')).toBeNull()
    expect(highlightCode('ts', 'a'.repeat(MAX_HIGHLIGHT_BYTES + 1))).toBeNull()
    expect(highlightCacheStats()).toEqual({ entries: 0, chars: 0 })
  })

  it('evicts the least recently used blocks past the character bound', () => {
    // Tokenizing megabytes is slow and beside the point here: a cheap stand-in fills the cache.
    vi.spyOn(hljs, 'highlight').mockImplementation(
      (text: string) => ({ value: `<${text.length}>` }) as ReturnType<typeof hljs.highlight>
    )
    const block = (i: number): string => `// ${i}\n` + 'x'.repeat(MAX_HIGHLIGHT_BYTES - 20)
    const n = Math.ceil(MAX_CODE_CACHE_CHARS / block(0).length) + 2
    highlightCode('ts', block(0))
    for (let i = 1; i < n; i++) {
      highlightCode('ts', block(i))
      highlightCode('ts', block(0)) // keep block 0 the most recently used
    }
    const { chars, entries } = highlightCacheStats()
    expect(chars).toBeLessThanOrEqual(MAX_CODE_CACHE_CHARS)
    expect(entries).toBeLessThan(n)

    const spy = vi.mocked(hljs.highlight)
    spy.mockClear()
    highlightCode('ts', block(0)) // recently used: still cached
    expect(spy).not.toHaveBeenCalled()
    highlightCode('ts', block(1)) // the oldest: evicted, tokenized again
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
