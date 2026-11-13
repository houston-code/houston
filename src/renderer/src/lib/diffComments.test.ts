import { afterEach, describe, expect, it } from 'vitest'
import { clearAllDrafts, commentPlace, draftKey, getDrafts, newCommentId, setDrafts, sortComments, type DraftComment } from './diffComments'

const c = (path: string, line: number, side: 'old' | 'new' = 'new'): DraftComment => ({
  id: newCommentId(),
  path,
  line,
  side,
  code: '',
  body: 'b'
})

describe('diffComments', () => {
  afterEach(() => clearAllDrafts())

  it('keeps drafts per chat and folder, and forgets an emptied list', () => {
    const a = draftKey('c1', '/ws')
    const b = draftKey('c2', '/ws')
    setDrafts(a, [c('x', 1)])
    expect(getDrafts(a)).toHaveLength(1)
    expect(getDrafts(b)).toEqual([])
    setDrafts(a, [])
    expect(getDrafts(a)).toEqual([])
    expect(draftKey(null, null)).not.toBe(draftKey('', '/ws'))
  })

  it('orders comments by file, line, and removed line first', () => {
    const list = [c('b', 1), c('a', 5), c('a', 2, 'new'), c('a', 2, 'old')]
    expect(sortComments(list).map((x) => `${x.path}:${x.line}:${x.side}`)).toEqual(['a:2:old', 'a:2:new', 'a:5:new', 'b:1:new'])
  })

  it('names a place by file, side and line, and mints distinct ids', () => {
    expect(commentPlace({ path: 'a', side: 'old', line: 3 })).not.toBe(commentPlace({ path: 'a', side: 'new', line: 3 }))
    expect(newCommentId()).not.toBe(newCommentId())
  })
})
