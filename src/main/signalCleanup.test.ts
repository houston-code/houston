import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { installSignalCleanup, type CleanupSignal, type SignalProcess } from './signalCleanup'

/** A stand-in for `process`: emits signals on demand and records exit codes. */
function fakeProcess(): SignalProcess & { emitter: EventEmitter; exits: number[]; exited: Promise<number> } {
  const emitter = new EventEmitter()
  const exits: number[] = []
  let resolveExit: (code: number) => void = () => {}
  const exited = new Promise<number>((r) => (resolveExit = r))
  return {
    emitter,
    exits,
    exited,
    on: (sig, fn) => emitter.on(sig, fn),
    removeListener: (sig, fn) => emitter.removeListener(sig, fn),
    exit: (code) => {
      exits.push(code)
      resolveExit(code)
    }
  }
}

describe('installSignalCleanup', () => {
  it.each<[CleanupSignal, number]>([
    ['SIGHUP', 129],
    ['SIGINT', 130],
    ['SIGTERM', 143]
  ])('on %s runs the cleanup once and exits with %i', async (sig, code) => {
    const proc = fakeProcess()
    const cleanup = vi.fn(async () => {})
    installSignalCleanup(cleanup, { signals: ['SIGHUP', 'SIGINT', 'SIGTERM'], proc })
    proc.emitter.emit(sig)
    expect(await proc.exited).toBe(code)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(proc.exits).toEqual([code])
    // Exiting disposes the listeners.
    expect(proc.emitter.listenerCount(sig)).toBe(0)
  })

  it('listens only for the signals it was given', () => {
    const proc = fakeProcess()
    installSignalCleanup(() => {}, { signals: ['SIGHUP', 'SIGTERM'], proc })
    expect(proc.emitter.listenerCount('SIGINT')).toBe(0)
    expect(proc.emitter.listenerCount('SIGHUP')).toBe(1)
    expect(proc.emitter.listenerCount('SIGTERM')).toBe(1)
  })

  it('shares one cleanup between the normal exit and a signal that lands during it', async () => {
    const proc = fakeProcess()
    let finish: () => void = () => {}
    const cleanup = vi.fn(() => new Promise<void>((r) => (finish = r)))
    const guard = installSignalCleanup(cleanup, { signals: ['SIGTERM'], proc })
    const normal = guard.run()
    proc.emitter.emit('SIGTERM')
    expect(guard.run()).toBe(normal)
    finish()
    expect(await proc.exited).toBe(143)
    await normal
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('never runs the cleanup twice, and a second signal exits at once', async () => {
    const proc = fakeProcess()
    const cleanup = vi.fn(() => new Promise<void>(() => {})) // wedged
    installSignalCleanup(cleanup, { signals: ['SIGINT'], proc, timeoutMs: 60_000 })
    proc.emitter.emit('SIGINT')
    expect(proc.exits).toEqual([])
    proc.emitter.emit('SIGINT')
    expect(proc.exits).toEqual([130])
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('exits anyway once a wedged cleanup runs past the deadline', async () => {
    const proc = fakeProcess()
    installSignalCleanup(() => new Promise<void>(() => {}), { signals: ['SIGHUP'], proc, timeoutMs: 20 })
    proc.emitter.emit('SIGHUP')
    expect(await proc.exited).toBe(129)
  })

  it('still exits when the cleanup throws', async () => {
    const proc = fakeProcess()
    installSignalCleanup(
      () => {
        throw new Error('boom')
      },
      { signals: ['SIGTERM'], proc }
    )
    proc.emitter.emit('SIGTERM')
    expect(await proc.exited).toBe(143)
  })

  it('runs the signal-only step on a signal, after the cleanup, and never on a normal exit', async () => {
    const order: string[] = []
    const proc = fakeProcess()
    const guard = installSignalCleanup(() => void order.push('cleanup'), {
      signals: ['SIGTERM'],
      proc,
      beforeSignalExit: () => void order.push('flush')
    })
    await guard.run()
    expect(order).toEqual(['cleanup'])

    const proc2 = fakeProcess()
    const order2: string[] = []
    installSignalCleanup(() => void order2.push('cleanup'), {
      signals: ['SIGTERM'],
      proc: proc2,
      beforeSignalExit: () => void order2.push('flush')
    })
    proc2.emitter.emit('SIGTERM')
    await proc2.exited
    expect(order2).toEqual(['cleanup', 'flush'])
  })

  it('stops listening after dispose (the normal exit path)', async () => {
    const proc = fakeProcess()
    const cleanup = vi.fn()
    const guard = installSignalCleanup(cleanup, { signals: ['SIGHUP', 'SIGTERM'], proc })
    await guard.run()
    guard.dispose()
    guard.dispose()
    expect(proc.emitter.listenerCount('SIGHUP')).toBe(0)
    expect(proc.emitter.listenerCount('SIGTERM')).toBe(0)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })
})
