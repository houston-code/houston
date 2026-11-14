import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toast, ToastStack } from './Toasts'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('Toast', () => {
  it('leaves after its time', () => {
    const onDone = vi.fn()
    render(
      <ToastStack>
        <Toast ms={1000} onDone={onDone}>
          Saved
        </Toast>
      </ToastStack>
    )
    act(() => void vi.advanceTimersByTime(999))
    expect(onDone).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(1))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('waits while hovered or focused, then finishes the time it had left', () => {
    const onDone = vi.fn()
    render(
      <ToastStack>
        <Toast ms={1000} onDone={onDone}>
          <span>Marked unread.</span>
          <button type="button">Undo</button>
        </Toast>
      </ToastStack>
    )
    const toast = screen.getByText('Marked unread.').parentElement as HTMLElement
    act(() => void vi.advanceTimersByTime(600))
    fireEvent.mouseEnter(toast)
    act(() => void vi.advanceTimersByTime(5000))
    expect(onDone).not.toHaveBeenCalled()
    fireEvent.mouseLeave(toast)
    // Keyboard focus on Undo holds it too.
    act(() => screen.getByRole('button', { name: 'Undo' }).focus())
    act(() => void vi.advanceTimersByTime(5000))
    expect(onDone).not.toHaveBeenCalled()
    act(() => screen.getByRole('button', { name: 'Undo' }).blur())
    act(() => void vi.advanceTimersByTime(399))
    expect(onDone).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(1))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('starts over for a new note in the same place', () => {
    const onDone = vi.fn()
    const { rerender } = render(
      <Toast ms={1000} resetKey="a" onDone={onDone}>
        One
      </Toast>
    )
    act(() => void vi.advanceTimersByTime(800))
    rerender(
      <Toast ms={1000} resetKey="b" onDone={onDone}>
        Two
      </Toast>
    )
    act(() => void vi.advanceTimersByTime(800))
    expect(onDone).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(200))
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})

describe('ToastStack', () => {
  it('is one live region that stays in the page, with the toasts inside it rather than regions of their own', () => {
    const { rerender } = render(<ToastStack>{null}</ToastStack>)
    const region = screen.getByRole('status')
    rerender(
      <ToastStack>
        <Toast ms={1000} onDone={vi.fn()}>
          That folder no longer exists.
        </Toast>
        <Toast ms={1000} onDone={vi.fn()}>
          Marked unread.
        </Toast>
      </ToastStack>
    )
    expect(screen.getByRole('status')).toBe(region)
    expect(region).toHaveTextContent('That folder no longer exists.')
    expect(region).toHaveTextContent('Marked unread.')
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })
})
