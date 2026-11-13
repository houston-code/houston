import { describe, expect, it } from 'vitest'
import { WindowRegistry, type RegistryWindow } from './windowRegistry'

function win(id: number): RegistryWindow & { destroyed: boolean } {
  const w = { id, webContentsId: id + 100, destroyed: false, isDestroyed: () => w.destroyed }
  return w
}

describe('WindowRegistry', () => {
  it('with one window, it is the primary, the target and the only one listed', () => {
    const r = new WindowRegistry()
    const a = win(1)
    r.add(a)
    expect(r.list()).toEqual([a])
    expect(r.primary()).toBe(a)
    expect(r.isPrimary(a)).toBe(true)
    expect(r.target()).toBe(a)
    expect(r.target(null)).toBe(a)
  })

  it('keeps the oldest open window as primary, and promotes the next when it closes', () => {
    const r = new WindowRegistry()
    const [a, b, c] = [win(1), win(2), win(3)]
    r.add(a)
    r.add(b)
    r.add(c)
    r.add(a) // re-adding is a no-op
    expect(r.size()).toBe(3)
    expect(r.isPrimary(b)).toBe(false)
    r.remove(a)
    expect(r.primary()).toBe(b)
    // A destroyed window drops out even before its removal is reported.
    b.destroyed = true
    expect(r.primary()).toBe(c)
    expect(r.list()).toEqual([c])
  })

  it('targets the focused window, else the one focused last, else the primary', () => {
    const r = new WindowRegistry()
    const [a, b, c] = [win(1), win(2), win(3)]
    r.add(a)
    r.add(b)
    r.add(c)
    expect(r.target()).toBe(a)
    r.noteFocus(c)
    r.noteFocus(b)
    expect(r.target()).toBe(b)
    expect(r.target(c)).toBe(c)
    // A focused window that isn't a chat window (a helper) doesn't count.
    expect(r.target(win(99))).toBe(b)
    r.remove(b)
    expect(r.target()).toBe(c)
    r.remove(c)
    expect(r.target()).toBe(a)
    r.remove(a)
    expect(r.target()).toBeUndefined()
  })

  it('ignores focus from a window it does not track', () => {
    const r = new WindowRegistry()
    const a = win(1)
    r.add(a)
    r.noteFocus(win(5))
    expect(r.target()).toBe(a)
  })

  it('finds windows by renderer id', () => {
    const r = new WindowRegistry()
    const a = win(1)
    r.add(a)
    expect(r.byWebContentsId(101)).toBe(a)
    expect(r.byWebContentsId(1)).toBeUndefined()
  })

  it('tracks which chat each window shows, preferring the target window when several do', () => {
    const r = new WindowRegistry()
    const [a, b, c] = [win(1), win(2), win(3)]
    r.add(a)
    r.add(b)
    r.add(c)
    r.setShowing(a, 'x')
    r.setShowing(b, 'x')
    r.setShowing(c, 'y')
    expect(r.showingIn(c)).toBe('y')
    expect(r.windowShowing('y')).toBe(c)
    expect(r.windowShowing('z')).toBeUndefined()
    // Neither showing window is in use: the newest of them.
    r.noteFocus(c)
    expect(r.windowShowing('x')).toBe(b)
    r.noteFocus(a)
    expect(r.windowShowing('x')).toBe(a)
    expect(r.windowShowing('x', b)).toBe(b)
    r.setShowing(a, null)
    expect(r.windowShowing('x')).toBe(b)
    r.remove(b)
    expect(r.windowShowing('x')).toBeUndefined()
    // An untracked window's report is ignored.
    r.setShowing(win(9), 'x')
    expect(r.windowShowing('x')).toBeUndefined()
  })
})
