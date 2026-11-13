import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  MAX_NOTIFY_PATTERNS,
  MAX_NOTIFY_PATTERN_LENGTH,
  MAX_WATCH_MATCHES,
  killAllShells,
  killShell,
  normalizeNotifyOn,
  readShellOutput,
  registerShell
} from './shells'
import {
  WAKE_DEBOUNCE_MS,
  resetBackgroundEventsForTest,
  setWakeHost,
  takeBackgroundEvents,
  type BackgroundEvent
} from './backgroundEvents'

const onClose = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => child.on('close', () => resolve()))
const node = (code: string): ChildProcess => spawn(process.execPath, ['-e', code])

type Exit = Extract<BackgroundEvent, { kind: 'shell_exit' }>
type Match = Extract<BackgroundEvent, { kind: 'shell_match' }>

beforeEach(() => resetBackgroundEventsForTest())
afterEach(() => {
  killAllShells()
  resetBackgroundEventsForTest()
})

describe('background shell exit reports', () => {
  it("reports a finished shell's exit code and last output to the chat that started it", async () => {
    const child = node('console.log("line one"); console.log("API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwx"); process.exit(4)')
    const id = registerShell('node build', child, 'conv-1')
    await onClose(child)
    const [ev] = takeBackgroundEvents('conv-1') as Exit[]
    expect(ev).toMatchObject({ kind: 'shell_exit', shellId: id, exitCode: 4, command: 'node build' })
    expect(ev!.stoppedBy).toBeUndefined()
    expect(ev!.tail).toContain('line one')
    // The tail is masked like everything else shown from a shell.
    expect(ev!.tail).not.toContain('abcdefghijklmnopqrstuvwx')
  })

  it('reports nothing for a shell with no chat', async () => {
    const child = node('process.exit(0)')
    registerShell('node', child)
    await onClose(child)
    expect(takeBackgroundEvents('undefined')).toEqual([])
  })

  it('reports nothing when the agent stopped it, or the app is shutting down', async () => {
    const a = node('setTimeout(() => {}, 30000)')
    const idA = registerShell('sleep', a, 'conv-2')
    killShell(idA)
    await onClose(a)
    const b = node('setTimeout(() => {}, 30000)')
    registerShell('sleep', b, 'conv-2')
    killAllShells()
    await onClose(b)
    expect(takeBackgroundEvents('conv-2')).toEqual([])
  })

  it("reports the user's Stop without waking the chat", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const start = vi.fn(() => true)
    setWakeHost({ enabled: () => true, start })
    const child = node('setTimeout(() => {}, 30000)')
    const id = registerShell('sleep', child, 'conv-3')
    killShell(id, { by: 'user' })
    await onClose(child)
    vi.advanceTimersByTime(WAKE_DEBOUNCE_MS * 2)
    vi.useRealTimers()
    expect(start).not.toHaveBeenCalled()
    const [ev] = takeBackgroundEvents('conv-3') as Exit[]
    expect(ev!.stoppedBy).toBe('user')
  })

  it('says a shell ended because its turn was cancelled', async () => {
    const ac = new AbortController()
    const child = node('setTimeout(() => {}, 30000)')
    registerShell('sleep', child, 'conv-4', undefined, { signal: ac.signal })
    ac.abort()
    child.kill()
    await onClose(child)
    const [ev] = takeBackgroundEvents('conv-4') as Exit[]
    expect(ev!.stoppedBy).toBe('cancel')
  })

  it('drops the exit report once the agent read the exited shell itself', async () => {
    const child = node('process.exit(1)')
    const id = registerShell('node', child, 'conv-5')
    await onClose(child)
    readShellOutput(id)
    expect(takeBackgroundEvents('conv-5')).toEqual([])
  })

  it('keeps the exit report when the agent read the shell while it still ran', async () => {
    const child = node('setTimeout(() => process.exit(2), 150)')
    const id = registerShell('node', child, 'conv-6')
    readShellOutput(id)
    await onClose(child)
    expect((takeBackgroundEvents('conv-6') as Exit[])[0]!.exitCode).toBe(2)
  })

  it('wakes the idle chat on a natural exit', async () => {
    const start = vi.fn(() => true)
    setWakeHost({ enabled: () => true, start })
    const child = node('process.exit(0)')
    registerShell('node', child, 'conv-7')
    await onClose(child)
    await new Promise((r) => setTimeout(r, WAKE_DEBOUNCE_MS + 100))
    expect(start).toHaveBeenCalledWith('conv-7')
  })
})

describe('notify_on watching', () => {
  it('reports lines containing a phrase, case-insensitively, including an unterminated last line', async () => {
    const child = node(
      'console.log("starting"); console.log("\\x1b[31mERROR\\x1b[0m: db down"); console.log("Compiled OK"); process.stdout.write("fatal error at end")'
    )
    registerShell('node dev', child, 'conv-8', undefined, { notifyOn: ['error', 'compiled'] })
    await onClose(child)
    const events = takeBackgroundEvents('conv-8')
    const matches = events.filter((e): e is Match => e.kind === 'shell_match')
    const byPattern = Object.fromEntries(matches.map((m) => [m.pattern, m.lines]))
    expect(byPattern.error).toEqual(['ERROR: db down', 'fatal error at end'])
    expect(byPattern.compiled).toEqual(['Compiled OK'])
    expect(events.some((e) => e.kind === 'shell_exit')).toBe(true)
  })

  it('stops watching after MAX_WATCH_MATCHES lines', async () => {
    const n = MAX_WATCH_MATCHES + 20
    const child = node(`for (let i = 0; i < ${n}; i++) console.log("hit " + i)`)
    registerShell('node', child, 'conv-9', undefined, { notifyOn: ['hit'] })
    await onClose(child)
    const [m] = takeBackgroundEvents('conv-9').filter((e): e is Match => e.kind === 'shell_match')
    expect(m!.lines.at(-1)).toContain('stopped watching')
    expect(m!.lines.length + m!.dropped).toBeLessThanOrEqual(MAX_WATCH_MATCHES + 1)
  })

  it('drops pending matches once the agent read the output', async () => {
    const child = node('console.log("error one"); setTimeout(() => {}, 30000)')
    const id = registerShell('node', child, 'conv-10', undefined, { notifyOn: ['error'] })
    await new Promise((r) => setTimeout(r, 300))
    readShellOutput(id)
    expect(takeBackgroundEvents('conv-10')).toEqual([])
    killShell(id)
    await onClose(child)
  })

  it('normalizes the phrases', () => {
    expect(normalizeNotifyOn(undefined)).toEqual([])
    expect(normalizeNotifyOn('ready')).toEqual(['ready'])
    expect(normalizeNotifyOn([' Ready ', 'ready', '', 3, 'err'])).toEqual(['Ready', 'err'])
    expect(normalizeNotifyOn(Array.from({ length: 9 }, (_, i) => `p${i}`))).toHaveLength(MAX_NOTIFY_PATTERNS)
    expect(normalizeNotifyOn(['x'.repeat(500)])[0]).toHaveLength(MAX_NOTIFY_PATTERN_LENGTH)
  })
})
