import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown, safeHref, type Block, type Inline } from './markdown'

/** Collapse an inline tree to a compact string for readable assertions. */
function inlineStr(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
          return n.value
        case 'code':
          return `\`${n.value}\``
        case 'strong':
          return `**${inlineStr(n.children)}**`
        case 'em':
          return `*${inlineStr(n.children)}*`
        case 'del':
          return `~~${inlineStr(n.children)}~~`
        case 'link':
          return `[${inlineStr(n.children)}](${n.href})`
        case 'br':
          return '\\n'
      }
    })
    .join('')
}

describe('parseInline', () => {
  it('renders plain text unchanged', () => {
    expect(inlineStr(parseInline('hello world'))).toBe('hello world')
  })

  it('parses bold and italic', () => {
    expect(inlineStr(parseInline('**bold** and *italic*'))).toBe('**bold** and *italic*')
    expect(inlineStr(parseInline('__bold__ and _italic_'))).toBe('**bold** and *italic*')
  })

  it('parses bold-italic combos', () => {
    const nodes = parseInline('***wow***')
    expect(nodes).toEqual([
      { type: 'strong', children: [{ type: 'em', children: [{ type: 'text', value: 'wow' }] }] }
    ])
  })

  it('parses strikethrough', () => {
    expect(inlineStr(parseInline('~~gone~~'))).toBe('~~gone~~')
  })

  it('does not treat intra-word underscores as emphasis', () => {
    expect(inlineStr(parseInline('some_var_name here'))).toBe('some_var_name here')
  })

  it('does not open emphasis across a space', () => {
    expect(inlineStr(parseInline('a * b * c'))).toBe('a * b * c')
  })

  it('parses inline code and leaves its contents literal', () => {
    const nodes = parseInline('use `npm **run** test` now')
    expect(nodes[1]).toEqual({ type: 'code', value: 'npm **run** test' })
  })

  it('does not parse emphasis inside code spans', () => {
    expect(inlineStr(parseInline('`*not italic*`'))).toBe('`*not italic*`')
  })

  it('parses links', () => {
    const nodes = parseInline('see [the docs](https://example.com/x)')
    expect(nodes.find((n) => n.type === 'link')).toEqual({
      type: 'link',
      href: 'https://example.com/x',
      children: [{ type: 'text', value: 'the docs' }]
    })
  })

  it('parses emphasis inside link text', () => {
    expect(inlineStr(parseInline('[**bold link**](https://a.com)'))).toBe('[**bold link**](https://a.com)')
  })

  it('linkifies bare and angle-bracket urls', () => {
    expect(inlineStr(parseInline('go to https://x.com.'))).toBe('go to [https://x.com](https://x.com).')
    expect(inlineStr(parseInline('go to <https://x.com>'))).toBe('go to [https://x.com](https://x.com)')
  })

  it('honors backslash escapes', () => {
    expect(inlineStr(parseInline('not \\*italic\\*'))).toBe('not *italic*')
  })

  it('keeps a code span with double backticks containing a backtick', () => {
    expect(parseInline('`` a`b ``')[0]).toEqual({ type: 'code', value: 'a`b' })
  })
})

