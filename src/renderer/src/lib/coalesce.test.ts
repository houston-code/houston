import { describe, expect, it } from 'vitest'
import { coalesced } from './coalesce'

/** A refresh whose completion the test controls. */
function controlled(): { run: () => Promise<void>; started: () => number; land: () => void; fail: () => void } {
  let count = 0
  let settle: { resolve: () => void; reject: (e: Error) => void } | null = null
  return {
    run: () =>
      new Promise<void>((resolve, reject) => {
        count++
        settle = { resolve, reject }
      }),
    started: () => count,
    land: () => settle?.resolve(),
    fail: () => settle?.reject(new Error('boom'))
  }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('coalesced', () => {
  it('runs once for calls made in the same tick', async () => {
    const c = controlled()
    const refresh = coalesced(c.run)
    const all = [refresh(), refresh(), refresh()]
    await tick()
    expect(c.started()).toBe(1)
    c.land()
    await Promise.all(all)
    expect(c.started()).toBe(1)
  })

  it('gives calls made during a run one shared follow-up that starts after it lands', async () => {
    const c = controlled()
    const refresh = coalesced(c.run)
    const first = refresh()
    await tick()
    expect(c.started()).toBe(1)
    // The data may have changed since the first run was sent: these need a newer one.
    const late = [refresh(), refresh()]
    await tick()
    expect(c.started()).toBe(1)
    c.land()
    await first
    await tick()
    expect(c.started()).toBe(2)
    c.land()
    await Promise.all(late)
    expect(c.started()).toBe(2)
  })

  it('starts a fresh run for a call made after everything settled', async () => {
    const c = controlled()
    const refresh = coalesced(c.run)
    const a = refresh()
    await tick()
    c.land()
    await a
    const b = refresh()
    await tick()
    expect(c.started()).toBe(2)
    c.land()
    await b
  })

  it('a failed run rejects its callers and does not block the next', async () => {
    const c = controlled()
    const refresh = coalesced(c.run)
    const a = refresh()
    await tick()
    const b = refresh()
    c.fail()
    await expect(a).rejects.toThrow('boom')
    await tick()
    expect(c.started()).toBe(2)
    c.land()
    await b
  })
})
