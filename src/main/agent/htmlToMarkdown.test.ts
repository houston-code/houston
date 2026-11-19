import { describe, expect, it } from 'vitest'
import { capNesting, htmlToMarkdown } from './htmlToMarkdown'

const BASE = 'https://docs.example/guide/page.html'
const md = (html: string, fullPage = true): string => htmlToMarkdown(html, { baseUrl: BASE, fullPage })

describe('htmlToMarkdown golden: code', () => {
  it('keeps a <pre> block verbatim, indentation and inner spacing included', () => {
    const html = `<pre><code class="language-python">def f(xs):
    for x in xs:
        if x  &gt;  0:   # two   spaces
            yield x

    return
</code></pre>`
    expect(md(html)).toBe(
      [
        '```python',
        'def f(xs):',
        '    for x in xs:',
        '        if x  >  0:   # two   spaces',
        '            yield x',
        '',
        '    return',
        '```'
      ].join('\n')
    )
  })

  it('keeps highlighted code (one span per token) whole, and takes its language from the <pre>', () => {
    const html =
      '<pre class="lang-ts"><span class="k">const</span> <span class="v">a</span> = <span class="n">1</span>\n' +
      '<span class="k">if</span> (a) {\n  <span class="f">run</span>()\n}</pre>'
    expect(md(html)).toBe('```ts\nconst a = 1\nif (a) {\n  run()\n}\n```')
  })

  it('fences code that itself holds backtick fences with a longer fence', () => {
    expect(md('<pre>```js\nx()\n```</pre>')).toBe('````\n```js\nx()\n```\n````')
  })

  it('renders inline code with backticks, widening them around a backtick in the code', () => {
    expect(md('<p>Run <code>npm  test</code> or <code>a`b</code>.</p>')).toBe('Run `npm test` or ``a`b``.')
  })

  it('keeps a code block inside a list item indented under the item', () => {
    expect(md('<ol><li>Install:<pre>npm i\n  --save</pre></li><li>Done</li></ol>')).toBe(
      ['1. Install:', '', '   ```', '   npm i', '     --save', '   ```', '2. Done'].join('\n')
    )
  })

  it('never lets page text forge a code-block placeholder', () => {
    expect(md('<p>a\u00020\u0003b</p><pre>real</pre>')).toBe('a0b\n\n```\nreal\n```')
  })
})

describe('htmlToMarkdown golden: links', () => {
  it('emits [text](url) with the URL resolved against the page', () => {
    expect(
      md(
        '<p>See <a href="../api/#auth">the <b>auth</b> docs</a>, <a href="https://other.example/x y">this</a> and <a href="/a(b)">that</a>.</p>'
      )
    ).toBe(
      'See [the **auth** docs](https://docs.example/api/#auth), [this](https://other.example/x%20y) and [that](https://docs.example/a%28b%29).'
    )
  })

  it('keeps the text of links with no usable target, and drops empty links', () => {
    expect(md('<p><a href="javascript:alert(1)">click</a> <a>anchor</a> <a href="/x"><img src="i.png"></a>end</p>')).toBe(
      'click anchor end'
    )
  })

  it('escapes brackets in link text and renders images with alt text', () => {
    expect(md('<p><a href="/x">[1]</a> <img alt="A chart" src="/c.png"> <img src="/no-alt.png"></p>')).toBe(
      '[\\[1\\]](https://docs.example/x) ![A chart](https://docs.example/c.png)'
    )
  })
})

describe('htmlToMarkdown golden: entities', () => {
  it('decodes named, decimal and hex entities exactly once', () => {
    expect(md('<p>&lt;div&gt; &amp;amp; &#60;&#x3C; &#169;&copy; caf&eacute; &quot;q&quot; &#39;s&apos; &#x1F600;</p>')).toBe(
      `<div> &amp; << ©© café "q" 's' \u{1F600}`
    )
  })

  it('decodes entities inside code without double-decoding', () => {
    expect(md('<pre>if (a &amp;&amp; b &lt; c) { s = "&amp;lt;" }</pre>')).toBe(
      '```\nif (a && b < c) { s = "&lt;" }\n```'
    )
  })

  it('turns &nbsp; into a plain space outside code', () => {
    expect(md('<p>a&nbsp;&nbsp;b</p>')).toBe('a b')
  })
})

