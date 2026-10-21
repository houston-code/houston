import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TasksPanel } from './TasksPanel'
import type { BackgroundTask } from '../hooks/useBackgroundTasks'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

const server: BackgroundTask = {
  id: 'aaaa1111',
  kind: 'shell',
  title: 'python manage.py runserver 0.0.0.0:8000',
  subtitle: 'backend/',
  status: 'running',
  command: 'cd /w/backend && python manage.py runserver 0.0.0.0:8000 > /tmp/django.log 2>&1',
  startedAt: NOW - 4 * HOUR,
  ports: [':8000'],
  urls: ['http://0.0.0.0:8000/'],
  exposed: true,
  conversationId: 'conv-1'
}
const leftover: BackgroundTask = {
  id: 'bbbb2222',
  kind: 'shell',
  title: 'npm run dev',
  subtitle: 'frontend/',
  status: 'leftover',
  command: 'npm run dev &',
  ports: [':5173'],
  urls: ['http://localhost:5173/'],
  exitCode: 0,
  finishedAt: NOW - HOUR
}
const failed: BackgroundTask = {
  id: 'cccc3333',
  kind: 'shell',
  title: 'python manage.py runserver',
  subtitle: '',
  status: 'error',
  command: 'source venv/bin/activate && python manage.py runserver',
  exitCode: 1,
  finishedAt: NOW - 2 * HOUR
}
const terminal: BackgroundTask = { id: 't1', kind: 'terminal', title: 'Terminal 1', subtitle: '', status: 'running' }

const api = {
  getBackgroundShellTail: vi.fn(async (): Promise<string[] | null> => ['Watching for file changes', 'GET / 200'])
}

beforeEach(() => {
  window.api = api as unknown as typeof window.api
})
afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

function setup(tasks: BackgroundTask[]) {
  const props = {
    onStop: vi.fn(async () => 'killed' as const),
    onOpenPreview: vi.fn(),
    onGoToChat: vi.fn(),
    onOpenTerminal: vi.fn(),
    onClearFinished: vi.fn()
  }
  render(<TasksPanel tasks={tasks} now={() => NOW} {...props} />)
  return props
}

