import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const logged = vi.hoisted(() => ({ lines: [] as string[] }))
vi.mock('./logger', () => ({
  log: {
    debug: (m: string) => logged.lines.push(`DEBUG ${m}`),
    info: (m: string) => logged.lines.push(`INFO ${m}`),
    warn: (m: string) => logged.lines.push(`WARN ${m}`),
    error: (m: string) => logged.lines.push(`ERROR ${m}`)
  }
}))

import {
  MAX_LISTED_DUMPS,
  MAX_RENDERER_ERROR_CHARS,
  RECENT_DUMP_MS,
  RENDERER_ERROR_LIMIT,
  UNRESPONSIVE_GRACE_MS,
  createReloadGuard,
  createRendererErrorLogger,
  parseRendererError,
  recentCrashDumps,
  startLocalCrashReporter,
  watchRendererCrashes
} from './crashRecovery'

beforeEach(() => {
  logged.lines = []
})

describe('createReloadGuard', () => {
  it('allows `limit` reloads per window, then refuses until the window moves on', () => {
    let t = 0
    const allow = createReloadGuard(3, 60_000, () => t)
    expect([allow(), allow(), allow(), allow()]).toEqual([true, true, true, false])
    t = 59_999
    expect(allow()).toBe(false)
    t = 60_000
    expect(allow()).toBe(true)
  })
})

function fakeWindow() {
  const win = new EventEmitter() as EventEmitter & { destroyed: boolean; webContents: any; isDestroyed(): boolean }
  win.destroyed = false
  win.isDestroyed = () => win.destroyed
  const wc = new EventEmitter() as any
  wc.isDestroyed = () => false
  wc.reload = vi.fn()
  wc.forcefullyCrashRenderer = vi.fn()
  win.webContents = wc
  return win
}

function fakeTimers() {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
  return {
    timers,
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false }
      timers.push(t)
      return t
    },
    clearTimer: (t: unknown) => {
      ;(t as { cleared: boolean }).cleared = true
    }
  }
}

describe('watchRendererCrashes', () => {
  it('logs a crash and reloads the page', () => {
    const win = fakeWindow()
    watchRendererCrashes(win as never)
    win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 })
    expect(win.webContents.reload).toHaveBeenCalledTimes(1)
    expect(logged.lines[0]).toBe('ERROR renderer process gone: reason=crashed exitCode=11')
  })

  it('does not reload a page that exited cleanly or a window already gone', () => {
    const win = fakeWindow()
    watchRendererCrashes(win as never)
    win.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
    win.destroyed = true
    win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    expect(win.webContents.reload).not.toHaveBeenCalled()
  })

  it('stops reloading a page that keeps crashing, and says so', () => {
    const win = fakeWindow()
    let n = 0
    watchRendererCrashes(win as never, { allowReload: () => ++n <= 2 })
    for (let i = 0; i < 4; i++) win.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 1 })
    expect(win.webContents.reload).toHaveBeenCalledTimes(2)
    expect(logged.lines.filter((l) => l.includes('not reloading it again'))).toHaveLength(2)
  })

  it('restarts a renderer that stays unresponsive past the grace period', () => {
    const win = fakeWindow()
    const t = fakeTimers()
    watchRendererCrashes(win as never, t)
    win.emit('unresponsive')
    win.emit('unresponsive') // one timer, not two
    expect(t.timers).toHaveLength(1)
    expect(t.timers[0].ms).toBe(UNRESPONSIVE_GRACE_MS)
    t.timers[0].fn()
    expect(win.webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1)
    // The restart reports as a crash, which reloads through the guarded path.
    win.webContents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 9 })
    expect(win.webContents.reload).toHaveBeenCalledTimes(1)
  })

  it('leaves a renderer alone that recovers in time', () => {
    const win = fakeWindow()
    const t = fakeTimers()
    watchRendererCrashes(win as never, t)
    win.emit('unresponsive')
    win.emit('responsive')
    expect(t.timers[0].cleared).toBe(true)
    expect(win.webContents.forcefullyCrashRenderer).not.toHaveBeenCalled()
    expect(logged.lines).toContain('INFO renderer is responding again')
  })
})

