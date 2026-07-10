import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { FindBar } from './FindBar'

function transcript(html: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'transcript'
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('FindBar', () => {
  it('reports the match count as the query changes', () => {
    const root = transcript('<p>alpha beta alpha gamma alpha</p>')
    render(<FindBar getRoots={() => [root]} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Find in conversation'), { target: { value: 'alpha' } })
    expect(screen.getByText('1/3')).toBeInTheDocument()
  })

  it('searches across multiple roots (transcript + plan panel)', () => {
    const t = transcript('<p>alpha here</p>')
    const panel = document.createElement('aside')
    panel.className = 'plan-panel'
    panel.innerHTML = '<div>alpha in the plan</div><ol><li>and alpha again</li></ol>'
    document.body.appendChild(panel)
    render(<FindBar getRoots={() => [t, panel]} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Find in conversation'), { target: { value: 'alpha' } })
    // 1 in the transcript + 2 in the panel.
    expect(screen.getByText('1/3')).toBeInTheDocument()
  })

  it('shows "No results" when nothing matches', () => {
    const root = transcript('<p>nothing here</p>')
    render(<FindBar getRoots={() => [root]} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Find in conversation'), { target: { value: 'zzz' } })
    expect(screen.getByText('No results')).toBeInTheDocument()
  })

  it('cycles the active match with Enter (forward) and Shift+Enter (back), wrapping', () => {
    const root = transcript('<p>x x x</p>')
    render(<FindBar getRoots={() => [root]} onClose={() => {}} />)
    const input = screen.getByLabelText('Find in conversation')
    fireEvent.change(input, { target: { value: 'x' } })
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
    fireEvent.change(screen.getByLabelText('Find in conversation'), { target: { value: 'y' } })
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
