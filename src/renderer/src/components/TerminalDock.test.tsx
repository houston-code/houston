import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// xterm.js needs a real canvas/layout; stub the view so the dock's own logic
// (auto-open, last-close-hides, close-active, focus reporting) can be tested.
vi.mock('./TerminalView', () => ({
  TerminalView: ({ id }: { id: string }): JSX.Element => <div data-testid={`view-${id}`} />
}))

import { TerminalDock } from './TerminalDock'
import { useTerminals } from '../hooks/useTerminals'

let closeActiveCb: (() => void) | null = null
let counter = 0
const api = {
  createTerminal: vi.fn(() => Promise.resolve(`t${++counter}`)),
  killTerminal: vi.fn(() => Promise.resolve(true)),
  onTerminalExit: vi.fn(() => () => {}),
  onTerminalCloseActive: vi.fn((cb: () => void) => {
    closeActiveCb = cb
    return () => {}
  }),
  setTerminalFocused: vi.fn()
}

beforeEach(() => {
  counter = 0
  closeActiveCb = null
  vi.clearAllMocks()
  window.api = api as unknown as typeof window.api
})

const noop = (): void => {}

// The dock is now a pure view over a terminal controller (state lives in App), so
// the harness owns the real `useTerminals` controller and feeds it in — preserving
// the dock's own behaviour (auto-open, last-close-hides, ⌘W) under test.
function Harness({
  visible = true,
  onClose = vi.fn()
}: {
  visible?: boolean
  onClose?: () => void
}): JSX.Element {
  const controller = useTerminals('/repo')
  return (
    <TerminalDock
      controller={controller}
      visible={visible}
      onResizeMouseDown={noop}
      onClose={onClose}
    />
  )
}

function renderDock(props: { visible?: boolean; onClose?: () => void } = {}) {
  return render(<Harness {...props} />)
}

describe('TerminalDock', () => {
  it('auto-opens a terminal when shown with none', async () => {
    renderDock()
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalledWith({ cwd: '/repo' }))
    expect(await screen.findByTestId('view-t1')).toBeInTheDocument()
  })

  it('does not open a terminal while hidden', async () => {
    renderDock({ visible: false })
    await act(async () => {})
    expect(api.createTerminal).not.toHaveBeenCalled()
  })

  it('closing the last tab hides the panel', async () => {
    const onClose = vi.fn()
    renderDock({ onClose })
    await screen.findByTestId('view-t1')

    await act(async () => {
      screen.getByLabelText('Close Terminal 1').click()
    })
    expect(api.killTerminal).toHaveBeenCalledWith('t1')
    expect(onClose).toHaveBeenCalled()
  })

  it('close-active from main (⌘W) closes the active tab without hiding when others remain', async () => {
    const onClose = vi.fn()
    renderDock({ onClose })
    await screen.findByTestId('view-t1')

    await act(async () => {
      screen.getByLabelText('New terminal').click()
    })
    await screen.findByTestId('view-t2') // t2 is now active

    act(() => closeActiveCb?.())
    expect(api.killTerminal).toHaveBeenCalledWith('t2')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('reports not-focused to main while hidden (so ⌘W closes the window)', async () => {
    renderDock({ visible: false })
    await act(async () => {})
    expect(api.setTerminalFocused).toHaveBeenCalledWith(false)
    // Hidden panel must never auto-open / claim focus.
    expect(api.createTerminal).not.toHaveBeenCalled()
  })

  it('reports not-focused after the last tab is closed', async () => {
    renderDock({ onClose: vi.fn() })
    await screen.findByTestId('view-t1')
    api.setTerminalFocused.mockClear()

    await act(async () => {
      screen.getByLabelText('Close Terminal 1').click()
    })
    // tabs went to 0 → flag cleared so ⌘W now closes the window, not a dead tab.
    expect(api.setTerminalFocused).toHaveBeenCalledWith(false)
  })

  it('reports focus enter/leave to main for ⌘W routing', async () => {
    const { container } = renderDock()
    await screen.findByTestId('view-t1')
    const dock = container.querySelector('.terminal-dock') as HTMLElement

    fireEvent.focus(dock)
    expect(api.setTerminalFocused).toHaveBeenCalledWith(true)

    fireEvent.blur(dock, { relatedTarget: null })
    expect(api.setTerminalFocused).toHaveBeenCalledWith(false)
  })
})
