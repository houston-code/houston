import { describe, it, expect } from 'vitest'
import { promptMatches, searchPromptHistory } from './promptHistorySearch'

describe('promptMatches', () => {
  it('ignores case and needs every word, in any order', () => {
    expect(promptMatches('Fix the LOGIN bug', 'login fix')).toBe(true)
    expect(promptMatches('Fix the LOGIN bug', 'login deploy')).toBe(false)
    expect(promptMatches('anything', '   ')).toBe(true)
  })
})

describe('searchPromptHistory', () => {
  it('lists matches newest first, up to the limit', () => {
    const history = ['fix login', 'add login tests', 'lint']
    expect(searchPromptHistory(history, 'LOGIN')).toEqual(['add login tests', 'fix login'])
    expect(searchPromptHistory(history, '', 2)).toEqual(['lint', 'add login tests'])
  })
})
