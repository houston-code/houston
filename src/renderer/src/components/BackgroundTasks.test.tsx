import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BackgroundTasks } from './BackgroundTasks'
import type { BackgroundTask } from '../hooks/useBackgroundTasks'

const chatRunning: BackgroundTask = {
  id: 'a',
  kind: 'chat',
  title: 'Refactor the parser',
  subtitle: 'houston',
  status: 'running'
}
const chatDone: BackgroundTask = {
  id: 'b',
  kind: 'chat',
  title: 'Add tests',
  subtitle: 'houston',
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
  it('counts every in-progress task (chats + terminals) and announces it', () => {
    setup([chatRunning, termRunning, chatDone])
    const btn = screen.getByRole('button', { name: /background tasks, 2 running/i })
    expect(within(btn).getByText('2')).toBeInTheDocument()
  })

  it('omits the count when nothing is running', () => {
    setup([chatDone])
    const btn = screen.getByRole('button', { name: /^background tasks$/i })
    expect(within(btn).queryByText(/^\d+$/)).not.toBeInTheDocument()
  })

  it('lists chats, terminals, and shells with their kind and status', () => {
    setup([chatRunning, termRunning, termFailed, shellRunning])
    fireEvent.click(screen.getByRole('button', { name: /background tasks/i }))
    const menu = screen.getByRole('menu', { name: /background tasks/i })
    expect(within(menu).getByText('Refactor the parser')).toBeInTheDocument()
    expect(within(menu).getByText('Terminal 1')).toBeInTheDocument()
    expect(within(menu).getByText('npm run dev')).toBeInTheDocument()
    // Meta lines carry the kind label and status.
    expect(within(menu).getByText(/Chat · houston · Running/)).toBeInTheDocument()
    expect(within(menu).getByText(/Terminal · Running/)).toBeInTheDocument()
    expect(within(menu).getByText(/Terminal · Failed/)).toBeInTheDocument()
    expect(within(menu).getByText(/Shell · Running/)).toBeInTheDocument()
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
    const { onClearFinished } = setup([chatRunning, chatDone])
    fireEvent.click(screen.getByRole('button', { name: /background tasks/i }))
    fireEvent.click(screen.getByRole('button', { name: /clear finished/i }))
    expect(onClearFinished).toHaveBeenCalledOnce()
  })

  it('offers no clear action when nothing has finished', () => {
    setup([chatRunning, termRunning])
    fireEvent.click(screen.getByRole('button', { name: /background tasks/i }))
    expect(screen.queryByRole('button', { name: /clear finished/i })).not.toBeInTheDocument()
  })
})
