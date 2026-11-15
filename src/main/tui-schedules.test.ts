import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppSettings } from '@shared/types'
import type { ScheduleView } from '@shared/schedules'
import type { ScheduledRunInfo, ScheduledRunInput } from './agent/scheduler'
import { makePainter, parseSlashCommand } from './tui'
import {
  parseScheduleArgs,
  renderScheduleList,
  runScheduleCommand,
  type ScheduleBackend,
  type ScheduleCommandDeps
} from './tui-schedules'

const paint = makePainter(false)
const NOW = Date.UTC(2026, 10, 16, 8, 0)

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'houston-tuisched-')))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const view = (over: Partial<ScheduleView> = {}): ScheduleView => ({
  id: 's1',
  name: 'Nightly triage',
  spec: 'daily at 18:30',
  prompt: 'Triage new issues.\nLabel them.',
  workspace: '/work/app',
  providerId: 'anthropic',
  model: 'claude-a',
  approvalPolicy: 'plan',
  nextRunAt: NOW + 3 * 3600_000,
  createdAt: NOW - 86_400_000,
  ...over
})

function fakeScheduler(initial: ScheduleView[] = []) {
  const list = [...initial]
  const backend: ScheduleBackend & { created: ScheduledRunInput[] } = {
    created: [],
    list: () => list,
    create: vi.fn((input: ScheduledRunInput) => {
      backend.created.push(input)
      const info = { ...input, id: `s${list.length + 1}`, nextRunAt: NOW + 60_000, createdAt: NOW } as ScheduledRunInfo
      list.push(info as ScheduleView)
      return info
    }),
    cancel: vi.fn((id: string) => {
      const i = list.findIndex((s) => s.id === id)
      if (i < 0) return false
      list.splice(i, 1)
      return true
    }),
    setPaused: vi.fn((id: string, paused: boolean) => {
      const s = list.find((x) => x.id === id)
      if (!s) return null
      s.paused = paused
      return s as ScheduledRunInfo
    }),
    runNow: vi.fn(async () => {})
  }
  return backend
}

const settings = {
  providers: [
    { id: 'anthropic', kind: 'anthropic', label: 'Anthropic', builtIn: true, requiresKey: true, hasKey: true, models: [{ id: 'claude-a' }, { id: 'claude-b' }] }
  ]
} as unknown as AppSettings

function harness(answers: Array<string | null>, scheduler: ScheduleBackend | null = fakeScheduler()) {
  const out: string[] = []
  const lines = [...answers]
  const deps: ScheduleCommandDeps = {
    ...(scheduler ? { scheduler } : {}),
    getSettings: () => settings,
    readLine: vi.fn(async () => (lines.length ? (lines.shift() as string | null) : null)),
    out: (t) => out.push(t),
    cwd: dir,
    providerId: 'anthropic',
    model: 'claude-a',
    now: () => NOW
  }
  const run = (arg: string) => runScheduleCommand(parseScheduleArgs(arg), deps, paint)
  return { deps, run, text: () => out.join('') }
}

describe('parseScheduleArgs', () => {
  it('reads each verb and its number', () => {
    expect(parseScheduleArgs('')).toEqual({ op: 'list' })
    expect(parseScheduleArgs('add')).toEqual({ op: 'add' })
    expect(parseScheduleArgs('pause 2')).toEqual({ op: 'pause', index: 2 })
    expect(parseScheduleArgs('Resume 1')).toEqual({ op: 'resume', index: 1 })
    expect(parseScheduleArgs('run 3')).toEqual({ op: 'run', index: 3 })
    expect(parseScheduleArgs('rm 1')).toEqual({ op: 'delete', index: 1 })
    expect(parseScheduleArgs('show 1')).toEqual({ op: 'show', index: 1 })
  })
  it('falls back to usage for a missing or bad number, or an unknown verb', () => {
    expect(parseScheduleArgs('pause')).toEqual({ op: 'usage' })
    expect(parseScheduleArgs('pause 0')).toEqual({ op: 'usage' })
    expect(parseScheduleArgs('pause 1x')).toEqual({ op: 'usage' })
    expect(parseScheduleArgs('pause 1 2')).toEqual({ op: 'usage' })
    expect(parseScheduleArgs('frob 1')).toEqual({ op: 'usage' })
  })
  it('is what /schedule and /schedules parse to', () => {
    expect(parseSlashCommand('/schedule', settings)).toEqual({ kind: 'schedule', op: { op: 'list' } })
    expect(parseSlashCommand('/schedules pause 1', settings)).toEqual({ kind: 'schedule', op: { op: 'pause', index: 1 } })
  })
})