describe('startLocalCrashReporter', () => {
  it('starts the reporter with uploading off', () => {
    const start = vi.fn()
    startLocalCrashReporter({ start })
    expect(start).toHaveBeenCalledWith({ uploadToServer: false })
  })

  it('never throws when the reporter will not start', () => {
    expect(() =>
      startLocalCrashReporter({
        start: () => {
          throw new Error('nope')
        }
      })
    ).not.toThrow()
    expect(logged.lines[0]).toMatch(/could not start the local crash reporter: nope/)
  })
})

describe('recentCrashDumps', () => {
  const now = 1_000_000_000_000
  const dir = (name: string) => ({ name, isDirectory: () => true, isFile: () => false })
  const file = (name: string) => ({ name, isDirectory: () => false, isFile: () => true })

  it('lists recent dump file names only, newest first, one folder deep, capped', () => {
    const tree: Record<string, ReturnType<typeof file>[]> = {
      '/dumps': [dir('completed'), dir('pending'), file('settings.dat'), file('top.dmp')],
      '/dumps/completed': [dir('deeper'), ...Array.from({ length: 6 }, (_, i) => file(`c${i}.dmp`)), file('old.dmp')],
      '/dumps/pending': [file('p.DMP')],
      '/dumps/completed/deeper': [file('too-deep.dmp')]
    }
    const age: Record<string, number> = { 'old.dmp': RECENT_DUMP_MS + 1, 'top.dmp': 10, 'p.DMP': 5 }
    const names = recentCrashDumps('/dumps', now, {
      readdir: (d) => {
        const entries = tree[d.replaceAll('\\', '/')]
        if (!entries) throw new Error('ENOENT')
        return entries
      },
      mtimeMs: (p) => {
        const name = p.split(/[\\/]/).pop()!
        return now - (age[name] ?? 100 + Number(name.replace(/\D/g, '')))
      }
    })
    expect(names).toHaveLength(MAX_LISTED_DUMPS)
    expect(names.slice(0, 2)).toEqual(['p.DMP', 'top.dmp'])
    expect(names).not.toContain('old.dmp')
    expect(names).not.toContain('too-deep.dmp')
    for (const n of names) expect(n).not.toMatch(/[\\/]/)
  })

  it('reads a missing folder as none', () => {
    expect(recentCrashDumps('/nowhere-houston-test')).toEqual([])
  })
})

describe('renderer errors', () => {
  it('accepts a well-formed report and caps its fields', () => {
    const long = 'x'.repeat(MAX_RENDERER_ERROR_CHARS + 10)
    expect(parseRendererError({ kind: 'boundary', message: long, stack: long, componentStack: '' })).toEqual({
      kind: 'boundary',
      message: 'x'.repeat(MAX_RENDERER_ERROR_CHARS),
      stack: 'x'.repeat(MAX_RENDERER_ERROR_CHARS)
    })
  })

  it('refuses anything else', () => {
    for (const bad of [null, 'boom', { kind: 'other', message: 'm' }, { kind: 'error', message: 3 }, { kind: 'error' }]) {
      expect(parseRendererError(bad)).toBeNull()
    }
  })

  it('logs each error with its stacks, and rate-limits a flood per window', () => {
    let t = 0
    const report = createRendererErrorLogger(() => t)
    report(1, { kind: 'error', message: 'TypeError: x is undefined', stack: 'at f', componentStack: '\n    in Row' })
    expect(logged.lines[0]).toBe('ERROR renderer error: TypeError: x is undefined\nat f\ncomponent stack:\n    in Row')
    for (let i = 0; i < RENDERER_ERROR_LIMIT + 5; i++) report(1, { kind: 'error', message: `e${i}` })
    report(2, { kind: 'unhandledrejection', message: 'other window' })
    expect(logged.lines.filter((l) => l.startsWith('ERROR renderer error'))).toHaveLength(RENDERER_ERROR_LIMIT)
    expect(logged.lines).toContain('ERROR renderer unhandledrejection: other window')
    t = 60_000
    report(1, { kind: 'error', message: 'later' })
    expect(logged.lines).toContain('WARN renderer 1: 6 more error(s) not logged')
    expect(logged.lines.at(-1)).toBe('ERROR renderer error: later')
  })
})
