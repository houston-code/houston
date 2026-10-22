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

describe('Markdown task lists', () => {
  it('draws a read-only box per task item, in place of the brackets', () => {
    const { container } = render(<Markdown text={'- [ ] write it\n- [x] test it\n- plain'} />)
    const boxes = container.querySelectorAll<HTMLElement>('.md-task__box')
    expect(boxes).toHaveLength(2)
    expect(boxes[0]).toHaveAccessibleName('Not done')
    expect(boxes[0]).not.toHaveClass('is-checked')
    expect(boxes[1]).toHaveAccessibleName('Done')
    expect(boxes[1]).toHaveClass('is-checked')
    expect(boxes[1].querySelector('svg[data-icon="check"]')).toBeInTheDocument()
    // Nothing to toggle: the boxes report state, they aren't controls.
    expect(container.querySelector('input')).toBeNull()
    expect(container.textContent).not.toContain('[ ]')
    expect(container.textContent).not.toContain('[x]')
    // An ordinary item in the same list keeps its bullet.
    expect(container.querySelectorAll('li.md-task')).toHaveLength(2)
  })
})

