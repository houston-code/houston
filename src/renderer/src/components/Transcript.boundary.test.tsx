import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DisplayItem } from '../lib/items'

// Stand in for the markdown renderer with one that throws on a marker text, so a
// single reply row fails to render the way a renderer bug on odd model output would.
vi.mock('./Markdown', () => ({
  Markdown: ({ text }: { text: string }) => {
    if (text === 'boom') throw new Error('render failed')
    return <p>{text}</p>
  }
}))

import { Transcript } from './Transcript'

afterEach(() => vi.restoreAllMocks())

describe('Transcript row error boundary', () => {
  it('shows a notice for the one row that throws and keeps the rest of the chat', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const items: DisplayItem[] = [
      { kind: 'user', id: 'u1', text: 'question' },
      { kind: 'assistant', id: 'a1', text: 'first reply', streaming: false },
      { kind: 'assistant', id: 'a2', text: 'boom', streaming: false },
      { kind: 'notice', id: 'n1', text: 'a later notice', tone: 'info' },
      { kind: 'assistant', id: 'a3', text: 'last reply', streaming: false }
    ]
    render(<Transcript items={items} onApprove={vi.fn()} onAnswer={vi.fn()} onElicit={vi.fn()} />)
    expect(screen.getByText("This item couldn't be shown.")).toBeInTheDocument()
    expect(screen.getByText('question')).toBeInTheDocument()
    expect(screen.getByText('first reply')).toBeInTheDocument()
    expect(screen.getByText('a later notice')).toBeInTheDocument()
    expect(screen.getByText('last reply')).toBeInTheDocument()
  })

  it('renders the row again once its content changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = (text: string): JSX.Element => (
      <Transcript
        items={[{ kind: 'assistant', id: 'a1', text, streaming: true }]}
        onApprove={vi.fn()}
        onAnswer={vi.fn()}
        onElicit={vi.fn()}
      />
    )
    const { rerender } = render(view('boom'))
    expect(screen.getByText("This item couldn't be shown.")).toBeInTheDocument()
    rerender(view('boom, then more'))
    expect(screen.queryByText("This item couldn't be shown.")).toBeNull()
    expect(screen.getByText('boom, then more')).toBeInTheDocument()
  })
})
