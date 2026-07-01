import { describe, it, expect } from 'vitest'
import { makePainter } from './tui'
import { renderMarkdownAnsi, splitFinalizedBlocks, MarkdownStream } from './markdown-ansi'

const paint = makePainter(false)
const render = (src: string, width = 0): string => renderMarkdownAnsi(src, { paint, width })

describe('renderMarkdownAnsi', () => {
  it('renders headings, keeping the # markers', () => {
    expect(render('# Title')).toContain('# Title')
  })

  it('renders inline emphasis and code without the markdown punctuation', () => {
    const out = render('a **bold** and `code` and *em* word')
    expect(out).toContain('bold')
    expect(out).toContain('code')
    expect(out).toContain('em')
    expect(out).not.toContain('**')
    expect(out).not.toContain('`')
  })

  it('renders a bulleted list with bullets', () => {
    const out = render('- one\n- two')
    expect(out).toContain('• one')
    expect(out).toContain('• two')
  })

  it('renders an ordered list with numbers', () => {
    const out = render('1. first\n2. second')
    expect(out).toContain('1. first')
    expect(out).toContain('2. second')
  })

  it('renders a fenced code block with a gutter and no fence lines', () => {
    const out = render('```ts\nconst x = 1\n```')
    expect(out).toContain('const x = 1')
    expect(out).not.toContain('```')
    expect(out).toContain('│ ') // gutter
  })

  it('renders a blockquote with a gutter', () => {
    expect(render('> quoted')).toContain('│ quoted')
  })

  it('renders a link as text plus its url', () => {
    const out = render('[docs](https://example.com)')
    expect(out).toContain('docs')
    expect(out).toContain('(https://example.com)')
  })

  it('renders a table with aligned columns', () => {
    const out = render('| a | b |\n| - | - |\n| 1 | 2 |')
    expect(out).toContain('a')
    expect(out).toContain('b')
    expect(out).toContain('1')
    expect(out).toContain('2')
  })

  it('wraps paragraphs at the given width', () => {
    const out = render('the quick brown fox jumps', 9)
    expect(out.split('\n').every((l) => l.length <= 9)).toBe(true)
  })

  it('uses an injected highlighter for code blocks when provided', () => {
    const out = renderMarkdownAnsi('```ts\ncode\n```', {
      paint,
      highlight: (lang, code) => `[${lang}]${code.trim().toUpperCase()}`
    })
    expect(out).toContain('[ts]CODE')
  })
})

describe('splitFinalizedBlocks', () => {
  it('finalizes blocks up to the last blank line', () => {
    const { complete, rest } = splitFinalizedBlocks('para one\n\npara two')
    expect(complete).toBe('para one')
    expect(rest).toBe('para two')
  })

  it('keeps everything buffered when no blank line yet', () => {
    const { complete, rest } = splitFinalizedBlocks('still typing a paragraph')
    expect(complete).toBe('')
    expect(rest).toBe('still typing a paragraph')
  })

  it('does not split inside an open code fence', () => {
    // The blank line is inside the fence, so nothing is finalized yet.
    const { complete } = splitFinalizedBlocks('```\ncode\n\nmore code')
    expect(complete).toBe('')
  })

  it('finalizes a closed fence followed by a blank line', () => {
    const { complete, rest } = splitFinalizedBlocks('```\ncode\n```\n\nnext')
    expect(complete).toContain('```')
    expect(rest).toBe('next')
  })
})

describe('MarkdownStream', () => {
  it('emits finalized blocks on push and the remainder on flush', () => {
    const s = new MarkdownStream({ paint, width: 0 })
    // No blank line yet → nothing emitted.
    expect(s.push('# Heading\n')).toBe('')
    // A blank line finalizes the heading block.
    const emitted = s.push('\nnext paragraph')
    expect(emitted).toContain('# Heading')
    expect(emitted).not.toContain('next paragraph')
    // flush renders the trailing incomplete block.
    expect(s.flush()).toContain('next paragraph')
    expect(s.empty).toBe(true)
  })

  it('does not emit an unclosed code fence until it closes', () => {
    const s = new MarkdownStream({ paint, width: 0 })
    expect(s.push('```ts\nconst x = 1\n')).toBe('') // fence still open
    const out = s.flush()
    expect(out).toContain('const x = 1')
  })
})
