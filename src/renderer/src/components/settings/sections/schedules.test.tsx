import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, ProviderConfig } from '@shared/types'
import type { ScheduleDaemonStatus, ScheduleView } from '@shared/schedules'
import type { SettingsCtx } from '../context'
import {
  DAEMON_START_POLLS,
  DAEMON_START_POLL_MS,
  RUNNING_POLL_MS,
  ScheduleDaemonToggle,
  ScheduledRunsSection,
  usableModels
} from './schedules'

afterEach(cleanup)

const providers = [
  { id: 'anthropic', label: 'Anthropic', requiresKey: true, hasKey: true, models: [{ id: 'm1' }, { id: 'm2', label: 'M Two' }] },
  { id: 'openai', label: 'OpenAI', requiresKey: true, hasKey: false, models: [{ id: 'g' }] },
  { id: 'ollama', label: 'Ollama', requiresKey: false, hasKey: false, models: [] }
] as unknown as ProviderConfig[]

function ctx(): SettingsCtx {
  return {
    settings: { providers, selected: { providerId: 'anthropic', model: 'm2' } } as unknown as AppSettings,
    setSettings: vi.fn(),
    busy: null,
    setBusy: vi.fn(),
    keyInputs: {},
    setKeyInputs: vi.fn(),
    setFormError: vi.fn(),
    saveKey: vi.fn(),
    removeKey: vi.fn(),
    persistNow: vi.fn(),
    workspace: '/w/app',
    policy: null
  }
}

const sched = (over: Partial<ScheduleView> = {}): ScheduleView => ({
  id: 'sch-1',
  name: 'Nightly check',
  spec: 'daily at 09:00',
  prompt: 'Run the tests',
  workspace: '/w/app',
  providerId: 'anthropic',
  model: 'm1',
  approvalPolicy: 'plan',
  nextRunAt: new Date(2026, 10, 14, 9, 0).getTime(),
  createdAt: 1,
  ...over
})

function installApi(list: ScheduleView[]) {
  const ok = (): Promise<{ ok: true }> => Promise.resolve({ ok: true })
  const api = {
    listSchedules: vi.fn(() => Promise.resolve(list)),
    previewSchedule: vi.fn((spec: string) =>
      Promise.resolve(spec === 'bad' ? { ok: false, error: 'Unrecognized schedule' } : { ok: true, spec, nextRunAt: 0 })
    ),
    createSchedule: vi.fn(ok),
    setSchedulePaused: vi.fn(ok),
    runScheduleNow: vi.fn(ok),
    deleteSchedule: vi.fn(ok),
    pickDirectory: vi.fn(() => Promise.resolve('/w/other')),
    getScheduleDaemon: vi.fn(
      (): Promise<ScheduleDaemonStatus> => Promise.resolve({ supported: false, installed: false, running: false })
    ),
    setScheduleDaemon: vi.fn(
      (on: boolean): Promise<ScheduleDaemonStatus> => Promise.resolve({ supported: true, installed: on, running: on })
    )
  }
  window.api = api as unknown as typeof window.api
  return api
}

describe('usableModels', () => {
  it('offers only providers with a key (or none needed) and models', () => {
    expect(usableModels(providers)).toEqual([
      { providerId: 'anthropic', model: 'm1', label: 'Anthropic: m1' },
      { providerId: 'anthropic', model: 'm2', label: 'Anthropic: M Two' }
    ])
  })
})

