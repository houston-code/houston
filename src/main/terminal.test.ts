import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IPC } from '@shared/constants'

/** A controllable fake of node-pty's IPty, with helpers to drive its callbacks. */
function makeFakePty() {
  let dataCb: (chunk: string) => void = () => {}
  let exitCb: (e: { exitCode: number }) => void = () => {}
  return {
    onData: (cb: (chunk: string) => void) => {
      dataCb = cb
      return { dispose: vi.fn() }
    },
    onExit: (cb: (e: { exitCode: number }) => void) => {
      exitCb = cb
      return { dispose: vi.fn() }
    },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    // test drivers
    emitData: (d: string) => dataCb(d),
    emitExit: (code: number) => exitCb({ exitCode: code })
  }
}

const spawned: ReturnType<typeof makeFakePty>[] = []
const ptyMock = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node-pty', () => ptyMock)

import {
  createTerminal,
  writeTerminal,
  resizeTerminal,
  killTerminal,
  killAllTerminals,
  terminalCount
} from './terminal'

const nextTick = (): Promise<void> => new Promise((r) => setImmediate(r))

function fakeSender() {
  return { send: vi.fn(), isDestroyed: () => false }
}

beforeEach(() => {
  killAllTerminals()
  spawned.length = 0
  ptyMock.spawn.mockReset()
  ptyMock.spawn.mockImplementation(() => {
    const p = makeFakePty()
    spawned.push(p)
    return p
  })
})

describe('terminal manager', () => {
  it('spawns a PTY with the requested cwd and an xterm TERM', () => {
    const sender = fakeSender()
    const cwd = process.cwd() // a directory that really exists
    const id = createTerminal(sender, { cwd, cols: 100, rows: 30 })
    expect(typeof id).toBe('string')
    expect(terminalCount()).toBe(1)
    expect(ptyMock.spawn).toHaveBeenCalledTimes(1)
    const [, , opts] = ptyMock.spawn.mock.calls[0]
    expect(opts.cwd).toBe(cwd)
    expect(opts.cols).toBe(100)
    expect(opts.env.TERM).toBe('xterm-256color')
  })

  it('falls back to home when the requested cwd does not exist', () => {
    createTerminal(fakeSender(), { cwd: '/no/such/dir/at/all' })
    const [, , opts] = ptyMock.spawn.mock.calls[0]
    expect(opts.cwd).toBe(process.env.HOME)
  })

  it('coalesces a burst of output into one IPC message on the next tick', async () => {
    const sender = fakeSender()
    const id = createTerminal(sender)
    spawned[0].emitData('hel')
    spawned[0].emitData('lo')
    // Nothing sent synchronously — it's buffered.
    expect(sender.send).not.toHaveBeenCalled()
    await nextTick()
    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sender.send).toHaveBeenCalledWith(IPC.terminalData, { id, data: 'hello' })
  })

  it('drains buffered output before announcing exit, then drops the terminal', () => {
    const sender = fakeSender()
    const id = createTerminal(sender)
    spawned[0].emitData('bye')
    spawned[0].emitExit(0) // synchronous, before the flush timer fires
    expect(sender.send).toHaveBeenNthCalledWith(1, IPC.terminalData, { id, data: 'bye' })
    expect(sender.send).toHaveBeenNthCalledWith(2, IPC.terminalExit, { id, exitCode: 0 })
    expect(terminalCount()).toBe(0)
  })

  it('forwards input to the PTY', () => {
    const sender = fakeSender()
    const id = createTerminal(sender)
    writeTerminal(id, 'ls\n')
    expect(spawned[0].write).toHaveBeenCalledWith('ls\n')
  })

  it('resizes the PTY, ignoring non-positive dimensions', () => {
    const sender = fakeSender()
    const id = createTerminal(sender)
    resizeTerminal(id, 120, 40)
    expect(spawned[0].resize).toHaveBeenCalledWith(120, 40)
    resizeTerminal(id, 0, 0)
    expect(spawned[0].resize).toHaveBeenCalledTimes(1)
  })

  it('kills a terminal and reports unknown ids', () => {
    const sender = fakeSender()
    const id = createTerminal(sender)
    expect(killTerminal(id)).toBe(true)
    expect(spawned[0].kill).toHaveBeenCalled()
    expect(terminalCount()).toBe(0)
    expect(killTerminal(id)).toBe(false)
  })

  it('ignores input/resize for unknown ids without throwing', () => {
    expect(() => writeTerminal('nope', 'x')).not.toThrow()
    expect(() => resizeTerminal('nope', 80, 24)).not.toThrow()
  })

  it('killAllTerminals kills every terminal and clears the registry', () => {
    createTerminal(fakeSender())
    createTerminal(fakeSender())
    expect(terminalCount()).toBe(2)
    killAllTerminals()
    expect(spawned[0].kill).toHaveBeenCalled()
    expect(spawned[1].kill).toHaveBeenCalled()
    expect(terminalCount()).toBe(0)
  })

  it('does not send to a destroyed sender', async () => {
    const sender = { send: vi.fn(), isDestroyed: () => true }
    createTerminal(sender)
    spawned[0].emitData('x')
    await nextTick()
    expect(sender.send).not.toHaveBeenCalled()
  })
})