describe('parseMarkdown blocks', () => {
  it('parses headings at each level', () => {
    const blocks = parseMarkdown('# H1\n## H2\n###### H6')
    expect(blocks.map((b) => (b.type === 'heading' ? b.level : null))).toEqual([1, 2, 6])
  })

  it('parses a paragraph and joins soft-wrapped lines', () => {
    const blocks = parseMarkdown('one two\nthree four')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('paragraph')
    expect(inlineStr((blocks[0] as Extract<Block, { type: 'paragraph' }>).children)).toBe(
      'one two three four'
    )
  })

  it('separates paragraphs on a blank line', () => {
    const blocks = parseMarkdown('first\n\nsecond')
    expect(blocks).toHaveLength(2)
    expect(blocks.every((b) => b.type === 'paragraph')).toBe(true)
  })

  it('parses a fenced code block with a language and preserves contents verbatim', () => {
    const blocks = parseMarkdown('```ts\nconst x = 1\n# not a heading\n```')
    expect(blocks[0]).toEqual({ type: 'code', lang: 'ts', value: 'const x = 1\n# not a heading' })
  })

  it('parses an unfinished fence to end of input', () => {
    const blocks = parseMarkdown('```\nstill code')
    expect(blocks[0]).toEqual({ type: 'code', lang: '', value: 'still code' })
  })

  it('parses an unordered list', () => {
    const blocks = parseMarkdown('- a\n- b\n- c')
    expect(blocks[0].type).toBe('list')
    const list = blocks[0] as Extract<Block, { type: 'list' }>
    expect(list.ordered).toBe(false)
    expect(list.items).toHaveLength(3)
  })

  it('parses an ordered list with a custom start', () => {
    const blocks = parseMarkdown('3. third\n4. fourth')
    const list = blocks[0] as Extract<Block, { type: 'list' }>
    expect(list.ordered).toBe(true)
    expect(list.start).toBe(3)
    expect(list.items).toHaveLength(2)
  })

  it('parses nested lists', () => {
    const blocks = parseMarkdown('- top\n  - nested a\n  - nested b\n- top2')
    const list = blocks[0] as Extract<Block, { type: 'list' }>
    expect(list.items).toHaveLength(2)
    const nested = list.items[0].blocks.find((b) => b.type === 'list')
    expect(nested).toBeDefined()
    expect((nested as Extract<Block, { type: 'list' }>).items).toHaveLength(2)
  })

  it('parses a blockquote with nested markdown', () => {
    const blocks = parseMarkdown('> quoted **bold**\n> more')
    expect(blocks[0].type).toBe('blockquote')
    const inner = (blocks[0] as Extract<Block, { type: 'blockquote' }>).children
    expect(inner[0].type).toBe('paragraph')
  })

  it('parses a thematic break', () => {
    expect(parseMarkdown('a\n\n---\n\nb').map((b) => b.type)).toEqual([
      'paragraph',
      'hr',
      'paragraph'
    ])
  })

  it('parses a GFM table with alignment', () => {
    const md = '| Name | Age |\n| :--- | ---: |\n| Bob | 9 |\n| Sue | 12 |'
    const blocks = parseMarkdown(md)
    expect(blocks[0].type).toBe('table')
    const table = blocks[0] as Extract<Block, { type: 'table' }>
    expect(table.align).toEqual(['left', 'right'])
    expect(table.header).toHaveLength(2)
    expect(table.rows).toHaveLength(2)
    expect(inlineStr(table.rows[0][0])).toBe('Bob')
  })

  it('keeps a pipe line without a delimiter row as a paragraph', () => {
    const blocks = parseMarkdown('a | b | c')
    expect(blocks[0].type).toBe('paragraph')
  })

  it('handles a realistic mixed document', () => {
    const md = [
      '# Title',
      '',
      'Intro with `code` and **bold**.',
      '',
      '- one',
      '- two',
      '',
      '```js',
      'foo()',
      '```'
    ].join('\n')
    const types = parseMarkdown(md).map((b) => b.type)
    expect(types).toEqual(['heading', 'paragraph', 'list', 'code'])
  })
})

describe('safeHref', () => {
  it('allows http, https and mailto', () => {
    expect(safeHref('https://x.com')).toBe('https://x.com')
    expect(safeHref('http://x.com')).toBe('http://x.com')
    expect(safeHref('mailto:a@b.com')).toBe('mailto:a@b.com')
  })

  it('rejects javascript, data, file and protocol-relative urls', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('data:text/html,evil')).toBeNull()
    expect(safeHref('file:///etc/passwd')).toBeNull()
    expect(safeHref('//evil.com')).toBeNull()
    expect(safeHref('docs/readme.md')).toBeNull()
  })

  it('allows in-document anchors', () => {
    expect(safeHref('#section')).toBe('#section')
  })
})

describe('parser is bounded on adversarial input (no O(n^2) freeze)', () => {
  // The inline scanners (links, code, emphasis, autolinks) scan forward to find a
  // close; thousands of unclosed constructs used to compound to O(n^2) and freeze
  // the renderer. A shared scan budget caps the work to O(n).
  const fast = (label: string, src: string): void => {
    const t0 = performance.now()
    const blocks = parseMarkdown(src)
    const ms = performance.now() - t0
    expect(Array.isArray(blocks)).toBe(true)
    // Generous bound: the fixed parser does this in ~30ms; the quadratic version
    // would take many seconds at this size.
    expect(ms, `${label} took ${ms.toFixed(0)}ms`).toBeLessThan(2000)
  }

  it('handles a flood of unclosed links quickly', () => {
    fast('unclosed-links', '[a]('.repeat(80_000))
  })
  it('handles a flood of unclosed angle brackets quickly', () => {
    fast('angle-brackets', '<'.repeat(300_000))
  })
  it('handles a flood of emphasis delimiters quickly', () => {
    fast('emphasis', '*_~'.repeat(100_000))
  })

  it('still parses a normal link/bold/code after the budget guard', () => {
    const blocks = parseMarkdown('See [docs](https://example.com) for **bold** and `code`.')
    const para = blocks[0] as Extract<Block, { type: 'paragraph' }>
    expect(para.type).toBe('paragraph')
    const kinds = para.children.map((c) => c.type)
    expect(kinds).toContain('link')
    expect(kinds).toContain('strong')
    expect(kinds).toContain('code')
  })
})