describe('/schedule list and actions', () => {
  it('numbers the runs with their spec, next run, model, mode, and last result', () => {
    const text = renderScheduleList(
      [view(), view({ id: 's2', name: 'Paused one', paused: true, lastResult: 'error', lastError: 'no key' })],
      paint,
      NOW
    )
    expect(text).toContain(' 1. Nightly triage  daily at 18:30  next in 3 h')
    expect(text).toContain('in app · anthropic/claude-a · Plan mode (read-only)')
    expect(text).toContain(' 2. Paused one  daily at 18:30  paused')
    expect(text).toContain("last run couldn't start (no key)")
  })
  it('says how to make one when there are none', async () => {
    const h = harness([])
    await h.run('')
    expect(h.text()).toContain('no scheduled runs')
  })
  it('pauses, resumes, and runs one now by number', async () => {
    const s = fakeScheduler([view()])
    const h = harness([], s)
    await h.run('pause 1')
    expect(s.setPaused).toHaveBeenCalledWith('s1', true)
    await h.run('pause 1')
    expect(h.text()).toContain('already paused')
    await h.run('resume 1')
    expect(s.setPaused).toHaveBeenLastCalledWith('s1', false)
    await h.run('run 1')
    expect(s.runNow).toHaveBeenCalledWith('s1')
    expect(h.text()).toContain('started Nightly triage now')
  })
  it('reports a run-now failure', async () => {
    const s = fakeScheduler([view()])
    s.runNow = vi.fn(async () => Promise.reject(new Error('no API key for anthropic')))
    const h = harness([], s)
    await h.run('run 1')
    expect(h.text()).toContain('could not start Nightly triage: no API key for anthropic')
  })
  it('deletes only after a yes, and refuses a number not listed', async () => {
    const s = fakeScheduler([view()])
    const h = harness(['n', 'y'], s)
    await h.run('delete 1')
    expect(s.cancel).not.toHaveBeenCalled()
    await h.run('delete 1')
    expect(s.cancel).toHaveBeenCalledWith('s1')
    await h.run('delete 1')
    expect(h.text()).toContain('no scheduled run 1')
  })
  it('shows the full task', async () => {
    const h = harness([], fakeScheduler([view()]))
    await h.run('show 1')
    expect(h.text()).toContain('    Triage new issues.\n    Label them.')
  })
  it('strips control characters from stored text', () => {
    const text = renderScheduleList([view({ name: 'bad\u001b[2Jname' })], paint, NOW)
    expect(text).not.toContain('\u001b')
  })
  it('says when no scheduler is wired', async () => {
    const h = harness([], null)
    await h.run('')
    expect(h.text()).toContain('unavailable here')
  })
})

describe('/schedule add', () => {
  it('creates one with the defaults: this folder, this chat\'s model, plan mode', async () => {
    const s = fakeScheduler()
    const h = harness(['every 30m', 'Check the build', '', '', '', '', 'y'], s)
    await h.run('add')
    expect(s.created).toEqual([
      {
        name: 'Check the build',
        spec: 'every 30m',
        prompt: 'Check the build',
        workspace: dir,
        providerId: 'anthropic',
        model: 'claude-a',
        approvalPolicy: 'plan'
      }
    ])
    expect(h.text()).toContain('created Check the build')
  })
  it('re-asks a schedule it cannot read, and takes a named model and mode', async () => {
    const s = fakeScheduler()
    const h = harness(['whenever', 'weekdays at 09:00', 'Triage', 'Morning', '', 'anthropic/claude-b', 'auto', 'yes'], s)
    await h.run('add')
    expect(h.text()).toMatch(/· .+\n/)
    expect(s.created[0]).toMatchObject({ name: 'Morning', model: 'claude-b', approvalPolicy: 'auto-edit' })
  })
  it('saves nothing without a yes, on Ctrl-D, or for a folder that does not exist', async () => {
    const s = fakeScheduler()
    await harness(['every 1h', 'x', '', '', '', '', 'n'], s).run('add')
    await harness(['every 1h', null], s).run('add')
    const missing = harness(['every 1h', 'x', '', join(dir, 'nope'), '', ''], s)
    await missing.run('add')
    expect(s.create).not.toHaveBeenCalled()
    expect(missing.text()).toContain('Choose a folder that exists.')
  })
  it('refuses an unknown model or approval mode', async () => {
    const s = fakeScheduler()
    const bad = harness(['every 1h', 'x', '', '', 'ghost/model'], s)
    await bad.run('add')
    expect(bad.text()).toContain('choose a configured model')
    const mode = harness(['every 1h', 'x', '', '', '', 'yolo'], s)
    await mode.run('add')
    expect(mode.text()).toContain('approval mode is plan, ask, auto, or full')
    expect(s.create).not.toHaveBeenCalled()
  })
  it('warns before creating a full-auto schedule', async () => {
    const s = fakeScheduler()
    const h = harness(['every 1h', 'x', '', '', '', 'full', 'y'], s)
    await h.run('add')
    expect(h.text()).toContain('no one there to approve')
    expect(s.created[0].approvalPolicy).toBe('full-auto')
  })
  it('reports what the scheduler refuses', async () => {
    const s = fakeScheduler()
    s.create = vi.fn(() => {
      throw new Error('Too many scheduled runs.')
    })
    const h = harness(['every 1h', 'x', '', '', '', '', 'y'], s)
    await h.run('add')
    expect(h.text()).toContain('Too many scheduled runs. Nothing saved.')
  })
})
