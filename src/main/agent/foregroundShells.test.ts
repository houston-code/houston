import { describe, expect, it, vi } from 'vitest'
import { backgroundForegroundShells, hasForegroundShell, registerForegroundShell } from './foregroundShells'

describe('foreground shell moves', () => {
  it('moves every running command of a run, once, and reports how many', () => {
    const a = vi.fn()
    const b = vi.fn()
    const other = vi.fn()
    registerForegroundShell('run1', 'c1', a)
    registerForegroundShell('run1', 'c2', b)
    registerForegroundShell('run2', 'c1', other)
    expect(hasForegroundShell('run1')).toBe(true)
    expect(backgroundForegroundShells('run1')).toBe(2)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
    // Already moved: a second press finds nothing.
    expect(hasForegroundShell('run1')).toBe(false)
    expect(backgroundForegroundShells('run1')).toBe(0)
    backgroundForegroundShells('run2')
  })

  it('a command that ended unregisters, so nothing is moved after it', () => {
    const move = vi.fn()
    const done = registerForegroundShell('run3', 'c1', move)
    done()
    expect(hasForegroundShell('run3')).toBe(false)
    expect(backgroundForegroundShells('run3')).toBe(0)
    expect(move).not.toHaveBeenCalled()
  })

  it('a stale unregister leaves a newer registration for the same call alone', () => {
    const first = vi.fn()
    const second = vi.fn()
    const undoFirst = registerForegroundShell('run4', 'c1', first)
    registerForegroundShell('run4', 'c1', second)
    undoFirst()
    expect(backgroundForegroundShells('run4')).toBe(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })
})
