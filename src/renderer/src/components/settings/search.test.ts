import { afterEach, describe, expect, it, vi } from 'vitest'
import { highlightTerms, matchesTerms, normalizeForSearch, queryTerms, searchHaystack } from './search'

describe('settings search matching', () => {
  it('normalizes case, accents, and punctuation', () => {
    expect(normalizeForSearch('  Café — Dark-Mode/Theme  ')).toBe('cafe dark mode theme')
    expect(normalizeForSearch('run_shell: git *')).toBe('run shell git *')
  })

  it('splits a query into normalized words, empty for blank', () => {
    expect(queryTerms('  API  Key ')).toEqual(['api', 'key'])
    expect(queryTerms('   ')).toEqual([])
  })

  it('needs every word, in any order, matching inside words', () => {
    const hay = searchHaystack(['Permission rules', 'allow deny ask', undefined, 'run_shell git *'])
    expect(matchesTerms(queryTerms('perm'), hay)).toBe(true)
    expect(matchesTerms(queryTerms('git deny'), hay)).toBe(true)
    expect(matchesTerms(queryTerms('shell'), hay)).toBe(true)
    expect(matchesTerms(queryTerms('git theme'), hay)).toBe(false)
  })

  it('matches nothing on an empty query', () => {
    expect(matchesTerms([], 'anything')).toBe(false)
  })
})

describe('highlightTerms', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('highlights the words the matcher used, for a query with punctuation', () => {
    const registry = new Map<string, { ranges: Range[] }>()
    vi.stubGlobal('CSS', { highlights: registry })
    vi.stubGlobal(
      'Highlight',
      class {
        ranges: Range[]
        constructor(...ranges: Range[]) {
          this.ranges = ranges
        }
      }
    )
    const root = document.createElement('div')
    root.innerHTML = '<p>Web search API key</p><p hidden>api key</p>'
    document.body.appendChild(root)
    const clear = highlightTerms(root, 'api-key')
    const found = registry.get('settings-search')?.ranges.map((r) => r.toString())
    expect(found).toEqual(['API', 'key'])
    highlightTerms(root, 'web_search')
    expect(registry.get('settings-search')?.ranges.map((r) => r.toString())).toEqual(['Web', 'search'])
    clear()
    root.remove()
  })
})
