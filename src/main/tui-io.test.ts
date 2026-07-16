import { describe, it, expect } from 'vitest'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
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

  it('readSecret (off-TTY fallback) still resolves a submitted value', async () => {
    // process.stdin.isTTY is false under vitest, so readSecret degrades to a normal
    // read (the raw-mode masking is MANUAL-VERIFY, like the picker).
    const f = fakeRl()
    const io = createTerminalIo({ createInterface: () => f.rl, write: () => {}, drainInput: () => {} })
    const p = io.readSecret!('key › ')
    expect(f.calls).toContain('question')
    f.submit('sk-secret')
    await expect(p).resolves.toBe('sk-secret')
  })

  it('readSecret masks input and suppresses readline echo (raw TTY)', async () => {
    // Reproduces the leak where readline software-echoes each typed char next to our
    // mask (b•2•4•…). Stub a fake TTY for process.stdin so the raw-mode path runs.
    const realStdin = process.stdin
    const fake = new EventEmitter() as unknown as NodeJS.ReadStream
    Object.assign(fake, { isTTY: true, setRawMode: () => {}, resume: () => {}, pause: () => {} })
    // A pre-existing readline-style keypress listener that would echo the raw char.
    const echoed: string[] = []
    const readlineEcho = (s: string): void => {
      if (s) echoed.push(s)
    }
    fake.on('keypress', readlineEcho)
    Object.defineProperty(process, 'stdin', { value: fake, configurable: true })
    try {
      const writes: string[] = []
      const f = fakeRl()
      const io = createTerminalIo({
        createInterface: () => f.rl,
        write: (s) => writes.push(s),
        drainInput: () => {}
      })
      const p = io.readSecret!('key › ')
      // readline's echo listener is detached; only readSecret's own handler remains.
      expect(fake.listenerCount('keypress')).toBe(1)
      fake.emit('keypress', 'x', { name: 'x' })
      fake.emit('keypress', '9', { name: '9' })
      fake.emit('keypress', '', { name: 'return' })
      await expect(p).resolves.toBe('x9')
      const out = writes.join('')
      expect(out).toContain('••') // masked, one bullet per char
      expect(out).not.toContain('x') // the real characters never hit the screen
      expect(out).not.toContain('9')
      expect(echoed).toEqual([]) // readline never got to echo them
      // readline's listener is restored so the next read still works.
      expect(fake.listeners('keypress')).toContain(readlineEcho)
    } finally {
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true })
    }
  })

  it('readSecret resolves null on close instead of hanging', async () => {
    // Regression (R2): a masked prompt must not outlive the interface. If stdin closes
    // while `key ›` is up, the read has to settle to null, not hang the /login loop.
    const f = fakeRl()
    const io = createTerminalIo({ createInterface: () => f.rl, write: () => {}, drainInput: () => {} })
    const p = io.readSecret!('key › ')
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

/**
 * A fake TTY stdin: a PassThrough that claims to be a terminal and records raw-mode
 * transitions. Lets the raw-mode composer be driven end to end (real decoder, real
 * editor, real redraw) with no actual terminal, which is where the paste bug lived.
 */
function fakeTty() {
  const rawModes: boolean[] = []
  const s = new PassThrough() as unknown as NodeJS.ReadStream
  s.isTTY = true
  s.setRawMode = ((on: boolean) => {
    rawModes.push(on)
    return s
  }) as NodeJS.ReadStream['setRawMode']
  return Object.assign(s, { rawModes })
}

describe('readComposer (raw-mode composer)', () => {
  function harness(over: Parameters<typeof createTerminalIo>[0] = {}) {
    const stdin = fakeTty()
    const written: string[] = []
    // A controllable clock: the composer treats keys arriving within 50ms of paste
    // bytes as clipboard content, so a test standing in for a human must let time
    // pass between pasting and pressing Enter (see sanitizePastedKeys).
    let clock = 1000
    const io = createTerminalIo({
      stdin,
      createInterface: () => fakeRl().rl,
      write: (s) => written.push(s),
      columns: () => 80,
      now: () => clock,
      ...over
    })
    return {
      io,
      stdin,
      written,
      text: () => written.join(''),
      /** Advance the clock, standing in for a human's pause before the next key. */
      tick: (ms = 500) => {
        clock += ms
      }
    }
  }

  it('submits a typed line on Enter', async () => {
    const { io, stdin } = harness()
    const read = io.readComposer!('> ')
    stdin.push('hello')
    stdin.push('\r')
    await expect(read).resolves.toBe('hello')
  })

  // The regression this whole path exists for: a pasted block must arrive as one
  // message, not submit its first line and replay the rest.
  it('lands a bracketed multi-line paste as ONE message', async () => {
    const t = harness()
    const read = t.io.readComposer!('> ')
    t.stdin.push('\x1b[200~first line\nsecond line\nthird line\x1b[201~')
    t.tick()
    t.stdin.push('\r')
    await expect(read).resolves.toBe('first line\nsecond line\nthird line')
  })

  it('expands a collapsed big paste on submit', async () => {
    const t = harness()
    const read = t.io.readComposer!('> ')
    const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    t.stdin.push(`\x1b[200~${body}\x1b[201~`)
    t.tick()
    t.stdin.push('\r')
    await expect(read).resolves.toBe(body)
  })

  it('enables bracketed paste while reading and disables it on the way out', async () => {
    const { io, stdin, text } = harness()
    const read = io.readComposer!('> ')
    expect(text()).toContain('\x1b[?2004h')
    stdin.push('x\r')
    await read
    expect(text()).toContain('\x1b[?2004l')
  })

  it('enters raw mode for the read and restores cooked mode after', async () => {
    const { io, stdin } = harness()
    const read = io.readComposer!('> ')
    stdin.push('x\r')
    await read
    expect(stdin.rawModes).toEqual([true, false])
  })

  it('edits with emacs keys before submitting', async () => {
    const { io, stdin } = harness()
    const read = io.readComposer!('> ')
    stdin.push('world')
    stdin.push('\x01') // Ctrl-A: start of line
    stdin.push('hello ')
    stdin.push('\r')
    await expect(read).resolves.toBe('hello world')
  })

  it('recalls history with Up', async () => {
    const { io, stdin } = harness({ history: () => ['earlier message'] })
    const read = io.readComposer!('> ')
    stdin.push('\x1b[A')
    stdin.push('\r')
    await expect(read).resolves.toBe('earlier message')
  })

  it('builds a multi-line message with Ctrl-J', async () => {
    const { io, stdin } = harness()
    const read = io.readComposer!('> ')
    stdin.push('one\ntwo\r')
    await expect(read).resolves.toBe('one\ntwo')
  })

  it('resolves null on Ctrl-D at an empty composer', async () => {
    const { io, stdin } = harness()
    const read = io.readComposer!('> ')
    stdin.push('\x04')
    await expect(read).resolves.toBeNull()
  })

  it('routes Ctrl-C through the interrupt handler and resolves null', async () => {
    const { io, stdin } = harness()
    let fired = 0
    io.onInterrupt?.(() => fired++)
    const read = io.readComposer!('> ')
    stdin.push('abandoned draft')
    stdin.push('\x03')
    await expect(read).resolves.toBeNull()
    expect(fired).toBe(1)
  })

  it('completes a slash command on Tab', async () => {
    const { io, stdin } = harness({
      completer: (line, cb) => cb(null, [['/help '], line])
    })
    const read = io.readComposer!('> ')
    stdin.push('/he')
    stdin.push('\t')
    await new Promise((r) => setImmediate(r)) // the completer round trip is async
    stdin.push('\r')
    // The trailing space comes from the completion itself, so the next token can
    // just be typed; the driver trims the submitted line.
    await expect(read).resolves.toBe('/help ')
  })

  it('hands the draft to $EDITOR on Ctrl-X Ctrl-E and takes back the result', async () => {
    const { io, stdin } = harness({
      editText: async (initial) => `${initial} (edited)`
    })
    const read = io.readComposer!('> ')
    stdin.push('draft')
    stdin.push('\x18\x05')
    await new Promise((r) => setImmediate(r)) // the editor round trip is async
    stdin.push('\r')
    await expect(read).resolves.toBe('draft (edited)')
  })

  it('searches history with Ctrl-R', async () => {
    const { io, stdin } = harness({ history: () => ['run the tests', 'git status'] })
    const read = io.readComposer!('> ')
    stdin.push('\x12') // Ctrl-R
    stdin.push('tests')
    stdin.push('\r') // accept the match
    stdin.push('\r') // submit it
    await expect(read).resolves.toBe('run the tests')
  })

  it('redraws only its own rows — never a full-screen clear', async () => {
    const { io, stdin, text } = harness()
    const read = io.readComposer!('> ')
    stdin.push('abc')
    stdin.push('\r')
    await read
    expect(text()).not.toContain('\x1b[2J') // no screen clear
    expect(text()).toContain('\x1b[0J') // bounded erase-to-end only
  })

  it('falls back to the readline prompt when stdin is not a TTY', async () => {
    const plain = new PassThrough() as unknown as NodeJS.ReadStream
    plain.isTTY = false
    const rl = fakeRl()
    const io = createTerminalIo({ stdin: plain, createInterface: () => rl.rl, write: () => {} })
    const read = io.readComposer!('> ')
    rl.submit('typed via readline')
    await expect(read).resolves.toBe('typed via readline')
  })
})

/**
 * A paste body is attacker-controlled (text copied from a web page, a file, an
 * issue comment). If it carries its own ESC[201~ it ends paste mode early, and
 * anything after that marker would decode as real keystrokes. These pin the
 * defense: within the post-paste window nothing but content survives.
 */
describe('readComposer — hostile paste content', () => {
  function harness() {
    const stdin = fakeTty()
    let clock = 1000
    let spawnedEditor = 0
    const io = createTerminalIo({
      stdin,
      createInterface: () => fakeRl().rl,
      write: () => {},
      columns: () => 80,
      now: () => clock,
      editText: async (t) => {
        spawnedEditor++
        return t
      }
    })
    return {
      io,
      stdin,
      editorSpawns: () => spawnedEditor,
      tick: (ms = 500) => {
        clock += ms
      }
    }
  }
  const START = '\x1b[200~'
  const END = '\x1b[201~'

  it('does not submit a turn from a CR smuggled after an embedded end marker', async () => {
    const t = harness()
    const read = t.io.readComposer!('> ')
    // The clipboard payload closes paste mode itself, then "presses Enter".
    t.stdin.push(`${START}rm -rf important${END}\r${END}`)
    // Nothing resolved: the CR became a line break, not a submission.
    const raced = await Promise.race([read, Promise.resolve('still-open')])
    expect(raced).toBe('still-open')
    // The human's own Enter, later, submits — and the payload is visibly just text.
    t.tick()
    t.stdin.push('\r')
    await expect(read).resolves.toContain('rm -rf important')
  })

  it('does not submit when the smuggled CR arrives in a later chunk', async () => {
    // Chunk boundaries are attacker-influenceable (a TTY splits at its buffer
    // size), so the guard cannot rely on the CR sharing a chunk with the paste.
    const t = harness()
    const read = t.io.readComposer!('> ')
    t.stdin.push(`${START}payload${END}`)
    t.stdin.push(`\r${END}`)
    const raced = await Promise.race([read, Promise.resolve('still-open')])
    expect(raced).toBe('still-open')
  })

  it('does not spawn $EDITOR from a smuggled Ctrl-X Ctrl-E', async () => {
    const t = harness()
    const read = t.io.readComposer!('> ')
    t.stdin.push(`${START}payload${END}\x18\x05${END}`)
    await new Promise((r) => setImmediate(r))
    expect(t.editorSpawns()).toBe(0)
    t.tick()
    t.stdin.push('\r')
    await read
  })

  it('does not quit the session from a smuggled Ctrl-D', async () => {
    const t = harness()
    const read = t.io.readComposer!('> ')
    t.stdin.push(`${START}${END}\x04${END}`)
    const raced = await Promise.race([read, Promise.resolve('still-open')])
    expect(raced).toBe('still-open')
  })

  it('does not wipe the visible draft from a smuggled Ctrl-U', async () => {
    // Ctrl-U would hide the payload by clearing what the user can see, so the
    // text they review is not the text that gets sent.
    const t = harness()
    const read = t.io.readComposer!('> ')
    t.stdin.push(`${START}visible payload${END}\x15${END}`)
    t.tick()
    t.stdin.push('\r')
    await expect(read).resolves.toContain('visible payload')
  })

  it('strips escape sequences from a paste rather than echoing them back', async () => {
    const t = harness()
    const read = t.io.readComposer!('> ')
    t.stdin.push(`${START}safe\x07\x1b]0;pwn\x07text${END}`)
    t.tick()
    t.stdin.push('\r')
    const got = (await read) as string
    expect(got).toContain('safe')
    expect(got).not.toContain('\x1b')
    expect(got).not.toContain('\x07')
  })

  it('lets a real keystroke through once the paste burst is over', async () => {
    const t = harness()
    const read = t.io.readComposer!('> ')
    t.stdin.push(`${START}context${END}`)
    t.tick() // the human pauses, then types and sends
    t.stdin.push(' please review')
    t.stdin.push('\r')
    await expect(read).resolves.toBe('context please review')
  })
})

/**
 * A bell for something you are already watching is nuisance, and a nuisance bell
 * is one people turn off — so the alert is gated on the terminal telling us it
 * lost focus. The subtlety is terminals that never report at all.
 */
describe('signal (attention) — focus gating', () => {
  function harness() {
    const stdin = fakeTty()
    const written: string[] = []
    const io = createTerminalIo({
      stdin,
      createInterface: () => fakeRl().rl,
      write: (s) => written.push(s),
      columns: () => 80
    })
    return { io, stdin, text: () => written.join(''), clear: () => (written.length = 0) }
  }
  const alert = { title: 'Houston', body: 'Finished' }

  it('always sets the title — it is ambient, not an interruption', () => {
    const t = harness()
    t.io.signal!({ title: 'working' })
    expect(t.text()).toBe('\x1b]0;working\x07')
  })

  // A terminal with no focus reporting never tells us anything; reading that
  // silence as "focused" would silently disable every signal on those terminals.
  it('alerts when focus is unknown, rather than staying silent', () => {
    const t = harness()
    t.io.signal!({ alert })
    expect(t.text()).toContain('\x07')
    expect(t.text()).toContain(']9;')
  })

  it('stays quiet once the terminal reports the window IS focused', () => {
    const t = harness()
    t.io.startSpinner!('Working') // arms the watcher, which enables focus reporting
    t.stdin.push('\x1b[I')
    t.clear()
    t.io.signal!({ alert })
    expect(t.text()).not.toContain(']9;')
  })

  it('alerts once the terminal reports the window lost focus', () => {
    const t = harness()
    t.io.startSpinner!('Working')
    t.stdin.push('\x1b[I')
    t.stdin.push('\x1b[O')
    t.clear()
    t.io.signal!({ alert })
    expect(t.text()).toContain(']9;')
    expect(t.text()).toContain(']777;notify;')
  })

  it('asks the terminal to report focus while a turn runs, and stops asking after', () => {
    const t = harness()
    t.io.startSpinner!('Working')
    expect(t.text()).toContain('[?1004h')
    t.clear()
    t.io.stopSpinner!()
    expect(t.text()).toContain('[?1004l')
  })

  it('tracks focus reported while the user is at the composer', async () => {
    const t = harness()
    const read = t.io.readComposer!('> ')
    t.stdin.push('\x1b[O') // they switched away mid-draft
    t.clear()
    t.io.signal!({ alert })
    expect(t.text()).toContain(']9;')
    t.stdin.push('\r')
    await read
  })
})
