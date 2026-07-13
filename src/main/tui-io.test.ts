import { describe, it, expect } from 'vitest'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
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
    question: (_q, _opts, cb) => {
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

  it('resolves reads with null once closed, never re-questioning a dead interface', async () => {
    // Guards the ERR_USE_AFTER_CLOSE crash: after EOF at an in-run prompt (Ctrl-D),
    // the driver's next composer read must resolve null (→ clean exit), not call
    // rl.question on a closed interface (which throws).
    const f = fakeRl()
    const io = createTerminalIo({ createInterface: () => f.rl, write: () => {}, drainInput: () => {} })
    f.fire('close')
    const questionsBefore = f.calls.filter((c) => c === 'question').length
    await expect(io.readLine('> ')).resolves.toBeNull()
    await expect(io.readLine('again')).resolves.toBeNull()
    expect(f.calls.filter((c) => c === 'question').length).toBe(questionsBefore)
  })

  it('cancelRead resolves the pending read with null and pauses', async () => {
    const f = fakeRl()
    const io = createTerminalIo({ createInterface: () => f.rl, write: () => {}, drainInput: () => {} })
    const p = io.readLine('> ')
    io.cancelRead?.()
    await expect(p).resolves.toBeNull()
    expect(f.calls.filter((c) => c === 'pause')).toHaveLength(2) // initial + cancel
  })

  it('cancelRead cancels the underlying question so the next read is not corrupted', async () => {
    // Regression: uses a REAL node:readline (the fake can't reproduce it). Before
    // the AbortSignal fix, cancelRead left the first rl.question registered, so
    // the next read reused its stale prompt and delivered the user's line to the
    // dead callback — the new read never resolved.
    const input = new PassThrough()
    const output = new PassThrough()
    output.resume() // drain readline's escape output
    const io = createTerminalIo({
      createInterface: () =>
        createInterface({ input, output, terminal: true }) as unknown as ReadlineLike,
      write: () => {},
      drainInput: () => {}
    })
    // An approval-style read, then a Ctrl-C cancel of it.
    const first = io.readLine('APPROVE> ')
    io.cancelRead?.()
    await expect(first).resolves.toBeNull()
    // The next composer read must receive the user's line (not the abandoned one).
    const second = io.readLine('compose> ')
    input.write('hello world\n')
    await expect(second).resolves.toBe('hello world')
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

  it('select() falls back to typing when there is no TTY (the test env)', async () => {
    const f = fakeRl()
    const io = createTerminalIo({ createInterface: () => f.rl, write: () => {}, drainInput: () => {} })
    // process.stdin.isTTY is false under vitest → the picker can't run, so it
    // returns `type` and the driver uses the typed prompt instead.
    const r = await io.select?.({ title: 'x', options: [{ label: 'A', value: 'a' }] })
    expect(r).toEqual({ kind: 'type' })
  })
})

/** A controllable scheduler + clock + output capture for spinner tests. */
function spinnerHarness() {
  const writes: string[] = []
  let ticks: Array<() => void> = []
  let nowMs = 1000
  const f = fakeRl()
  const io = createTerminalIo({
    createInterface: () => f.rl,
    write: (s) => writes.push(s),
    drainInput: () => {},
    now: () => nowMs,
    schedule: (fn) => {
      ticks.push(fn)
      return () => {
        ticks = ticks.filter((t) => t !== fn)
      }
    }
  })
  return {
    io,
    f,
    writes,
    text: () => writes.join(''),
    tick: () => ticks.forEach((fn) => fn()),
    scheduled: () => ticks.length,
    advance: (ms: number) => {
      nowMs += ms
    }
  }
}

describe('createTerminalIo spinner', () => {
  it('schedules a redraw on start and draws the label + elapsed', () => {
    const h = spinnerHarness()
    h.io.startSpinner?.('Working')
    expect(h.scheduled()).toBe(1)
    h.tick()
    expect(h.text()).toContain('Working')
    expect(h.text()).toContain('0s')
    expect(h.text()).toContain('\r') // single-line redraw
  })

  it('advances the elapsed timer', () => {
    const h = spinnerHarness()
    h.io.startSpinner?.('Working')
    h.advance(3000)
    h.tick()
    expect(h.text()).toContain('3s')
  })

  it('relabels via setSpinnerLabel', () => {
    const h = spinnerHarness()
    h.io.startSpinner?.('Working')
    h.io.setSpinnerLabel?.('read_file')
    h.tick()
    expect(h.text()).toContain('read_file')
  })

  it('clears the spinner line before real output', () => {
    const h = spinnerHarness()
    h.io.startSpinner?.('Working')
    h.io.out('hello\n')
    // A clear precedes the real text.
    expect(h.text().indexOf('\x1b[2K')).toBeLessThan(h.text().indexOf('hello'))
  })

  it('stops: cancels the timer and erases the line', () => {
    const h = spinnerHarness()
    h.io.startSpinner?.('Working')
    expect(h.scheduled()).toBe(1)
    h.io.stopSpinner?.()
    expect(h.scheduled()).toBe(0)
    expect(h.text()).toContain('\x1b[2K')
  })

  it('stops the spinner while a picker is on screen', async () => {
    const h = spinnerHarness()
    h.io.startSpinner?.('Working')
    expect(h.text()).toBe('') // scheduled, but nothing drawn until the first tick
    // select() erases the spinner line before showing the picker (like readLine),
    // then the no-TTY test env falls back to `type`.
    const r = await h.io.select?.({ title: 'x', options: [{ label: 'A', value: 'a' }] })
    expect(r).toEqual({ kind: 'type' })
    expect(h.text()).toContain('\x1b[2K') // spinner line erased for the picker
    expect(h.scheduled()).toBe(1) // and the spinner resumes (turn still active)
  })

  it('pauses the spinner during a read and resumes after', async () => {
    const h = spinnerHarness()
    h.io.startSpinner?.('Working')
    const p = h.io.readLine('> ', { discardPending: true })
    // Reading pauses the redraw timer while the prompt is on screen.
    expect(h.scheduled()).toBe(0)
    h.f.submit('y')
    await p
    // Turn still active → spinner resumes.
    expect(h.scheduled()).toBe(1)
  })
})
