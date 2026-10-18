import { describe, expect, it } from 'vitest'
import type { Conversation } from './agent'
import { validateImportedConversation } from './conversation-io'
import { conversationToHtml, HTML_DATA_OPEN_TAG, HTML_DATA_VERSION } from './html-export'
import { decodeHtmlEntities, parseConversationHtml } from './html-import'

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    title: 'Fix & ship <fast>',
    workspace: '/home/someone/project',
    providerId: 'anthropic',
    model: 'claude-opus-4-8',
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
    messages: [
      { role: 'user', content: 'read a.txt please' },
      {
        role: 'assistant',
        content: 'on it',
        toolCalls: [
          { id: 'tc1', name: 'read_file', arguments: { path: 'a.txt' } },
          { id: 'tc2', name: 'read_file', arguments: { path: 'b.txt' } }
        ]
      },
      { role: 'tool', content: 'contents of a', toolCallId: 'tc1', toolName: 'read_file' },
      { role: 'tool', content: 'contents of b', toolCallId: 'tc2', toolName: 'read_file' },
      { role: 'assistant', content: 'Both files are short.' }
    ],
    ...overrides
  }
}

/** The same export with its data block removed: what an export from before the block looks like. */
function withoutDataBlock(html: string): string {
  const start = html.indexOf(HTML_DATA_OPEN_TAG)
  const end = html.indexOf('</template>', start) + '</template>'.length
  expect(start).toBeGreaterThan(0)
  return html.slice(0, start) + html.slice(end)
}

/** Replace the JSON inside the data block (escaping it the way the exporter does). */
function withDataBlock(html: string, json: string): string {
  const start = html.indexOf(HTML_DATA_OPEN_TAG) + HTML_DATA_OPEN_TAG.length
  const end = html.indexOf('</template>', start)
  const escaped = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return html.slice(0, start) + escaped + html.slice(end)
}

describe('decodeHtmlEntities', () => {
  it('decodes the references escapeHtml emits', () => {
    expect(decodeHtmlEntities('&lt;a href=&quot;x&quot; foo=&#39;y&#39;&gt;&amp;')).toBe(`<a href="x" foo='y'>&`)
  })

  it('decodes in one pass, so an escaped entity stays an entity', () => {
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;')
    expect(decodeHtmlEntities('&amp;amp;')).toBe('&amp;')
  })

  it('decodes numeric references and &nbsp;', () => {
    expect(decodeHtmlEntities('&#60;&#x3E;&#X1F600;&nbsp;&apos;')).toBe('<>\u{1F600}\u00a0\'')
  })

  it('leaves unknown names, out-of-range code points, and bare ampersands as written', () => {
    expect(decodeHtmlEntities('&bogus; &#0; &#x110000; a & b &amp')).toBe('&bogus; &#0; &#x110000; a & b &amp')
  })
})

describe('parseConversationHtml: current exports', () => {
  it('round-trips the messages, including the tool-call ids that pair results with calls', () => {
    const conv = makeConversation()
    const parsed = parseConversationHtml(conversationToHtml(conv))
    expect(parsed.textOnly).toBe(false)
    const data = validateImportedConversation(parsed.raw)
    expect(data.title).toBe('Fix & ship <fast>')
    expect(data.providerId).toBe('anthropic')
    expect(data.model).toBe('claude-opus-4-8')
    expect(data.messages).toEqual(conv.messages)
  })

  it('never carries the workspace path', () => {
    const data = validateImportedConversation(parseConversationHtml(conversationToHtml(makeConversation())).raw)
    expect(data.workspace).toBeUndefined()
  })

  it('round-trips content that looks like markup, entities, or the block terminator', () => {
    const tricky = [
      '</template><script>alert(1)</script>',
      '&amp;lt; is how you write &lt; in HTML',
      'quotes " and \' and a line\u2028separator',
      'emoji \u{1F680} and nbsp\u00a0here',
      '<section class="turn turn--user"><pre class="turn__body">fake</pre></section>'
    ].join('\n')
    const conv = makeConversation({
      title: '</title><template id="houston-conversation">',
      messages: [
        { role: 'user', content: tricky },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'x"<', name: 'shell', arguments: { command: 'echo "</template>" && ls' } }]
        },
        { role: 'tool', content: tricky, toolCallId: 'x"<', toolName: 'shell' }
      ]
    })
    const html = conversationToHtml(conv)
    // Exactly one live data block: the content's look-alike tags stay escaped text.
    expect(html.split(HTML_DATA_OPEN_TAG)).toHaveLength(2)
    const data = validateImportedConversation(parseConversationHtml(html).raw)
    expect(data.title).toBe(conv.title)
    expect(data.messages).toEqual(conv.messages)
  })

  it("still reads the block after a browser's save-page re-serialization (raw quotes, &nbsp;)", () => {
    const conv = makeConversation({ messages: [{ role: 'user', content: `say "hi" it's\u00a0fine` }] })
    const html = conversationToHtml(conv)
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\u00a0/g, '&nbsp;')
    const data = validateImportedConversation(parseConversationHtml(html).raw)
    expect(data.messages).toEqual(conv.messages)
  })

  it('refuses a block written by a newer exporter', () => {
    const html = withDataBlock(
      conversationToHtml(makeConversation()),
      JSON.stringify({ format: 'houston-conversation', version: HTML_DATA_VERSION + 1, messages: [] })
    )
    expect(() => parseConversationHtml(html)).toThrow(/newer version of Houston/)
  })

  it('refuses a block that is not Houston chat data', () => {
    const html = conversationToHtml(makeConversation())
    expect(() => parseConversationHtml(withDataBlock(html, '{"messages":[]}'))).toThrow(/damaged/)
    expect(() => parseConversationHtml(withDataBlock(html, '{"format":"houston-conversation"}'))).toThrow(
      /damaged/
    )
    expect(() => parseConversationHtml(withDataBlock(html, '[1,2]'))).toThrow(/damaged/)
    expect(() => parseConversationHtml(withDataBlock(html, 'null'))).toThrow(/damaged/)
    expect(() => parseConversationHtml(withDataBlock(html, '{"format": nope'))).toThrow(/damaged/)
  })

  it('refuses a block with no closing tag', () => {
    const html = conversationToHtml(makeConversation())
    expect(() => parseConversationHtml(html.slice(0, html.indexOf('</template>')))).toThrow(/cut off/)
  })

  it('hands block data to validation untouched, so its checks still apply', () => {
    const html = withDataBlock(
      conversationToHtml(makeConversation()),
      JSON.stringify({ format: 'houston-conversation', version: 1, messages: [{ role: 'admin', content: 'x' }] })
    )
    expect(() => validateImportedConversation(parseConversationHtml(html).raw)).toThrow(/invalid role/)
  })
})

