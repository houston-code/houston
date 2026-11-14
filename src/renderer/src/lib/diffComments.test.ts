import { afterEach, describe, expect, it } from 'vitest'
import { anchorComments, clearAllDrafts, commentPlace, draftKey, getDrafts, newCommentId, setDrafts, shownLines, sortComments, type DraftComment } from './diffComments'

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

  it('anchors a comment only where its line still holds its code', () => {
    const lines = shownLines(
      [
        {
          path: 'a.ts',
          status: 'modified',
          added: 1,
          removed: 1,
          binary: false,
          hunks: [
            {
              header: '@@ -10,2 +10,2 @@',
              lines: [
                { type: 'ctx', text: 'keep' },
                { type: 'del', text: 'old' },
                { type: 'add', text: 'new' }
              ]
            }
          ]
        }
      ],
      300
    )
    expect([...lines.entries()]).toEqual([
      [commentPlace({ path: 'a.ts', side: 'new', line: 10 }), 'keep'],
      [commentPlace({ path: 'a.ts', side: 'old', line: 11 }), 'old'],
      [commentPlace({ path: 'a.ts', side: 'new', line: 11 }), 'new']
    ])
    const at = (side: 'old' | 'new', line: number, code: string): DraftComment => ({ ...c('a.ts', line, side), code })
    const ok = [at('new', 10, 'keep'), at('old', 11, 'old')]
    const stale = [at('new', 11, 'something else'), at('new', 99, 'gone'), { ...c('b.ts', 1), code: 'x' }]
    const { anchored, outdated } = anchorComments([...ok, ...stale], lines)
    expect(anchored).toEqual(ok)
    expect(outdated).toEqual(stale)
  })
})