describe('htmlToMarkdown structure', () => {
  it('renders headings, emphasis, lists, quotes, rules and tables', () => {
    const html = `
      <h2>Setup  guide</h2>
      <p>Some <strong>bold</strong> and <em> spaced em </em> text.<br>Next line.</p>
      <ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul>
      <ol start="3"><li>three</li><li>four</li></ol>
      <blockquote><p>quoted</p><p>more</p></blockquote>
      <hr>
      <table><thead><tr><th>Flag</th><th>Meaning</th></tr></thead>
      <tbody><tr><td><code>-v</code></td><td>verbose | loud</td></tr><tr><td>-q</td></tr></tbody></table>`
    expect(md(html)).toBe(
      [
        '## Setup guide',
        '',
        'Some **bold** and _spaced em_ text.',
        'Next line.',
        '',
        '- one',
        '',
        '  - nested',
        '- two',
        '',
        '3. three',
        '4. four',
        '',
        '> quoted',
        '>',
        '> more',
        '',
        '---',
        '',
        '| Flag | Meaning |',
        '| --- | --- |',
        '| `-v` | verbose \\| loud |',
        '| -q | |'
      ].join('\n')
    )
  })

  it('drops scripts, styles, forms and hidden elements', () => {
    const html =
      '<p>keep</p><script>alert(1)</script><style>p{}</style><noscript>js off</noscript>' +
      '<p hidden>h1</p><p aria-hidden="true">h2</p><p style="color:red; display: none">h3</p>' +
      '<svg><text>svg text</text></svg><button>Click</button>'
    expect(md(html)).toBe('keep')
  })

  it('leads with the <title> when the content has no top heading', () => {
    expect(htmlToMarkdown('<title>My &amp; Page</title><p>Body</p>')).toBe('# My & Page\n\nBody')
    expect(htmlToMarkdown('<title>Site</title><h1>Article</h1>')).toBe('# Article')
  })
})