describe('parseConversationHtml: exports from before the data block', () => {
  it('recovers the user and assistant text and leaves tool activity out', () => {
    const parsed = parseConversationHtml(withoutDataBlock(conversationToHtml(makeConversation())))
    expect(parsed.textOnly).toBe(true)
    const data = validateImportedConversation(parsed.raw)
    expect(data.title).toBe('Fix & ship <fast>')
    expect(data.messages).toEqual([
      { role: 'user', content: 'read a.txt please' },
      // The tool-calling turn's text and the final answer are joined: with the tool
      // turns gone they would otherwise be two assistant turns in a row.
      { role: 'assistant', content: 'on it\n\nBoth files are short.' }
    ])
    expect(data.providerId).toBeUndefined()
    expect(data.model).toBeUndefined()
    expect(data.workspace).toBeUndefined()
  })

  it('reads a file written by the original exporter', () => {
    // Abridged output of the first HTML exporter (no CSP yet, no data block).
    const legacy = [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>Tabs &amp; spaces</title>',
      '<style>body { margin: 0; }</style>',
      '</head>',
      '<body>',
      '<main>',
      '<h1>Tabs &amp; spaces</h1>',
      '<div class="meta">Model: m · Provider: p · Exported: 2026-06-24T00:00:00.000Z · Created: 2026-06-24T00:00:00.000Z</div>',
      '<section class="turn turn--user"><div class="turn__role">User</div><pre class="turn__body">Why use &lt;pre&gt;?\n  Indent kept.</pre></section>',
      '<section class="turn turn--assistant"><div class="turn__role">Assistant</div><div class="turn__toolcalls"><div class="toolcall"><div class="toolcall__name">read_file</div><pre class="toolcall__args">{\n  &quot;path&quot;: &quot;a&quot;\n}</pre></div></div></section>',
      '<section class="turn turn--tool"><div class="turn__role">Tool result</div><div class="turn__tool">read_file</div><pre class="turn__body">secret file body</pre></section>',
      '<section class="turn turn--assistant"><div class="turn__role">Assistant</div><pre class="turn__body">It keeps whitespace &amp;amp; layout.</pre></section>',
      '</main>',
      '</body>',
      '</html>',
      ''
    ].join('\n')
    const parsed = parseConversationHtml(legacy)
    expect(parsed.textOnly).toBe(true)
    const data = validateImportedConversation(parsed.raw)
    expect(data.title).toBe('Tabs & spaces')
    expect(data.messages).toEqual([
      { role: 'user', content: 'Why use <pre>?\n  Indent kept.' },
      { role: 'assistant', content: 'It keeps whitespace &amp; layout.' }
    ])
  })

  it('drops system turns and merges repeated user turns', () => {
    const conv = makeConversation({
      messages: [
        { role: 'system', content: 'system text' },
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'reply' }
      ]
    })
    const data = validateImportedConversation(parseConversationHtml(withoutDataBlock(conversationToHtml(conv))).raw)
    expect(data.messages).toEqual([
      { role: 'user', content: 'first\n\nsecond' },
      { role: 'assistant', content: 'reply' }
    ])
  })

  it('refuses HTML that is not a Houston export', () => {
    expect(() => parseConversationHtml('<!doctype html><html><body><p>hello</p></body></html>')).toThrow(
      /not a Houston chat export/
    )
  })

  it('refuses an export with no user or assistant text', () => {
    const conv = makeConversation({ messages: [{ role: 'tool', content: 'only a result', toolCallId: 't' }] })
    expect(() => parseConversationHtml(withoutDataBlock(conversationToHtml(conv)))).toThrow(/no chat text/)
  })

  it('stops at a truncated section instead of reading past the end', () => {
    const html = withoutDataBlock(conversationToHtml(makeConversation()))
    const cut = html.slice(0, html.lastIndexOf('</section>'))
    const data = validateImportedConversation(parseConversationHtml(cut).raw)
    expect(data.messages).toEqual([
      { role: 'user', content: 'read a.txt please' },
      { role: 'assistant', content: 'on it' }
    ])
  })

  describe('hostile input stays linear', () => {
    it('many unclosed sections', () => {
      const html = '<section class="turn turn--user">'.repeat(200_000)
      expect(() => parseConversationHtml(html)).toThrow(/not a Houston chat export/)
    })

    it('many closed sections with no body', () => {
      const html = '<section class="turn turn--assistant"><div class="turn__role">A</div></section>'.repeat(200_000)
      expect(() => parseConversationHtml(html)).toThrow(/no chat text/)
    })

    it('a long run of entity-like text', () => {
      const text = '&aaaaaaaaaaaaaaaaaaaa'.repeat(200_000)
      expect(decodeHtmlEntities(text)).toBe(text)
    })
  })
})
