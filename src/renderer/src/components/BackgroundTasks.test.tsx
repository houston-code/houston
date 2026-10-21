import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BackgroundTasks, activeTaskCount } from './BackgroundTasks'
import type { BackgroundTask } from '../hooks/useBackgroundTasks'

const task = (over: Partial<BackgroundTask>): BackgroundTask => ({
  id: 'x',
  kind: 'shell',
  title: 'npm run dev',
  subtitle: '',
  status: 'running',
  ...over
})

describe('activeTaskCount', () => {
  it('counts running and leftover shells, never terminals or finished work', () => {
    const tasks = [
      task({ id: 'a' }),
      task({ id: 'b', status: 'leftover' }),
      task({ id: 'c', status: 'done' }),
      task({ id: 'd', status: 'error' }),
      task({ id: 't', kind: 'terminal' })
    ]
    expect(activeTaskCount(tasks)).toBe(2)
  })
})

describe('BackgroundTasks button', () => {
  it('shows the live count and toggles the Tasks tab instead of opening a menu', () => {
    const onToggle = vi.fn()
    render(<BackgroundTasks tasks={[task({ id: 'a' }), task({ id: 'b' })]} active={false} onToggle={onToggle} />)
    const btn = screen.getByRole('button', { name: 'Background tasks, 2 running' })
    expect(within(btn).getByText('2')).toBeInTheDocument()
    expect(btn).toHaveAttribute('aria-pressed', 'false')
    expect(btn).not.toHaveAttribute('aria-haspopup')
    fireEvent.click(btn)
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('shows no badge when nothing is running and reflects the open state', () => {
    render(<BackgroundTasks tasks={[task({ status: 'done' })]} active onToggle={vi.fn()} />)
    const btn = screen.getByRole('button', { name: 'Background tasks' })
    expect(btn.querySelector('.titlebar__badge')).toBeNull()
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    expect(btn.className).toContain('titlebar__action--active')
  })
})