describe('htmlToMarkdown main content', () => {
  const para = (s: string): string => `<p>${s} ${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(3)}</p>`

  it('prefers <main> and drops nav, footer and sidebars', () => {
    const html = `<body>
      <nav><a href="/">Home</a><a href="/docs">Docs</a></nav>
      <div class="sidebar">Related links</div>
      <main>${para('Main text.')}</main>
      <footer>Copyright</footer></body>`
    const out = htmlToMarkdown(html, { baseUrl: BASE })
    expect(out).toContain('Main text.')
    expect(out).not.toMatch(/Home|Related links|Copyright/)
  })

  it('picks the highest-scoring block when nothing is marked as main', () => {
    const html = `<body>
      <div id="menu-wrap"><ul>${Array.from({ length: 10 }, (_, i) => `<li><a href="/${i}">Link ${i}</a></li>`).join('')}</ul></div>
      <div class="post-body">${para('First.')}${para('Second.')}${para('Third.')}</div>
      <div class="cookie-banner">We use cookies</div></body>`
    const out = htmlToMarkdown(html, { baseUrl: BASE })
    expect(out).toContain('First.')
    expect(out).toContain('Third.')
    expect(out).not.toMatch(/Link 3|cookies/)
  })

  it('keeps chrome-looking containers that hold the content itself', () => {
    const html = `<body><div class="sidebar-layout"><article>${para('Inside.')}<pre>code()</pre></article></div></body>`
    const out = htmlToMarkdown(html, { baseUrl: BASE })
    expect(out).toContain('Inside.')
    expect(out).toContain('code()')
  })

  it('falls back to the whole body when no block clearly holds the content', () => {
    const html = '<body><div><p>Short one.</p></div><div><p>Short two.</p></div></body>'
    expect(htmlToMarkdown(html, { baseUrl: BASE })).toBe('Short one.\n\nShort two.')
  })

  it('keeps every article on a listing page', () => {
    const html = `<body><article>${para('A.')}</article><article>${para('B.')}</article></body>`
    const out = htmlToMarkdown(html, { baseUrl: BASE })
    expect(out).toContain('A.')
    expect(out).toContain('B.')
  })

  it('stays fast on a large page', () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => `<div class="row"><p>Item ${i}, with some text.</p></div>`).join('')
    const start = Date.now()
    const out = htmlToMarkdown(`<body><main>${rows}</main></body>`)
    expect(out).toContain('Item 19999')
    expect(Date.now() - start).toBeLessThan(5_000)
  })

  it('stays linear on long whitespace runs inside emphasis and code', () => {
    const n = 100_000
    const start = Date.now()
    const a = htmlToMarkdown(`<body><p><b>x${'<br>'.repeat(n)}y</b></p></body>`)
    const b = htmlToMarkdown(`<body><pre>${' '.repeat(n)}x</pre></body>`)
    expect(a).toContain('**x')
    expect(b).toContain(`${' '.repeat(n)}x`)
    expect(Date.now() - start).toBeLessThan(3_000)
  })

  it('keeps content held in a wrapper whose class or id looks like chrome', () => {
    for (const cls of ['wrapper has-sidebar', 'layout sidebar-right', 'site header-fixed', 'container no-ads']) {
      const html = `<title>T</title><body><div id="app" class="${cls}"><h1>Guide</h1>${para('Wrapped one.')}${para('Wrapped two.')}</div></body>`
      const out = htmlToMarkdown(html, { baseUrl: BASE })
      expect(out).toContain('Wrapped one.')
      expect(out).toContain('Wrapped two.')
    }
  })

  it('keeps a page wrapped in one <form>', () => {
    const html = `<title>T</title><body><form id="aspnetForm"><div id="wrapper"><h1>Permit rules</h1>${para('Form page.')}</div></form></body>`
    expect(htmlToMarkdown(html, { baseUrl: BASE })).toContain('Form page.')
  })

  it('keeps every comment of a discussion page', () => {
    const comment = (s: string): string =>
      `<tr><td><div class="comment"><div class="commtext">${s} ${'A thoughtful reply about the story. '.repeat(3)}</div></div></td></tr>`
    const html = `<body><table class="fatitem"><tr><td><a href="/x">Story title</a></td></tr><tr><td>120 points</td></tr></table>
      <table class="comment-tree">${comment('First comment.')}${comment('Second comment.')}${comment('Third comment.')}</table></body>`
    const out = htmlToMarkdown(html, { baseUrl: BASE })
    expect(out).toContain('First comment.')
    expect(out).toContain('Second comment.')
    expect(out).toContain('Third comment.')
  })

  it('falls back to the unstripped page when stripping would remove most of it', () => {
    const comments = Array.from({ length: 40 }, (_, i) => `<div class="comment">Reply number ${i} here.</div>`).join('')
    const out = htmlToMarkdown(`<body><div>${comments}</div></body>`, { baseUrl: BASE })
    expect(out).toContain('Reply number 0 here.')
    expect(out).toContain('Reply number 39 here.')
  })

  it('keeps headings and callouts inside <main> that carry chrome-like class words', () => {
    const html = `<body><nav><a href="/">Home</a></nav><main>
      <div class="method-header"><h3>GET /users</h3></div>${para('List users.')}
      <aside class="warning"><p>Warning: DELETE cannot be undone.</p></aside>
      <div class="card-header">Rate limits</div><div class="card-body">60 requests per minute.</div></main></body>`
    const out = htmlToMarkdown(html, { baseUrl: BASE })
    expect(out).toContain('GET /users')
    expect(out).toContain('Warning: DELETE cannot be undone.')
    expect(out).toContain('Rate limits')
    expect(out).not.toContain('Home')
  })

  it('survives very deep nesting', () => {
    const depth = 8_000
    const nested = `${'<div>'.repeat(depth)}<p>Deep text.</p>${'</div>'.repeat(depth)}`
    expect(htmlToMarkdown(`<body>${nested}</body>`)).toContain('Deep text.')
    expect(htmlToMarkdown(`<body><p>${'<b>'.repeat(5_000)}Bold deep.</p></body>`)).toContain('Bold deep.')
  })

  it('converts a page nested far deeper still, and a large subtree past the flattening depth', () => {
    // The parser's time grew with the square of the depth, and joining the text of a
    // flattened subtree with the square of its size: each would take minutes here.
    const depth = 100_000
    const nested = `${'<div>'.repeat(depth)}<p>Deep text.</p>${'</div>'.repeat(depth)}`
    expect(htmlToMarkdown(`<body>${nested}</body>`)).toContain('Deep text.')
    const wide = `<body>${'<div>'.repeat(300)}${'<div><p>line</p></div>'.repeat(20_000)}<p>Last line.</p></body>`
    const out = htmlToMarkdown(wide)
    expect(out).toContain('Last line.')
    expect(out.match(/line/g)).toHaveLength(20_001)
  })
})

