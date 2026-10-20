import { describe, expect, it } from 'vitest'
import type { Conversation } from './agent'
import { conversationToHtml, escapeHtml, HTML_DATA_OPEN_TAG, type HtmlConversationData } from './html-export'
import { decodeHtmlEntities } from './html-import'

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    title: 'My chat',
    workspace: '/some/where',
    providerId: 'anthropic',
    model: 'claude-opus-4-8',
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
    messages: [
      { role: 'user', content: 'hello there' },
      {
        role: 'assistant',
        content: 'on it',
        toolCalls: [{ id: 'tc1', name: 'read_file', arguments: { path: 'a.txt' } }]
      },
      { role: 'tool', content: 'file contents', toolCallId: 'tc1', toolName: 'read_file' }
    ],
    ...overrides
  }
}

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x" foo='y'>&`)).toBe(
      '&lt;a href=&quot;x&quot; foo=&#39;y&#39;&gt;&amp;'
    )
  })

  it('escapes ampersands before other entities (no double-encoding glitch)', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })
})

describe('conversationToHtml receipts', () => {
  const receipt = {
    v: 1 as const,
    checks: [{ kind: 'test' as const, label: 'pytest <script>alert(1)</script>', ok: false, exitCode: 1, runs: 1 }],
    otherCommands: 0,
    filesChanged: ['app.py'],
    filesChangedCount: 1
  }

  it('shows what Houston recorded under the turn, escaped', () => {
    const html = conversationToHtml(
      makeConversation({ messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'All tests pass.', receipt }] })
    )
    expect(html).toContain('<pre class="turn__receipt">Recorded by Houston: Test command failed · 1 file changed')
    expect(html).toContain('pytest &lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)')
  })

  it('keeps the receipt out of the embedded data an import reads', () => {
    const html = conversationToHtml(
      makeConversation({ messages: [{ role: 'assistant', content: 'done', receipt }] })
    )
    const data = html.slice(html.indexOf(HTML_DATA_OPEN_TAG), html.indexOf('</template>'))
    expect(data).not.toContain('receipt')
  })
})

describe('conversationToHtml', () => {
  it('includes the title and message content', () => {
    const html = conversationToHtml(makeConversation())
    expect(html).toContain('<title>My chat</title>')
    expect(html).toContain('<h1>My chat</h1>')
    expect(html).toContain('hello there')
    expect(html).toContain('on it')
    expect(html).toContain('file contents')
  })

  it('renders tool calls readably (name + arguments)', () => {
    const html = conversationToHtml(makeConversation())
    expect(html).toContain('read_file')
    expect(html).toContain('a.txt')
  })

  it('produces a complete, well-formed document', () => {
    const html = conversationToHtml(makeConversation())
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('</html>')
    expect(html).toContain('<style>')
  })

  it('declares a restrictive Content-Security-Policy', () => {
    const html = conversationToHtml(makeConversation())
    expect(html).toContain('http-equiv="Content-Security-Policy"')
    expect(html).toContain("default-src 'none'")
    // The inline stylesheet is the only thing the policy permits.
    expect(html).toContain("style-src 'unsafe-inline'")
  })

  it('escapes content so it cannot inject markup or scripts', () => {
    const html = conversationToHtml(
      makeConversation({
        title: '<script>alert(1)</script>',
        messages: [{ role: 'user', content: '<img src=x onerror=alert(2)>' }]
      })
    )
    // The injected tags must appear only in escaped form, never as live markup.
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<img src=x onerror=alert(2)>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;')
  })

  it('escapes malicious tool-call arguments', () => {
    const html = conversationToHtml(
      makeConversation({
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 't', name: '<b>evil</b>', arguments: { x: '</pre><script>1</script>' } }
            ]
          }
        ]
      })
    )
    expect(html).not.toContain('<script>1</script>')
    expect(html).not.toContain('<b>evil</b>')
    expect(html).toContain('&lt;b&gt;evil&lt;/b&gt;')
  })

  it('is self-contained: no external resource references or scripts', () => {
    const html = conversationToHtml(
      makeConversation({
        messages: [{ role: 'user', content: 'see http://example.com/page for details' }]
      })
    )
    // The conversation may mention URLs as escaped text, but the document itself
    // must declare no loadable external resources and no executable scripts.
    expect(html).not.toMatch(/<script\b/i)
    expect(html).not.toMatch(/\ssrc\s*=/i)
    expect(html).not.toMatch(/\shref\s*=/i)
    expect(html).not.toMatch(/<link\b/i)
    expect(html).not.toMatch(/@import/i)
    expect(html).not.toMatch(/url\(/i)
    // A plain http(s) URL only survives inside escaped body text, not as an attribute.
    expect(html).toContain('http://example.com/page')
  })
})

