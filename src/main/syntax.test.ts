import { describe, it, expect } from 'vitest'
import { makePainter } from './tui'
import {
  fenceLangToHljs,
  highlightToHtml,
  hljsStyleFor,
  htmlToAnsi,
  type HljsLike
} from './syntax'

describe('fenceLangToHljs', () => {
  it('maps common aliases', () => {
    expect(fenceLangToHljs('ts')).toBe('typescript')
    expect(fenceLangToHljs('TS')).toBe('typescript')
    expect(fenceLangToHljs('sh')).toBe('bash')
    expect(fenceLangToHljs('py')).toBe('python')
  })
  it('returns null for unknown languages', () => {
    expect(fenceLangToHljs('brainfuck')).toBeNull()
    expect(fenceLangToHljs('')).toBeNull()
  })
})

describe('highlightToHtml', () => {
  const hljs: HljsLike = {
    getLanguage: (n) => (n === 'typescript' ? {} : undefined),
    highlight: (code) => ({ value: `<span class="hljs-keyword">${code}</span>` })
  }
  it('returns hljs HTML for a known language', () => {
    expect(highlightToHtml(hljs, 'ts', 'const')).toContain('hljs-keyword')
  })
  it('returns null when hljs does not know the language', () => {
    expect(highlightToHtml(hljs, 'python', 'x')).toBeNull() // getLanguage returns undefined
    expect(highlightToHtml(hljs, 'brainfuck', 'x')).toBeNull() // unmapped
  })
  it('returns null when hljs throws', () => {
    const throwing: HljsLike = {
      getLanguage: () => ({}),
      highlight: () => {
        throw new Error('boom')
      }
    }
    expect(highlightToHtml(throwing, 'ts', 'x')).toBeNull()
  })
})

describe('hljsStyleFor', () => {
  it('maps scopes to styles', () => {
    expect(hljsStyleFor('hljs-keyword')).toBe('magenta')
    expect(hljsStyleFor('hljs-string')).toBe('green')
    expect(hljsStyleFor('hljs-comment')).toBe('dim')
    expect(hljsStyleFor('hljs-number')).toBe('cyan')
    expect(hljsStyleFor('hljs-attr')).toBe('yellow')
  })
  it('returns null for unknown scopes', () => {
    expect(hljsStyleFor('hljs-nonsense')).toBeNull()
    expect(hljsStyleFor('')).toBeNull()
  })
})

describe('htmlToAnsi', () => {
  const paint = makePainter(true)
  const plain = makePainter(false)

  it('colors token spans and passes through plain text', () => {
    const html = '<span class="hljs-keyword">const</span> x = <span class="hljs-number">1</span>'
    const out = htmlToAnsi(html, paint)
    expect(out).toContain('const')
    expect(out).toContain('x = ')
    expect(out).toContain('\x1b[35m') // magenta for keyword
    expect(out).toContain('\x1b[36m') // cyan for number
  })

  it('unescapes HTML entities', () => {
    expect(htmlToAnsi('a &lt;b&gt; &amp; c &#x27;d&#x27;', plain)).toBe("a <b> & c 'd'")
  })

  it('handles nested spans, coloring by the innermost scope', () => {
    const html = '<span class="hljs-string">"<span class="hljs-subst">x</span>"</span>'
    const out = htmlToAnsi(html, plain) // color off → just content survives
    expect(out).toBe('"x"')
  })

  it('leaves unrecognized scopes uncolored', () => {
    expect(htmlToAnsi('<span class="hljs-punctuation">x</span>', paint)).not.toContain('\x1b[')
  })
})