describe('capNesting', () => {
  const nested = (depth: number, inner: string): string => `${'<div>'.repeat(depth)}${inner}${'</div>'.repeat(depth)}`

  it('returns a page that is not nested past the cap unchanged', () => {
    const html = `<ul>${'<li>item'.repeat(1_000)}</ul><p>a<p>b<br><img src="x">${nested(10, 'deep')}`
    expect(capNesting(html, 20)).toBe(html)
    expect(capNesting('<div><div>a</div></div>', 2)).toBe('<div><div>a</div></div>')
  })

  it('drops the tags nested past the cap, with their end tags, and keeps the text', () => {
    expect(capNesting(nested(4, 'text'), 2)).toBe('<div><div>text</div></div>')
    expect(capNesting('<div><div><b>x</b><i>y</i></div><span>z</span></div>', 1)).toBe('<div>xyz</div>')
    const capped = capNesting(nested(8_000, '<p>Deep text.</p>'))
    expect(capped.match(/<div>/g)).toHaveLength(320)
    expect(capped.match(/<\/div>/g)).toHaveLength(320)
    expect(capped).toContain('<p>Deep text.</p>')
  })

  it('closes back to the matching element, as the parser does for a stray end tag', () => {
    // The </div> closes the unclosed <span> too, so the next <div> is at depth 1 again.
    expect(capNesting('<div><span></div><div><div>x</div></div>', 2)).toBe('<div><span></div><div><div>x</div></div>')
  })

  it('keeps raw-text elements whole past the cap, so their contents never become text', () => {
    const html = `<body>${nested(400, '<script>window.secret = "<div>"</script><style>.a{}</style><p>Seen.</p>')}</body>`
    const out = htmlToMarkdown(html)
    expect(out).toContain('Seen.')
    expect(out).not.toContain('secret')
    expect(out).not.toContain('.a{}')
  })

  it('cuts at the right places after characters outside the Basic Multilingual Plane', () => {
    expect(capNesting('<div>\u{1F600}<div>\u{1F680}<i>a</i></div></div>', 1)).toBe('<div>\u{1F600}\u{1F680}a</div>')
  })

  it('cuts at the right places in a page with CRLF line endings', () => {
    expect(capNesting('<div>\r\n<div>\r\n<div>a\r\nb</div>\r\n</div>\r\n</div>', 1)).toBe('<div>\n\na\nb\n\n</div>')
  })
})

describe('htmlToMarkdown fixes', () => {
  it('keeps the lines of a code block whose lines are block elements', () => {
    const html =
      '<pre data-language="js"><code><div class="ec-line"><div class="code"><span>const a = 1</span></div></div>' +
      '<div class="ec-line"><div class="code"><span>const b = 2</span></div></div></code></pre>'
    expect(md(html)).toBe('```js\nconst a = 1\nconst b = 2\n```')
    // Lines already separated by newline text are not doubled.
    expect(md('<pre><div class="line">a</div>\n<div class="line">b</div></pre>')).toBe('```\na\nb\n```')
  })

  it('keeps cells in their columns across rowspan and colspan', () => {
    const rows =
      '<table><tr><th>Group</th><th>Name</th><th>Age</th></tr>' +
      '<tr><td rowspan="2">A</td><td>Ada</td><td>36</td></tr><tr><td>Bob</td><td>40</td></tr></table>'
    expect(md(rows).split('\n')).toEqual(['| Group | Name | Age |', '| --- | --- | --- |', '| A | Ada | 36 |', '| A | Bob | 40 |'])
    const cols =
      '<table><tr><th colspan="2">Name</th><th>Age</th></tr><tr><td>Ada</td><td>Lovelace</td><td>36</td></tr></table>'
    expect(md(cols).split('\n')).toEqual(['| Name | | Age |', '| --- | --- | --- |', '| Ada | Lovelace | 36 |'])
  })

  it('restores every code block on a line, not only the first', () => {
    const out = md('<h2>Run <pre>a</pre> and <pre>b</pre></h2>')
    expect(out).not.toContain('\u0002')
    expect(out).not.toContain('\u0003')
    expect(out).toContain('a')
    expect(out).toContain('b')
  })

  it("keeps a table's caption as a line above it", () => {
    const html = '<table><caption>Exit <b>codes</b></caption><tr><th>Code</th><th>Meaning</th></tr><tr><td>0</td><td>ok</td></tr></table>'
    expect(md(html).split('\n')).toEqual(['Exit **codes**', '', '| Code | Meaning |', '| --- | --- |', '| 0 | ok |'])
    // A layout table keeps it too.
    expect(md('<table><caption>Note</caption><tr><td>Just text</td></tr></table>')).toBe('Note\n\nJust text')
  })

  it('resolves relative links against <base href>', () => {
    const page = 'https://example.com/docs/guide/intro'
    const abs = '<head><base href="https://example.com/"></head><body><p><a href="api/foo.html">foo</a></p></body>'
    expect(htmlToMarkdown(abs, { baseUrl: page, fullPage: true })).toBe('[foo](https://example.com/api/foo.html)')
    const rel = '<head><base href="../"></head><body><p><a href="api/foo.html">foo</a></p></body>'
    expect(htmlToMarkdown(rel, { baseUrl: page, fullPage: true })).toBe('[foo](https://example.com/docs/api/foo.html)')
  })

  it('prints the title once on a page with a byte-order mark', () => {
    const html = '﻿<!doctype html><html><head><title>My Title</title></head><body><p>Body text.</p></body></html>'
    expect(htmlToMarkdown(html)).toBe('# My Title\n\nBody text.')
  })
})
