import { describe, expect, it } from 'vitest'
import { matchesTerms, normalizeForSearch, queryTerms, searchHaystack } from './search'

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
