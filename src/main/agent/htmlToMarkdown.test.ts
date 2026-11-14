import { describe, expect, it } from 'vitest'
import { htmlToMarkdown } from './htmlToMarkdown'

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
})
