import { describe, it, expect } from 'vitest'
import { resolveColor, createTerminalIo, type ReadlineLike } from './tui-io'

describe('resolveColor', () => {
  it('requires a TTY by default', () => {
    expect(resolveColor({}, true)).toBe(true)
    expect(resolveColor({}, false)).toBe(false)
  })

  it('disables color whenever NO_COLOR is present (any value, per spec)', () => {
    expect(resolveColor({ NO_COLOR: '1' }, true)).toBe(false)
    expect(resolveColor({ NO_COLOR: '' }, true)).toBe(false) // empty still counts
  })

  it('disables color for a dumb terminal', () => {
    expect(resolveColor({ TERM: 'dumb' }, true)).toBe(false)
  })

  it('FORCE_COLOR forces color on even without a TTY', () => {
    expect(resolveColor({ FORCE_COLOR: '1' }, false)).toBe(true)
    // FORCE_COLOR='0' is not a force; a TTY still gets color on its own merit.
    expect(resolveColor({ FORCE_COLOR: '0' }, true)).toBe(true)
  })

  it('FORCE_COLOR=0/false does not force, and NO_COLOR wins over FORCE_COLOR', () => {
    expect(resolveColor({ FORCE_COLOR: '0' }, false)).toBe(false)
    expect(resolveColor({ FORCE_COLOR: 'false' }, false)).toBe(false)
    expect(resolveColor({ NO_COLOR: '1', FORCE_COLOR: '1' }, true)).toBe(false)
  })
})

/** A fake readline interface recording the pause/resume/question lifecycle. */
function fakeRl() {
  const events: Record<string, Array<() => void>> = {}
  const calls: string[] = []
  let answer: ((a: string) => void) | null = null
  const rl: ReadlineLike = {
    question: (_q, cb) => {
      calls.push('question')
      answer = cb
    },
    pause: () => calls.push('pause'),
    resume: () => calls.push('resume'),
    on: (event, cb) => {
      ;(events[event] ??= []).push(cb)
    },
    close: () => calls.push('close')
  }
  return {
    rl,
    calls,
    submit: (a: string) => answer?.(a),
    fire: (event: string) => (events[event] ?? []).forEach((cb) => cb())
  }
}

describe('createTerminalIo lifecycle', () => {
  it('starts paused so idle keystrokes are not echoed', () => {
    const f = fakeRl()
    createTerminalIo({ createInterface: () => f.rl, write: () => {}, drainInput: () => {} })
    expect(f.calls).toEqual(['pause'])
  })

  it('resumes for a read and pauses again once the line is submitted', async () => {
    const f = fakeRl()
    const io = createTerminalIo({ createInterface: () => f.rl, write: () => {}, drainInput: () => {} })
    const p = io.readLine('› ')
    // resume + question happen synchronously when the read starts.
    expect(f.calls).toEqual(['pause', 'resume', 'question'])
    f.submit('hello')
    await expect(p).resolves.toBe('hello')
    // and it pauses again afterwards.
    expect(f.calls).toEqual(['pause', 'resume', 'question', 'pause'])
  })

  it('drains buffered input before a discardPending (sensitive) read', () => {
    const f = fakeRl()
    let drained = 0
    const io = createTerminalIo({
      createInterface: () => f.rl,
      write: () => {},
      drainInput: () => {
        drained++
      }
    })
    io.readLine('> ', { discardPending: true })
    expect(drained).toBe(1)
    // a normal read does NOT drain (type-ahead for the composer is fine).
    io.readLine('› ')
    expect(drained).toBe(1)
  })

  it('resolves an outstanding read with null on EOF (close)', async () => {
    const f = fakeRl()
    const io = createTerminalIo({ createInterface: () => f.rl, write: () => {}, drainInput: () => {} })
    const p = io.readLine('› ')
    f.fire('close')
    await expect(p).resolves.toBeNull()
  })

  it('cancelRead resolves the pending read with null and pauses', async () => {
    const f = fakeRl()
    const io = createTerminalIo({ createInterface: () => f.rl, write: () => {}, drainInput: () => {} })
    const p = io.readLine('> ')
    io.cancelRead?.()
    await expect(p).resolves.toBeNull()
    expect(f.calls.filter((c) => c === 'pause')).toHaveLength(2) // initial + cancel
  })

  it('registers SIGINT and close handlers', () => {
    const f = fakeRl()
    const io = createTerminalIo({ createInterface: () => f.rl, write: () => {}, drainInput: () => {} })
    let interrupted = false
    io.onInterrupt?.(() => {
      interrupted = true
    })
    f.fire('SIGINT')
    expect(interrupted).toBe(true)
  })
})
