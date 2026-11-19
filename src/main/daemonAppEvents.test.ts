import { describe, expect, it } from 'vitest'
import { appBundleOf, REOPEN_DEBOUNCE_MS, wireDaemonAppEvents, type DaemonAppEventsDeps } from './daemonAppEvents'

const EXEC = '/Applications/Houston.app/Contents/MacOS/Houston'

type Listener = (event: { preventDefault: () => void }, arg?: string) => void

function harness(over: Partial<DaemonAppEventsDeps> = {}) {
  const listeners = new Map<string, Listener>()
  const runs: Array<{ file: string; args: string[] }> = []
  let t = 1_000_000
  const wired = wireDaemonAppEvents({
    platform: 'darwin',
    execPath: EXEC,
    on: (event, listener) => listeners.set(event, listener),
    run: (file, args) => runs.push({ file, args }),
    log: () => {},
    now: () => t,
    ...over
  })
  const fire = (event: string, arg?: string): { prevented: boolean } => {
    const state = { prevented: false }
    listeners.get(event)?.({ preventDefault: () => (state.prevented = true) }, arg)
    return state
  }
  return { wired, listeners, runs, fire, advance: (ms: number) => (t += ms) }
}

describe('appBundleOf', () => {
  it('finds the .app around a bundle executable', () => {
    expect(appBundleOf(EXEC)).toBe('/Applications/Houston.app')
    expect(appBundleOf('/Volumes/My Apps/Houston Beta.app/Contents/MacOS/Houston')).toBe('/Volumes/My Apps/Houston Beta.app')
  })

  it('is null outside a bundle (a development run)', () => {
    expect(appBundleOf('/repo/node_modules/electron/dist/electron')).toBeNull()
    expect(appBundleOf('/opt/Houston/Contents/MacOS/Houston')).toBeNull()
  })
})

describe('wireDaemonAppEvents', () => {
  it('starts the window app as a new instance when the daemon is asked to reopen', () => {
    const h = harness()
    expect(h.wired).toBe(true)
    h.fire('activate')
    expect(h.runs).toEqual([{ file: '/usr/bin/open', args: ['-n', '-a', '/Applications/Houston.app'] }])
  })

  it('starts one app for a burst of reopens, and another once the burst is over', () => {
    const h = harness()
    h.fire('activate')
    h.advance(REOPEN_DEBOUNCE_MS - 1)
    h.fire('activate')
    expect(h.runs).toHaveLength(1)
    h.advance(1)
    h.fire('activate')
    expect(h.runs).toHaveLength(2)
  })

  it('hands a houston:// link to the window app on its argv', () => {
    const h = harness()
    const r = h.fire('open-url', 'houston://open?path=%2Ftmp%2Fproj')
    expect(r.prevented).toBe(true)
    expect(h.runs).toEqual([
      { file: '/usr/bin/open', args: ['-n', '-a', '/Applications/Houston.app', '--args', 'houston://open?path=%2Ftmp%2Fproj'] }
    ])
  })

  it('passes every link on, however quickly they come', () => {
    const h = harness()
    h.fire('open-url', 'houston://chat/a')
    h.fire('open-url', 'houston://chat/b')
    expect(h.runs.map((r) => r.args.at(-1))).toEqual(['houston://chat/a', 'houston://chat/b'])
  })

  it('opens a file with the window app', () => {
    const h = harness()
    const r = h.fire('open-file', '/tmp/notes.md')
    expect(r.prevented).toBe(true)
    expect(h.runs).toEqual([{ file: '/usr/bin/open', args: ['-n', '-a', '/Applications/Houston.app', '/tmp/notes.md'] }])
  })

  it('ignores an empty link or file, and anything that could read as an option', () => {
    const h = harness()
    h.fire('open-url', '')
    h.fire('open-url', '--inspect=9229')
    h.fire('open-file')
    h.fire('open-file', '-a')
    h.fire('open-file', 'relative/path')
    expect(h.runs).toEqual([])
  })

  it('wires nothing off macOS or outside an app bundle', () => {
    for (const over of [
      { platform: 'linux' as const },
      { platform: 'win32' as const },
      { execPath: '/repo/node_modules/electron/dist/electron' }
    ]) {
      const h = harness(over)
      expect(h.wired).toBe(false)
      expect(h.listeners.size).toBe(0)
    }
  })
})
