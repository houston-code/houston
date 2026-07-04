import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Markdown } from './Markdown'

describe('Markdown code blocks', () => {
  it('syntax-highlights a fenced block with a known language', () => {
    const { container } = render(<Markdown text={'```ts\nconst x = 1\n```'} />)
    const code = container.querySelector('.md-codeblock__pre code')
    expect(code).not.toBeNull()
    // hljs wraps tokens in .hljs-* spans (e.g. `const` as a keyword).
    expect(code!.querySelector('.hljs-keyword')).not.toBeNull()
  })

  it('renders an unknown language as plain (escaped) text, no token spans', () => {
    const { container } = render(<Markdown text={'```\n<b>not html</b>\n```'} />)
    const code = container.querySelector('.md-codeblock__pre code') as HTMLElement
    expect(code.querySelector('.hljs-keyword')).toBeNull()
    // The raw text is shown verbatim (React escapes it — no injected <b> element).
    expect(code.textContent).toContain('<b>not html</b>')
    expect(code.querySelector('b')).toBeNull()
  })
})
