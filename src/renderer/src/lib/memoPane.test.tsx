import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { memoPane } from './memoPane'

describe('memoPane', () => {
  function setup() {
    let renders = 0
    const Pane = memoPane(function Pane({
      label,
      onPick,
      renderNote
    }: {
      label: string
      onPick?: (n: number) => void
      renderNote?: () => string
    }) {
      renders++
      return (
        <div>
          <button onClick={() => onPick?.(renders)}>{label}</button>
          <span>{renderNote?.()}</span>
        </div>
      )
    })
    return { Pane, renders: () => renders }
  }

  it('skips a render when only the handlers are new, and calls the newest one', () => {
    const { Pane, renders } = setup()
    const picked: string[] = []
    const { rerender } = render(<Pane label="Go" onPick={() => picked.push('first')} />)
    expect(renders()).toBe(1)
    rerender(<Pane label="Go" onPick={() => picked.push('second')} />)
    rerender(<Pane label="Go" onPick={() => picked.push('third')} />)
    expect(renders()).toBe(1)
    fireEvent.click(screen.getByText('Go'))
    expect(picked).toEqual(['third'])
  })

  it('renders when a value changes, or a handler appears or goes away', () => {
    const { Pane, renders } = setup()
    const { rerender } = render(<Pane label="Go" />)
    rerender(<Pane label="Stop" />)
    expect(renders()).toBe(2)
    expect(screen.getByText('Stop')).toBeInTheDocument()
    rerender(<Pane label="Stop" onPick={() => {}} />)
    expect(renders()).toBe(3)
    rerender(<Pane label="Stop" />)
    expect(renders()).toBe(4)
  })

  it('passes the newest function to one the pane calls while it renders', () => {
    const { Pane } = setup()
    const { rerender } = render(<Pane label="Go" renderNote={() => 'old note'} />)
    expect(screen.getByText('old note')).toBeInTheDocument()
    rerender(<Pane label="Again" renderNote={() => 'new note'} />)
    expect(screen.getByText('new note')).toBeInTheDocument()
  })
})