describe('TasksPanel', () => {
  it('shows an empty state with nothing to list', () => {
    setup([])
    expect(screen.getByText('No background tasks.')).toBeInTheDocument()
  })

  it('groups live work (including leftovers) above finished work', () => {
    setup([server, leftover, failed])
    const running = screen.getByRole('region', { name: 'Running' })
    expect(within(running).getByText('Running · 2')).toBeInTheDocument()
    expect(within(running).getByText('npm run dev')).toBeInTheDocument()
    const finished = screen.getByRole('region', { name: 'Finished' })
    expect(within(finished).getByText('python manage.py runserver')).toBeInTheDocument()
  })

  it('collapsed rows show the readable label, port chip and a state line; full command on hover', () => {
    setup([server, leftover, failed])
    const head = screen.getByRole('button', { name: /runserver 0\.0\.0\.0:8000/ })
    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(head).toHaveAttribute('title', server.command)
    expect(within(head).getByText(':8000')).toBeInTheDocument()
    expect(within(head).getByText('Shell · Running for 4h · backend/')).toBeInTheDocument()
    expect(screen.getByText('Shell · Exited, server still running · frontend/')).toBeInTheDocument()
    expect(screen.getByText('Shell · Failed (exit 1) 2h ago')).toBeInTheDocument()
  })

  it('shows port chips only on live rows', () => {
    setup([server, { ...leftover, id: 'dddd4444', title: 'npm run preview', status: 'done', ports: [':4173'] }])
    expect(screen.getByText(':8000')).toBeInTheDocument()
    expect(screen.queryByText(':4173')).toBeNull()
  })

  it('expands to the full command, facts, network exposure and recent output', async () => {
    setup([server])
    const head = screen.getByRole('button', { name: /runserver/ })
    fireEvent.click(head)
    expect(head).toHaveAttribute('aria-expanded', 'true')
    const body = document.getElementById(head.getAttribute('aria-controls')!)!
    expect(body).not.toHaveAttribute('hidden')
    expect(within(body).getByText(server.command!)).toBeInTheDocument()
    expect(within(body).getByText(/reachable from your network/)).toBeInTheDocument()
    expect(await within(body).findByText(/GET \/ 200/)).toBeInTheDocument()
    expect(api.getBackgroundShellTail).toHaveBeenCalledWith('aaaa1111')
    fireEvent.click(head)
    expect(body).toHaveAttribute('hidden')
  })

  it('refreshes a live row\'s output while it stays expanded, and stops when collapsed', async () => {
    vi.useFakeTimers()
    setup([server])
    const head = screen.getByRole('button', { name: /runserver/ })
    fireEvent.click(head)
    await act(async () => {})
    expect(api.getBackgroundShellTail).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(api.getBackgroundShellTail).toHaveBeenCalledTimes(2)
    fireEvent.click(head)
    await act(async () => {
      vi.advanceTimersByTime(6000)
    })
    expect(api.getBackgroundShellTail).toHaveBeenCalledTimes(2)
  })

  it('stops a running shell and reports the outcome', async () => {
    const p = setup([server])
    fireEvent.click(screen.getByRole('button', { name: /runserver/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(p.onStop).toHaveBeenCalledWith('aaaa1111')
    expect(await screen.findByText('Stopped.')).toBeInTheDocument()
  })

  it('offers to stop what an exited shell left running, with a warning', async () => {
    const p = setup([leftover])
    p.onStop.mockResolvedValueOnce('killed-leftovers' as never)
    fireEvent.click(screen.getByRole('button', { name: /npm run dev/ }))
    expect(screen.getByText(/a process it started is still running and holding :5173/)).toBeInTheDocument()
    // A leftover's page isn't in the Preview tab, so there's nothing to open there.
    expect(screen.queryByRole('button', { name: 'Open preview' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Stop leftover process' }))
    expect(await screen.findByText('Stopped the process it left running.')).toBeInTheDocument()
  })

  it('opens the preview and the originating chat; finished shells offer neither Stop nor Preview', () => {
    const p = setup([server, failed])
    fireEvent.click(screen.getByRole('button', { name: /runserver 0\.0\.0\.0/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }))
    expect(p.onOpenPreview).toHaveBeenCalledWith(server)
    fireEvent.click(screen.getByRole('button', { name: 'Go to chat' }))
    expect(p.onGoToChat).toHaveBeenCalledWith(server)

    fireEvent.click(screen.getByRole('button', { name: /Failed \(exit 1\)/ }))
    const failedBody = screen.getByText('Exit code').closest('.tasks__body') as HTMLElement
    expect(within(failedBody).queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(within(failedBody).queryByRole('button', { name: 'Open preview' })).toBeNull()
  })

  it('keeps the stop outcome when the stopped row moves to Finished', async () => {
    const props = {
      onStop: vi.fn(async () => 'killed' as const),
      onOpenPreview: vi.fn(),
      onGoToChat: vi.fn(),
      onOpenTerminal: vi.fn(),
      onClearFinished: vi.fn()
    }
    const { rerender } = render(<TasksPanel tasks={[server]} now={() => NOW} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /runserver/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await screen.findByText('Stopped.')
    rerender(
      <TasksPanel tasks={[{ ...server, status: 'error', exitCode: null, finishedAt: NOW }]} now={() => NOW} {...props} />
    )
    expect(screen.getByRole('region', { name: 'Finished' })).toHaveTextContent('Stopped.')
  })

  it('says a task just started rather than "running for 0m"', () => {
    setup([{ ...server, startedAt: NOW - 5000 }])
    expect(screen.getByText('Shell · Started just now · backend/')).toBeInTheDocument()
  })

  it('says so when the Stop request itself fails', async () => {
    const p = setup([server])
    p.onStop.mockRejectedValueOnce(new Error('ipc down') as never)
    fireEvent.click(screen.getByRole('button', { name: /runserver/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(await screen.findByText("Couldn't stop this task. Try again.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
  })

  it('tells a shell main no longer tracks apart from one still loading', async () => {
    api.getBackgroundShellTail.mockResolvedValueOnce(null)
    setup([server])
    fireEvent.click(screen.getByRole('button', { name: /runserver/ }))
    expect(screen.getByText('Loading output…')).toBeInTheDocument()
    expect(await screen.findByText('Output is no longer available.')).toBeInTheDocument()
  })

  it('does not poll an expanded row while the Tasks tab is hidden', async () => {
    vi.useFakeTimers()
    const props = {
      onStop: vi.fn(async () => 'killed' as const),
      onOpenPreview: vi.fn(),
      onGoToChat: vi.fn(),
      onOpenTerminal: vi.fn(),
      onClearFinished: vi.fn()
    }
    const { rerender } = render(<TasksPanel tasks={[server]} active now={() => NOW} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /runserver/ }))
    await act(async () => {})
    expect(api.getBackgroundShellTail).toHaveBeenCalledTimes(1)
    rerender(<TasksPanel tasks={[server]} active={false} now={() => NOW} {...props} />)
    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })
    expect(api.getBackgroundShellTail).toHaveBeenCalledTimes(1)
    // Shown again: it refreshes right away and resumes polling.
    rerender(<TasksPanel tasks={[server]} active now={() => NOW} {...props} />)
    await act(async () => {})
    expect(api.getBackgroundShellTail).toHaveBeenCalledTimes(2)
  })

  it('opens a terminal row in the terminal panel', () => {
    const p = setup([terminal])
    fireEvent.click(screen.getByRole('button', { name: /Terminal 1/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    expect(p.onOpenTerminal).toHaveBeenCalledWith(terminal)
  })

  it('clears finished tasks', () => {
    const p = setup([server, failed])
    fireEvent.click(screen.getByRole('button', { name: 'Clear finished' }))
    expect(p.onClearFinished).toHaveBeenCalled()
  })

  it('copies the full command', async () => {
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    setup([server])
    fireEvent.click(screen.getByRole('button', { name: /runserver/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Command copied' })).toBeInTheDocument())
  })

  it('keeps user-facing copy free of em dashes', () => {
    setup([server, leftover, failed, terminal])
    for (const head of screen.getAllByRole('button', { expanded: false })) fireEvent.click(head)
    expect(document.body.textContent).not.toContain('—')
  })
})