describe('conversationToHtml data block', () => {
  /** The JSON payload inside the export's data block. */
  function dataBlock(html: string): HtmlConversationData {
    const start = html.indexOf(HTML_DATA_OPEN_TAG) + HTML_DATA_OPEN_TAG.length
    return JSON.parse(decodeHtmlEntities(html.slice(start, html.indexOf('</template>', start))))
  }

  it('embeds exactly one inert data block, in the head', () => {
    const html = conversationToHtml(makeConversation())
    expect(html.split(HTML_DATA_OPEN_TAG)).toHaveLength(2)
    expect(html.indexOf(HTML_DATA_OPEN_TAG)).toBeLessThan(html.indexOf('</head>'))
  })

  it('stores the importable fields, tool-call ids included', () => {
    const conv = makeConversation()
    const data = dataBlock(conversationToHtml(conv))
    expect(data).toEqual({
      format: 'houston-conversation',
      version: 1,
      title: 'My chat',
      providerId: 'anthropic',
      model: 'claude-opus-4-8',
      messages: conv.messages
    })
  })

  it('leaves out what the page does not show: workspace, attachments, reasoning, invocation chips', () => {
    const conv = makeConversation({
      promptSnapshot: { date: '2026-10-18', gitStatus: 'branch secret-branch' },
      messages: [
        {
          role: 'user',
          content: 'look at this',
          images: [{ mediaType: 'image/png', data: 'SECRETPIXELS' }],
          invokedAs: { kind: 'command', label: '/review' }
        },
        {
          role: 'assistant',
          content: 'done',
          reasoning: [{ text: 'private chain of thought', signature: 'sig' }]
        },
        {
          role: 'tool',
          content: 'pdf text',
          toolCallId: 't',
          toolName: 'read_file',
          documents: [{ mediaType: 'application/pdf', data: 'SECRETPDF' }]
        }
      ]
    })
    const html = conversationToHtml(conv)
    for (const hidden of [
      '/some/where',
      'SECRETPIXELS',
      'SECRETPDF',
      'private chain of thought',
      'secret-branch',
      '/review'
    ]) {
      expect(html).not.toContain(hidden)
    }
    expect(dataBlock(html).messages).toEqual([
      { role: 'user', content: 'look at this' },
      { role: 'assistant', content: 'done' },
      { role: 'tool', content: 'pdf text', toolCallId: 't', toolName: 'read_file' }
    ])
  })

  it('omits an empty provider or model rather than storing blanks', () => {
    const data = dataBlock(conversationToHtml(makeConversation({ providerId: '', model: '' })))
    expect(data).not.toHaveProperty('providerId')
    expect(data).not.toHaveProperty('model')
  })

  it('keeps the block escaped so its JSON cannot close the template or add markup', () => {
    const html = conversationToHtml(
      makeConversation({ messages: [{ role: 'user', content: '</template><img src=x onerror=alert(1)>' }] })
    )
    expect(html).not.toContain('</template><img')
    expect(html).not.toContain('<img src=x')
    expect(dataBlock(html).messages[0].content).toBe('</template><img src=x onerror=alert(1)>')
  })
})
