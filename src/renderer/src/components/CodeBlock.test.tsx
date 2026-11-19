import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearHighlightCache, highlightCacheStats } from '../lib/highlight'
import type { DisplayItem } from '../lib/items'
import { StreamingTextContext } from './CodeBlock'
import { Markdown } from './Markdown'
import { Transcript } from './Transcript'

/** A reply as the transcript shows it: `streaming` while it is still arriving. */
function Reply({ text, streaming }: { text: string; streaming: boolean }): JSX.Element {
  return (
    <StreamingTextContext.Provider value={streaming}>
      <Markdown text={text} visuals />
    </StreamingTextContext.Provider>
  )
}

const code = (lines: number): string =>
  Array.from({ length: lines }, (_, i) => `const item${i} = load(${i}) // step ${i}`).join('\n')

const highlighted = (container: HTMLElement): number => container.querySelectorAll('.md-codeblock .hljs-keyword').length

beforeEach(() => clearHighlightCache())

describe('a fenced block in a streaming reply', () => {
  it('stays plain and out of the cache while its fence is open, and is highlighted once it closes', () => {
    const intro = 'Here it is:\n\n```ts\n'
    const body = code(40)
    const { container, rerender } = render(<Reply text={intro} streaming />)
    // Delta by delta, as the block is written.
    for (let at = 20; at < body.length; at += 20) {
      rerender(<Reply text={intro + body.slice(0, at)} streaming />)
      expect(highlighted(container)).toBe(0)
    }
    rerender(<Reply text={intro + body} streaming />)
    expect(container.querySelector('.md-codeblock code')?.textContent).toBe(body)
    expect(highlightCacheStats()).toEqual({ entries: 0, chars: 0 })

    // The closing fence arrives while the reply is still going.
    rerender(<Reply text={`${intro + body}\n\`\`\`\n\nNow the tests`} streaming />)
    expect(highlighted(container)).toBe(40)
    expect(container.querySelector('.md-codeblock code')?.textContent).toBe(body)
    expect(highlightCacheStats()).toEqual({ entries: 1, chars: body.length })
  })

  it('is highlighted, but not cached, when the reply ends with its fence still open', () => {
    const text = '```ts\n' + code(5)
    const { container, rerender } = render(<Reply text={text} streaming />)
    expect(highlighted(container)).toBe(0)
    rerender(<Reply text={text} streaming={false} />)
    expect(highlighted(container)).toBe(5)
    expect(highlightCacheStats().entries).toBe(0)
  })

  it('is highlighted as before outside a streaming reply', () => {
    const { container } = render(<Markdown text={'```ts\n' + code(3) + '\n```'} />)
    expect(highlighted(container)).toBe(3)
    expect(highlightCacheStats().entries).toBe(1)
  })
})

describe('the transcript', () => {
  it("highlights a reply's open block once the reply stops streaming", () => {
    const reply = (streaming: boolean): DisplayItem[] => [
      { kind: 'user', id: 'u1', text: 'show me' },
      { kind: 'assistant', id: 'a1', text: '```ts\n' + code(4), streaming }
    ]
    const props = { onApprove: vi.fn(), onAnswer: vi.fn(), onElicit: vi.fn() }
    const { container, rerender } = render(<Transcript items={reply(true)} {...props} />)
    expect(container.querySelector('.md-codeblock code')?.textContent).toBe(code(4))
    expect(highlighted(container)).toBe(0)
    rerender(<Transcript items={reply(false)} {...props} />)
    expect(highlighted(container)).toBe(4)
  })
})
