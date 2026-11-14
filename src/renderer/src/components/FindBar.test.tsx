import { act, render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { FIND_DEBOUNCE_MS, FindBar } from './FindBar'
import { MAX_FIND_MATCHES } from '../lib/transcriptFind'

function transcript(html: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'transcript'
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

/** Type a query and let the pause before the search pass. */
function typeQuery(input: HTMLElement, value: string): void {
  fireEvent.change(input, { target: { value } })
  act(() => {
    vi.advanceTimersByTime(FIND_DEBOUNCE_MS)
  })
}

describe('FindBar', () => {
  it('reports the match count as the query changes', () => {
    const root = transcript('<p>alpha beta alpha gamma alpha</p>')
    render(<FindBar getRoots={() => [root]} onClose={() => {}} />)
    typeQuery(screen.getByLabelText('Find in conversation'), 'alpha')
    expect(screen.getByText('1/3')).toBeInTheDocument()
  })

  it('searches across multiple roots (transcript + plan panel)', () => {
    const t = transcript('<p>alpha here</p>')
    const panel = document.createElement('aside')
    panel.className = 'plan-panel'
    panel.innerHTML = '<div>alpha in the plan</div><ol><li>and alpha again</li></ol>'
    document.body.appendChild(panel)
    render(<FindBar getRoots={() => [t, panel]} onClose={() => {}} />)
    typeQuery(screen.getByLabelText('Find in conversation'), 'alpha')
    // 1 in the transcript + 2 in the panel.
    expect(screen.getByText('1/3')).toBeInTheDocument()
  })

  it('shows "No results" when nothing matches', () => {
    const root = transcript('<p>nothing here</p>')
    render(<FindBar getRoots={() => [root]} onClose={() => {}} />)
    typeQuery(screen.getByLabelText('Find in conversation'), 'zzz')
    expect(screen.getByText('No results')).toBeInTheDocument()
  })

  it('cycles the active match with Enter (forward) and Shift+Enter (back), wrapping', () => {
    const root = transcript('<p>x x x</p>')
    render(<FindBar getRoots={() => [root]} onClose={() => {}} />)
    const input = screen.getByLabelText('Find in conversation')
    typeQuery(input, 'x')
    expect(screen.getByText('1/3')).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText('2/3')).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(screen.getByText('1/3')).toBeInTheDocument()
    // Back once more wraps to the last match.
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(screen.getByText('3/3')).toBeInTheDocument()
  })

  it('navigates with the next/previous buttons', () => {
    const root = transcript('<p>y y</p>')
    render(<FindBar getRoots={() => [root]} onClose={() => {}} />)
    typeQuery(screen.getByLabelText('Find in conversation'), 'y')
    fireEvent.click(screen.getByLabelText('Next match'))
    expect(screen.getByText('2/2')).toBeInTheDocument()
  })

  it('disables navigation when there are no matches', () => {
    const root = transcript('<p>abc</p>')
    render(<FindBar getRoots={() => [root]} onClose={() => {}} />)
    expect(screen.getByLabelText('Next match')).toBeDisabled()
    expect(screen.getByLabelText('Previous match')).toBeDisabled()
  })

  it('closes via Esc and the close button', () => {
    const root = transcript('<p>abc</p>')
    const onClose = vi.fn()
    render(<FindBar getRoots={() => [root]} onClose={onClose} />)
    fireEvent.keyDown(screen.getByLabelText('Find in conversation'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByLabelText('Close find'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('FindBar focus', () => {
  it('re-focuses and selects its query when find is asked for again', () => {
    const root = transcript('<p>alpha</p>')
    const { rerender } = render(<FindBar getRoots={() => [root]} onClose={() => {}} focusRequest={1} />)
    const input = screen.getByLabelText('Find in conversation') as HTMLInputElement
    typeQuery(input, 'alpha')
    // The user clicked back into the transcript, then pressed ⌘F again.
    input.blur()
    expect(document.activeElement).not.toBe(input)
    rerender(<FindBar getRoots={() => [root]} onClose={() => {}} focusRequest={2} />)
    expect(document.activeElement).toBe(input)
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'alpha'.length])
  })

  it('hands focus back to where it was when it closes', () => {
    const root = transcript('<p>alpha</p>')
    const composer = document.createElement('textarea')
    document.body.appendChild(composer)
    composer.focus()
    const { unmount } = render(<FindBar getRoots={() => [root]} onClose={() => {}} />)
    expect(document.activeElement).toBe(screen.getByLabelText('Find in conversation'))
    unmount()
    expect(document.activeElement).toBe(composer)
  })

  it('searches the query again in the chat switched to, instead of keeping stale results', () => {
    let root = transcript('<p>alpha alpha alpha</p>')
    const { rerender } = render(<FindBar getRoots={() => [root]} onClose={() => {}} searchKey="a" />)
    const input = screen.getByLabelText('Find in conversation')
    typeQuery(input, 'alpha')
    expect(screen.getByText('1/3')).toBeInTheDocument()
    // The other chat's transcript replaces this one.
    root.remove()
    root = transcript('<p>alpha once</p>')
    rerender(<FindBar getRoots={() => [root]} onClose={() => {}} searchKey="b" />)
    act(() => {
      vi.advanceTimersByTime(FIND_DEBOUNCE_MS)
    })
    expect(screen.getByText('1/1')).toBeInTheDocument()
  })

  it('re-searches on Enter right after a chat switch, before the pause has passed', () => {
    let root = transcript('<p>x x x</p>')
    const { rerender } = render(<FindBar getRoots={() => [root]} onClose={() => {}} searchKey="a" />)
    const input = screen.getByLabelText('Find in conversation')
    typeQuery(input, 'x')
    root.remove()
    root = transcript('<p>x x</p>')
    rerender(<FindBar getRoots={() => [root]} onClose={() => {}} searchKey="b" />)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText('2/2')).toBeInTheDocument()
  })

  it('searches once typing pauses, not on every keystroke', () => {
    const root = transcript('<p>alpha beta</p>')
    render(<FindBar getRoots={() => [root]} onClose={() => {}} />)
    const input = screen.getByLabelText('Find in conversation')
    for (const q of ['a', 'al', 'alp']) fireEvent.change(input, { target: { value: q } })
    // Nothing searched yet: no stale "No results" for a query still being typed.
    expect(screen.queryByText('No results')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(FIND_DEBOUNCE_MS)
    })
    expect(screen.getByText('1/1')).toBeInTheDocument()
  })

  it('runs a waiting search at once on Enter, then steps from its first match', () => {
    const root = transcript('<p>x x x</p>')
    render(<FindBar getRoots={() => [root]} onClose={() => {}} />)
    const input = screen.getByLabelText('Find in conversation')
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText('2/3')).toBeInTheDocument()
  })

  it('counts at most the cap, and says there were more', () => {
    const root = transcript(`<p>${'x '.repeat(MAX_FIND_MATCHES + 5)}</p>`)
    render(<FindBar getRoots={() => [root]} onClose={() => {}} />)
    typeQuery(screen.getByLabelText('Find in conversation'), 'x')
    expect(screen.getByText(`1/${MAX_FIND_MATCHES}+`)).toBeInTheDocument()
  })
})