describe('ScheduledRunsSection', () => {
  it('lists runs with their schedule, folder, model and state', async () => {
    installApi([sched(), sched({ id: 'sch-2', name: 'Paused one', paused: true, lastFiredAt: 5, lastResult: 'error', lastError: 'Too many sessions' })])
    render(<ScheduledRunsSection ctx={ctx()} />)
    expect(await screen.findByText('Nightly check')).toBeTruthy()
    expect(screen.getByText('Paused')).toBeTruthy()
    expect(screen.getByText(/couldn't start \(Too many sessions\)/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Resume Paused one' })).toBeTruthy()
  })

  it("shows how each last run went in plain words, and doesn't call a running one finished", async () => {
    installApi([
      sched({ id: 'a', name: 'A', lastFiredAt: 5, lastResult: 'running', lastRunConversationId: 'c1' }),
      sched({ id: 'b', name: 'B', lastFiredAt: 5, lastResult: 'ok', lastRunConversationId: 'c2' }),
      sched({ id: 'c', name: 'C', lastFiredAt: 5, lastResult: 'error', lastError: 'bad key', lastRunConversationId: 'c3' }),
      sched({ id: 'd', name: 'D', lastFiredAt: 5, lastResult: 'limit', lastLimit: 'max-steps', lastRunConversationId: 'c4' }),
      sched({ id: 'e', name: 'E', lastFiredAt: 5, lastResult: 'stopped', lastRunConversationId: 'c5' })
    ])
    render(<ScheduledRunsSection ctx={ctx()} />)
    expect(await screen.findByText(/: still running$/)).toBeTruthy()
    expect(screen.getByText(/: finished$/)).toBeTruthy()
    const failed = screen.getByText(/: failed \(bad key\)$/)
    expect(failed.className).toContain('sched-item__last--err')
    expect(screen.getByText(/: stopped at the step limit$/).className).toContain('sched-item__last--err')
    expect(screen.getByText(/: was stopped before it finished$/).className).toContain('sched-item__last--err')
    expect(screen.getByText(/: still running$/).className).not.toContain('sched-item__last--err')
    expect(document.body.textContent).not.toContain('—')
  })

  it('checks back while a run is in flight, so its outcome shows', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const api = installApi([sched({ lastFiredAt: 5, lastResult: 'running', lastRunConversationId: 'c1' })])
      render(<ScheduledRunsSection ctx={ctx()} />)
      await screen.findByText(/: still running$/)
      api.listSchedules.mockImplementation(() =>
        Promise.resolve([sched({ lastFiredAt: 5, lastResult: 'ok', lastRunConversationId: 'c1' })])
      )
      await vi.advanceTimersByTimeAsync(RUNNING_POLL_MS + 10)
      expect(await screen.findByText(/: finished$/)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('pauses, runs now and deletes after confirming', async () => {
    const api = installApi([sched()])
    render(<ScheduledRunsSection ctx={ctx()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Pause Nightly check' }))
    await waitFor(() => expect(api.setSchedulePaused).toHaveBeenCalledWith('sch-1', true))
    const runNow = screen.getByRole('button', { name: 'Run Nightly check now' }) as HTMLButtonElement
    await waitFor(() => expect(runNow.disabled).toBe(false))
    fireEvent.click(runNow)
    expect(await screen.findByText(/Started\./)).toBeTruthy()
    const del = screen.getByRole('button', { name: 'Delete Nightly check' }) as HTMLButtonElement
    await waitFor(() => expect(del.disabled).toBe(false))
    fireEvent.click(del)
    expect(api.deleteSchedule).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.deleteSchedule).toHaveBeenCalledWith('sch-1'))
  })

  it('creates one from the form, defaulting to the open project, chosen model and plan mode', async () => {
    const api = installApi([])
    render(<ScheduledRunsSection ctx={ctx()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'New scheduled run' }))
    expect(document.activeElement).toBe(screen.getByLabelText('Task each run starts with'))
    fireEvent.change(screen.getByLabelText('Task each run starts with'), { target: { value: 'Run the tests' } })
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'bad' } })
    expect(await screen.findByText('Unrecognized schedule')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'weekdays at 09:30' } })
    await waitFor(() => expect(api.previewSchedule).toHaveBeenCalledWith('weekdays at 09:30'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose…' }))
    await waitFor(() => expect((screen.getByLabelText('Folder') as HTMLInputElement).value).toBe('/w/other'))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() =>
      expect(api.createSchedule).toHaveBeenCalledWith({
        name: '',
        spec: 'weekdays at 09:30',
        prompt: 'Run the tests',
        workspace: '/w/other',
        providerId: 'anthropic',
        model: 'm2',
        approvalPolicy: 'plan'
      })
    )
    await waitFor(() => expect(screen.queryByRole('form', { name: 'New scheduled run' })).toBeNull())
  })

  it('shows a create error from main and keeps the form', async () => {
    const api = installApi([])
    api.createSchedule.mockResolvedValueOnce({ ok: false, error: 'Choose a folder that exists.' } as never)
    render(<ScheduledRunsSection ctx={ctx()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'New scheduled run' }))
    fireEvent.change(screen.getByLabelText('Task each run starts with'), { target: { value: 'x' } })
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'every 1h' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Choose a folder that exists.')
    expect(screen.getByRole('form', { name: 'New scheduled run' })).toBeTruthy()
  })
})

