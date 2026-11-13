import { describe, expect, it } from 'vitest'
import { tokenize, wordDiff } from '@shared/diff'
import { diffLanguage, highlightLine, hljsRuns, markRuns } from './diffHighlight'

describe('hljsRuns', () => {
  it('turns highlighter spans into runs and decodes entities', () => {
    expect(hljsRuns('<span class="hljs-keyword">const</span> a &lt; <span class="hljs-string">&quot;x&amp;y&#x27;&quot;</span>')).toEqual([
      { text: 'const', cls: 'hljs-keyword' },
      { text: ' a < ', cls: '' },
      { text: '"x&y\'"', cls: 'hljs-string' }
    ])
  })

  it('keeps nested classes and never drops text', () => {
    expect(hljsRuns('<span class="a">x<span class="b">y</span></span>z')).toEqual([
      { text: 'x', cls: 'a' },
      { text: 'y', cls: 'a b' },
      { text: 'z', cls: '' }
    ])
  })
})

describe('highlightLine', () => {
  it('highlights a line by the file extension and round-trips its text', () => {
    const runs = highlightLine(diffLanguage('src/a.ts'), 'const x = "<b>"')
    expect(runs).not.toBeNull()
    expect(runs!.map((r) => r.text).join('')).toBe('const x = "<b>"')
    expect(runs!.some((r) => r.cls.includes('hljs-keyword'))).toBe(true)
  })

  it('leaves unknown languages and empty lines plain', () => {
    expect(highlightLine(diffLanguage('notes.unknownext'), 'x')).toBeNull()
    expect(highlightLine(diffLanguage(undefined), 'x')).toBeNull()
    expect(highlightLine('typescript', '')).toBeNull()
  })
})

describe('markRuns', () => {
  it('splits runs where the changed words start and end', () => {
    const oldText = 'const a = 1'
    const newText = 'const a = 22'
    const runs = highlightLine('typescript', newText)!
    const marked = markRuns(runs, tokenize(newText), wordDiff(oldText, newText).add)
    expect(marked.map((r) => r.text).join('')).toBe(newText)
    expect(marked.filter((r) => r.marked).map((r) => r.text).join('')).toBe('22')
  })

  it('marks nothing without word marks', () => {
    expect(markRuns([{ text: 'ab', cls: '' }], [], undefined)).toEqual([{ text: 'ab', cls: '', marked: false }])
  })
})
