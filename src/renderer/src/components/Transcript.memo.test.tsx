import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DisplayItem } from '../lib/items'

const h = vi.hoisted(() => ({ describeTool: vi.fn() }))
vi.mock('../lib/toolDisplay', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/toolDisplay')>()
  h.describeTool.mockImplementation(real.describeTool)
  return { ...real, describeTool: h.describeTool }
})

import { Transcript } from './Transcript'

const user: DisplayItem = { kind: 'user', id: 'u1', text: 'Fix the bug' }
const tool: DisplayItem = {
  kind: 'tool',
  id: 't1',
  name: 'run_shell',
  status: 'done',
  args: { command: 'npm test' },
  output: 'ok'
}
const reply = (text: string): DisplayItem => ({ kind: 'assistant', id: 'a1', text, streaming: true })

/** Render the way App does: fresh handler closures on every render. */
function view(items: DisplayItem[], onApprove = vi.fn()): JSX.Element {
  return (
    <Transcript
      items={items}
      onApprove={(callId, decision) => onApprove(callId, decision)}
      onAnswer={() => {}}
      onElicit={() => {}}
      onMarkUnreadFrom={() => {}}
      rewind={{ disabled: false, onRewind: () => {}, onEdit: () => {} }}
    />
  )
}

describe('Transcript row memoization', () => {
  it('does not re-render a finished tool row while the reply streams', () => {
    const { rerender } = render(view([user, tool, reply('Wor')]))
    const first = h.describeTool.mock.calls.length
    expect(first).toBeGreaterThan(0)
    // Each streamed update replaces the reply item and the items array; the user and
    // tool items keep their identity, as the reducer leaves them.
    for (const text of ['Work', 'Worki', 'Working', 'Working on it']) rerender(view([user, tool, reply(text)]))
    expect(h.describeTool.mock.calls.length).toBe(first)
    expect(screen.getByText('Working on it')).toBeTruthy()
  })

  it('re-renders a tool row when its own item changes', () => {
    const running: DisplayItem = { ...tool, status: 'running', output: undefined } as DisplayItem
    const { rerender, container } = render(view([user, running]))
    const first = h.describeTool.mock.calls.length
    rerender(view([user, tool]))
    expect(h.describeTool.mock.calls.length).toBeGreaterThan(first)
    expect(container.querySelector('.tool-row--done')).toBeTruthy()
  })

  it('still calls the latest handler from a row that did not re-render', () => {
    const a = vi.fn()
    const b = vi.fn()
    const pending: DisplayItem = { ...tool, status: 'awaiting-approval', output: undefined } as DisplayItem
    const { rerender } = render(view([user, pending], a))
    rerender(view([user, pending], b))
    screen.getByRole('button', { name: /^Allow$/ }).click()
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
  })
})