describe('ScheduleDaemonToggle', () => {
  const status = (over: Partial<ScheduleDaemonStatus> = {}): ScheduleDaemonStatus => ({
    supported: true,
    installed: false,
    running: false,
    ...over
  })
  const label = /Run scheduled runs when Houston is closed/

  it('is hidden where no login agent is supported', async () => {
    const api = installApi([])
    render(<ScheduleDaemonToggle />)
    await waitFor(() => expect(api.getScheduleDaemon).toHaveBeenCalled())
    expect(screen.queryByLabelText(label)).toBeNull()
  })

  it('stays hidden, without breaking the page, when the status cannot be read', async () => {
    const api = installApi([])
    api.getScheduleDaemon.mockRejectedValue(new Error('no handler'))
    render(<ScheduleDaemonToggle />)
    await waitFor(() => expect(api.getScheduleDaemon).toHaveBeenCalled())
    expect(screen.queryByLabelText(label)).toBeNull()
  })

  it('turns on and says it is running, then off', async () => {
    const api = installApi([])
    api.getScheduleDaemon.mockResolvedValue(status())
    render(<ScheduleDaemonToggle />)
    const box = (await screen.findByLabelText(label)) as HTMLInputElement
    expect(box.checked).toBe(false)
    fireEvent.click(box)
    await waitFor(() => expect(box.checked).toBe(true))
    expect(api.setScheduleDaemon).toHaveBeenCalledWith(true)
    expect(screen.getByRole('status').textContent).toBe('Running in the background.')
    fireEvent.click(box)
    await waitFor(() => expect(box.checked).toBe(false))
    expect(api.setScheduleDaemon).toHaveBeenLastCalledWith(false)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows an installed agent that is not running yet, and a failed change', async () => {
    const api = installApi([])
    api.getScheduleDaemon.mockResolvedValue(status({ installed: true }))
    api.setScheduleDaemon.mockResolvedValue(status({ installed: true, error: 'systemctl --user disable failed' }))
    render(<ScheduleDaemonToggle />)
    expect((await screen.findByRole('status')).textContent).toBe('Set up; it starts the next time you log in.')
    fireEvent.click(screen.getByLabelText(label))
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't turn it off: systemctl --user disable failed")
  })

  it('checks back after turning it on, until the background process it started is running', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const api = installApi([])
      api.getScheduleDaemon.mockResolvedValue(status())
      // Installing starts the process, which records itself a moment later.
      api.setScheduleDaemon.mockResolvedValue(status({ installed: true }))
      render(<ScheduleDaemonToggle />)
      fireEvent.click(await screen.findByLabelText(label))
      expect((await screen.findByRole('status')).textContent).toBe('Starting in the background…')
      api.getScheduleDaemon.mockResolvedValue(status({ installed: true, running: true }))
      await vi.advanceTimersByTimeAsync(DAEMON_START_POLL_MS + 10)
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Running in the background.'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops checking after a while, and says when it will start', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const api = installApi([])
      api.getScheduleDaemon.mockResolvedValue(status())
      api.setScheduleDaemon.mockResolvedValue(status({ installed: true }))
      render(<ScheduleDaemonToggle />)
      fireEvent.click(await screen.findByLabelText(label))
      await screen.findByText('Starting in the background…')
      api.getScheduleDaemon.mockResolvedValue(status({ installed: true }))
      await vi.advanceTimersByTimeAsync(DAEMON_START_POLL_MS * (DAEMON_START_POLLS + 1))
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Set up; it starts the next time you log in.'))
      const reads = api.getScheduleDaemon.mock.calls.length
      await vi.advanceTimersByTimeAsync(DAEMON_START_POLL_MS * 3)
      expect(api.getScheduleDaemon.mock.calls.length).toBe(reads)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sits in the Scheduled runs section, whose text no longer says runs need Houston open', async () => {
    const api = installApi([])
    api.getScheduleDaemon.mockResolvedValue(status())
    render(<ScheduledRunsSection ctx={ctx()} />)
    expect(await screen.findByLabelText(label)).toBeTruthy()
    expect(screen.queryByText(/They run only while Houston is open/)).toBeNull()
  })
})
