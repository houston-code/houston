import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatStatusMap } from '@shared/chatStatus'
import { WAITING_TOAST_MS, WaitingChatToast } from './WaitingChatToast'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const EMPTY: ChatStatusMap = {}
const idle: ChatStatusMap = { a: { running: true, pending: [] } }
const asking: ChatStatusMap = { a: { running: true, pending: [{ kind: 'approval', label: 'Run npm test' }] } }
const TEXT = 'Fix login needs your approval: Run npm test'

/** Mount with the window's starting status, then the seeded status it opened into. */
function mount(seed: ChatStatusMap, currentId: string | null = 'b', onOpen = vi.fn()) {
  const props = { currentId, titleOf: () => 'Fix login', onOpen }
  const view = render(<WaitingChatToast chatStatus={EMPTY} {...props} />)
  view.rerender(<WaitingChatToast chatStatus={seed} {...props} />)
  const update = (chatStatus: ChatStatusMap, id: string | null = currentId) =>
    view.rerender(<WaitingChatToast chatStatus={chatStatus} {...props} currentId={id} />)
  return { update, onOpen }
}

describe('WaitingChatToast', () => {
  it('shows a note when another chat starts waiting, and opens it', () => {
    const { update, onOpen } = mount(idle)
    update(asking)
    expect(screen.getByText(TEXT)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpen).toHaveBeenCalledWith('a')
    expect(screen.queryByText(TEXT)).toBeNull()
  })

  it('does not announce what was already waiting when the window opened', () => {
    const { update } = mount(asking)
    update({ ...asking })
    expect(screen.queryByText(TEXT)).toBeNull()
  })

  it('says nothing about the open chat', () => {
    const { update } = mount(idle, 'a')
    update(asking)
    expect(screen.queryByText(TEXT)).toBeNull()
  })

  it('goes away once the chat is answered elsewhere', () => {
    const { update } = mount(idle)
    update(asking)
    update(idle)
    expect(screen.queryByText(TEXT)).toBeNull()
  })

  it('goes away when the user opens that chat another way', () => {
    const { update } = mount(idle)
    update(asking)
    update(asking, 'a')
    expect(screen.queryByText(TEXT)).toBeNull()
  })

  it('leaves on its own after a while', () => {
    vi.useFakeTimers()
    const { update } = mount(idle)
    update(asking)
    expect(screen.getByText(TEXT)).toBeTruthy()
    act(() => vi.advanceTimersByTime(WAITING_TOAST_MS + 10))
    expect(screen.queryByText(TEXT)).toBeNull()
  })
})
