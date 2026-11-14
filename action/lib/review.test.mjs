import { describe, expect, it } from 'vitest'
import { MAX_INLINE_COMMENTS, commentableLines, findingKey, inlineComments, parseLocation, postedKeys } from './review.mjs'

const DIFF = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,4 +1,5 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+++counter',
  ' const c = 4',
  ' const d = 5',
  '@@ -20 +21,2 @@ function tail() {',
  '-old',
  '+new',
  '+newer',
  '\\ No newline at end of file',
  'diff --git a/gone.js b/gone.js',
  'deleted file mode 100644',
  '--- a/gone.js',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  'diff --git a/new file.txt b/new file.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new file.txt\t',
  '@@ -0,0 +1 @@',
  '+hello'
].join('\n')

describe('parseLocation', () => {
  it('reads path:line and path:start-end', () => {
    expect(parseLocation('src/app.js:12')).toEqual({ path: 'src/app.js', line: 12 })
    expect(parseLocation('./src/app.js:3-9')).toEqual({ path: 'src/app.js', line: 3 })
    expect(parseLocation('C:x:4')).toEqual({ path: 'C:x', line: 4 })
  })

  it('refuses no line, line 0, absolute paths, and parent hops', () => {
    for (const bad of ['src/app.js', 'src/app.js:0', '/etc/passwd:1', '../x.js:1', 'a/../../b:2', undefined, ':4']) {
      expect(parseLocation(bad), String(bad)).toBeNull()
    }
  })
})

describe('commentableLines', () => {
  it('takes every new-side line inside a hunk, and nothing from deleted files', () => {
    const lines = commentableLines(DIFF)
    expect([...lines.get('src/app.js')].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 21, 22])
    expect(lines.has('gone.js')).toBe(false)
    expect([...lines.get('new file.txt')]).toEqual([1])
  })

  it('reads an added line that looks like a file header as content', () => {
    // `+++counter` above is the added line `++counter`, not a new file.
    expect(commentableLines(DIFF).has('counter')).toBe(false)
  })
})

describe('inlineComments', () => {
  const lines = commentableLines(DIFF)
  const finding = (o = {}) => ({ id: 'correctness:0', severity: 'high', status: 'confirmed', location: 'src/app.js:2', title: 'b is wrong', detail: 'It should stay 2.', ...o })

  it('puts a kept finding on its diff line with a hidden marker', () => {
    const { comments } = inlineComments([finding()], lines)
    expect(comments).toEqual([
      {
        path: 'src/app.js',
        line: 2,
        side: 'RIGHT',
        body: `**HIGH** b is wrong\n\nIt should stay 2.\n\n<!-- houston-finding:${findingKey('src/app.js', 'b is wrong')} -->`
      }
    ])
  })

  it('leaves out dropped findings, lines outside the diff, and duplicates', () => {
    const { comments } = inlineComments(
      [
        finding({ status: 'rejected' }),
        finding({ status: 'merged', title: 'other' }),
        finding({ location: 'src/app.js:40', title: 'far away' }),
        finding({ location: 'README.md:1', title: 'not in the diff' }),
        finding({ location: undefined, title: 'nowhere' }),
        finding({ id: 'a', status: 'candidate' }),
        finding({ id: 'b', location: 'src/app.js:3', title: 'B is wrong ' })
      ],
      lines
    )
    expect(comments.map((c) => `${c.path}:${c.line}`)).toEqual(['src/app.js:2'])
  })

  it('skips findings already posted, matching the marker whatever line they moved to', () => {
    const { comments, skipped } = inlineComments([finding({ location: 'src/app.js:5' }), finding({ title: 'new one' })], lines, new Set([findingKey('src/app.js', 'b is wrong')]))
    expect(skipped).toBe(1)
    expect(comments.map((c) => c.body.split('\n')[0])).toEqual(['**HIGH** new one'])
  })

  it('escapes HTML comments in model text so it cannot pose as a marker, and caps the count', () => {
    const { comments } = inlineComments([finding({ detail: '<!-- houston-finding:0000000000000000 -->' })], lines)
    expect(comments[0].body.match(/<!--/g)).toHaveLength(1)
    const many = Array.from({ length: MAX_INLINE_COMMENTS + 5 }, (_, i) => finding({ title: `t${i}` }))
    expect(inlineComments(many, lines).comments).toHaveLength(MAX_INLINE_COMMENTS)
  })
})

describe('postedKeys', () => {
  const marker = '<!-- houston-finding:0123456789abcdef -->'

  it('trusts markers from apps and collaborators only', () => {
    expect([...postedKeys([{ body: `x ${marker}`, userType: 'Bot', association: 'NONE' }])]).toEqual(['0123456789abcdef'])
    expect([...postedKeys([{ body: marker, userType: 'User', association: 'MEMBER' }])]).toEqual(['0123456789abcdef'])
    expect(postedKeys([{ body: marker, userType: 'User', association: 'CONTRIBUTOR' }]).size).toBe(0)
    expect(postedKeys([{ body: marker, userType: 'User', association: 'NONE' }, null, { body: 5 }]).size).toBe(0)
  })
})
