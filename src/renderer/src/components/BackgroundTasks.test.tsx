import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BackgroundTasks } from './BackgroundTasks'
import type { BackgroundTask } from '../hooks/useBackgroundTasks'

const shellBuilding: BackgroundTask = {
  id: 's0',
  kind: 'shell',
  title: 'npm run build',
  subtitle: '',
  status: 'running',
  conversationId: 'conv-2'
}
const shellDone: BackgroundTask = {
  id: 's3',
  kind: 'shell',
  title: 'vite build',
  subtitle: '',
  status: 'done',
  finishedAt: Date.now() - 120_000
}
const termRunning: BackgroundTask = {
  id: 't1',
  kind: 'terminal',
  title: 'Terminal 1',
  subtitle: '',
  status: 'running'
}
const termFailed: BackgroundTask = {
  id: 't2',
  kind: 'terminal',
  title: 'Terminal 2',
  subtitle: '',
  status: 'error',
  finishedAt: Date.now() - 30_000
}
const shellRunning: BackgroundTask = {
  id: 's1',
  kind: 'shell',
  title: 'npm run dev',
  subtitle: '',
  status: 'running',
  conversationId: 'conv-1'
}

function setup(tasks: BackgroundTask[], onSelect = vi.fn(), onClearFinished = vi.fn()) {
  render(
    <BackgroundTasks tasks={tasks} onSelect={onSelect} onClearFinished={onClearFinished} />
  )
  return { onSelect, onClearFinished }
}

describe('BackgroundTasks', () => {
  it('counts running background shells but not idle terminals', () => {
    // Two running shells count; the running terminal does not inflate the badge.
    setup([shellBuilding, termRunning, shellRunning, shellDone])
    const btn = screen.getByRole('button', { name: /background tasks, 2 running/i })
    expect(within(btn).getByText('2')).toBeInTheDocument()
    // Running work shows only the badge, not an accent outline.
    expect(btn.className).toBe('titlebar__action bgtasks__btn')
  })

  it('does not light the badge for a terminal alone', () => {
    setup([termRunning])
    const btn = screen.getByRole('button', { name: /^background tasks$/i })
    expect(within(btn).queryByText(/^\d+$/)).not.toBeInTheDocument()
  })

  it('omits the count when nothing is running', () => {
    setup([shellDone])
    const btn = screen.getByRole('button', { name: /^background tasks$/i })
    expect(within(btn).queryByText(/^\d+$/)).not.toBeInTheDocument()
  })

  it('lists terminals and shells with their kind and status', () => {
    setup([shellBuilding, termRunning, termFailed, shellRunning])
    fireEvent.click(screen.getByRole('button', { name: /background tasks/i }))
    const menu = screen.getByRole('menu', { name: /background tasks/i })
    expect(within(menu).getByText('npm run build')).toBeInTheDocument()
    expect(within(menu).getByText('Terminal 1')).toBeInTheDocument()
    expect(within(menu).getByText('npm run dev')).toBeInTheDocument()
    // Meta lines carry the kind label and status.
    expect(within(menu).getAllByText(/Shell · Running/)).toHaveLength(2)
    expect(within(menu).getByText(/Terminal · Running/)).toBeInTheDocument()
    expect(within(menu).getByText(/Terminal · Failed/)).toBeInTheDocument()
  })

  it('passes the whole task to onSelect and closes when clicked', () => {
    const { onSelect } = setup([termRunning])
    fireEvent.click(screen.getByRole('button', { name: /background tasks/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Terminal 1/i }))
    expect(onSelect).toHaveBeenCalledWith(termRunning)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('shows an empty state when there are no tasks', () => {
    setup([])
    fireEvent.click(screen.getByRole('button', { name: /background tasks/i }))
    expect(screen.getByText(/no background tasks/i)).toBeInTheDocument()
  })

  it('clears finished tasks via the footer action', () => {
    const { onClearFinished } = setup([shellRunning, shellDone])
    fireEvent.click(screen.getByRole('button', { name: /background tasks/i }))
    fireEvent.click(screen.getByRole('button', { name: /clear finished/i }))
    expect(onClearFinished).toHaveBeenCalledOnce()
  })

  it('offers no clear action when nothing has finished', () => {
    setup([shellRunning, termRunning])
    fireEvent.click(screen.getByRole('button', { name: /background tasks/i }))
    expect(screen.queryByRole('button', { name: /clear finished/i })).not.toBeInTheDocument()
  })
})
