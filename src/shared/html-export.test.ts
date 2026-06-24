import { describe, expect, it } from 'vitest'
import type { Conversation } from './agent'
import { conversationToHtml, escapeHtml } from './html-export'

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
