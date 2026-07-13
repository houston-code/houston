import { createInterface as nodeCreateInterface, emitKeypressEvents } from 'node:readline'
import { spinnerFrame, type TuiIo, type Painter } from './tui'
import {
  initialPickerState,
  reducePicker,
  renderPicker,
  keyToPickerKey,
  type PickerSpec,
  type PickerOutcome
} from './tui-picker'

/** Carriage-return + erase-line: rewinds to column 0 and clears the current line. */
const CLEAR_LINE = '\r\x1b[2K'

/**
 * Real terminal I/O for interactive mode (`Houston -i`), backed by node:readline.
 * Split out from index.ts and parameterized so its lifecycle logic — the part
 * that actually prevents visual corruption — is unit-testable with a fake
 * interface, while the pure driver in tui.ts stays terminal-agnostic.
 *
 * Why the pause/resume dance: a readline interface in terminal mode owns the TTY
 * and ECHOES keystrokes the entire time it is resumed — not only while a
 * `question()` is outstanding. The driver streams assistant output with raw
 * `stdout.write` (bypassing readline) between reads, so if the interface were left
 * resumed, anything the user typed mid-stream would be echoed into the middle of
 * that output and readline's next line-refresh would repaint against a drifted
 * cursor. Keeping the interface PAUSED except during an actual read closes that:
 * paused → no keypress processing → no echo, while raw mode (still set) keeps the
 * terminal from echoing either.
 */

/** The slice of a readline Interface this adapter drives (fakeable in tests). */
export interface ReadlineLike {
  /**
   * Ask for a line. The `signal` cancels the outstanding question (node:readline
   * ≥17) — the adapter aborts it on cancel/EOF so an abandoned question callback
   * can't collide with the next read.
   */
  question(query: string, opts: { signal?: AbortSignal }, cb: (answer: string) => void): void
  pause(): void
  resume(): void
  on(event: string, cb: () => void): void
  close(): void
}

export interface TerminalIoDeps {
  /** Build the readline interface. Defaults to node:readline over stdin/stdout. */
  createInterface?: () => ReadlineLike
  /** Write to the output stream. Defaults to process.stdout.write. */
  write?: (s: string) => void
  /** Discard buffered type-ahead before a sensitive read. Defaults to draining stdin. */
  drainInput?: () => void
  /** Painter for spinner frames (matches the session's color setting). */
  paint?: Painter
  /** Schedule a repeating tick; returns a canceller. Injectable for tests. */
  schedule?: (fn: () => void, ms: number) => () => void
  /** Clock for the elapsed timer. Defaults to Date.now. */
  now?: () => number
  /** readline Tab-completer (slash commands + @-files). Wired at the entry point. */
  completer?: (line: string, cb: (err: null, result: [string[], string]) => void) => void
  /** Initial Up/Down history (newest last), seeded into readline. */
  history?: string[]
}

/**
 * Decide whether to emit ANSI color, honoring the common conventions. Precedence:
 * an explicit opt-out (`NO_COLOR` present at any value, per no-color.org — or
 * `TERM=dumb`) always wins; then `FORCE_COLOR` forces it on even without a TTY;
 * otherwise color requires a TTY. Kept pure for testing.
 */
export function resolveColor(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if ('NO_COLOR' in env) return false
  if (env.TERM === 'dumb') return false
  const force = env.FORCE_COLOR
  if (force !== undefined && force !== '0' && force !== 'false') return true
  return isTTY
}

/** Best-effort discard of bytes already buffered on stdin (type-ahead). */
function defaultDrain(): void {
  const stdin = process.stdin as NodeJS.ReadStream
  while (stdin.read() !== null) {
    /* discard whatever the user typed while output was streaming */
  }
}

export function createTerminalIo(deps: TerminalIoDeps = {}): TuiIo {
  const rl =
    deps.createInterface?.() ??
    (nodeCreateInterface({
      input: process.stdin,
      output: process.stdout,
      // Tab-complete slash commands + @-file mentions, and seed persisted history
      // (readline drives Up/Down navigation once the array is seeded, newest last).
      completer: deps.completer,
      history: deps.history ? [...deps.history].reverse() : undefined
    }) as unknown as ReadlineLike)
  const rawWrite = deps.write ?? ((s: string) => void process.stdout.write(s))
  const drainInput = deps.drainInput ?? defaultDrain
  const paint = deps.paint ?? ((s: string) => s)
  const now = deps.now ?? Date.now
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number): (() => void) => {
      const id = setInterval(fn, ms)
      return () => clearInterval(id)
    })

  let pending: ((line: string | null) => void) | null = null
  // The AbortController for the outstanding rl.question, so cancelRead / EOF can
  // actually cancel it. Without this, node:readline keeps the abandoned question
  // callback registered; the NEXT read then collides with it — the next prompt
  // shows the stale text and the user's line is delivered to (and swallowed by)
  // the dead callback, hanging the new read.
  let questionAbort: AbortController | null = null
  const settle = (line: string | null): void => {
    if (pending) {
      const resolve = pending
      pending = null
      questionAbort?.abort()
      questionAbort = null
      resolve(line)
    }
  }

  // --- Spinner: a single redrawn line, erased before any real output. This is the
  // ONLY in-place redraw in the TUI; confining it to one line + erase-before-write
  // keeps the transcript tear-free.
  let spinnerLabel: string | null = null
  let spinnerStart = 0
  let tick = 0
  let cancelTimer: (() => void) | null = null
  const drawSpinner = (): void => {
    if (spinnerLabel === null) return
    rawWrite(CLEAR_LINE + spinnerFrame(tick++, spinnerLabel, Math.floor((now() - spinnerStart) / 1000), paint))
  }
  const startTimer = (): void => {
    if (!cancelTimer && spinnerLabel !== null) cancelTimer = schedule(drawSpinner, 100)
  }
  const stopTimer = (erase: boolean): void => {
    if (cancelTimer) {
      cancelTimer()
      cancelTimer = null
    }
    if (erase) rawWrite(CLEAR_LINE)
  }
  const out = (s: string): void => {
    // Clear the spinner line before real output so streamed text never lands on a
    // spinner frame; the timer redraws it on the next tick, on the fresh line.
    if (cancelTimer) rawWrite(CLEAR_LINE)
    rawWrite(s)
  }

  // --- Interrupt watch. While a turn streams, the interface is paused AND the
  // terminal is raw, so a Ctrl-C is neither a SIGINT (raw disables ISIG) nor a
  // delivered byte (paused stdin doesn't flow) — it just sits buffered, so the run
  // couldn't be interrupted. During that window we resume stdin under a minimal raw
  // keypress listener that acts ONLY on Ctrl-C and swallows everything else (no
  // echo, no type-ahead into the next prompt). readLine and the picker detach it
  // and handle their own Ctrl-C (readline's 'SIGINT' / the picker's cancel key), so
  // exactly one consumer owns stdin at a time — the same discipline the picker uses.
  let interruptHandler: (() => void) | null = null
  let watching = false
  const onWatchKey = (_s: string, key: { ctrl?: boolean; name?: string } | undefined): void => {
    if (key?.ctrl && key.name === 'c') interruptHandler?.()
  }
  const startInterruptWatch = (): void => {
    const stdin = process.stdin
    if (watching || !stdin.isTTY || typeof stdin.setRawMode !== 'function') return
    try {
      emitKeypressEvents(stdin)
      stdin.setRawMode(true)
      stdin.resume()
      stdin.on('keypress', onWatchKey)
      watching = true
    } catch {
      /* no TTY / raw mode unavailable — Ctrl-C during streaming just won't fire */
    }
  }
  const stopInterruptWatch = (): void => {
    if (!watching) return
    watching = false
    try {
      process.stdin.removeListener('keypress', onWatchKey)
      process.stdin.pause()
    } catch {
      /* best-effort */
    }
  }
  // Safety net: however the process ends (clean exit, uncaught error, SIGTERM),
  // leave the terminal usable — drop the keypress listener and restore cooked mode.
  // Raw mode is on during every streaming turn now (the watcher), so a crash mid-run
  // could otherwise leave the user's shell in raw mode until they run `reset`.
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    process.on('exit', () => {
      try {
        process.stdin.removeListener('keypress', onWatchKey)
        process.stdin.setRawMode(false)
      } catch {
        /* best-effort */
      }
    })
  }

  // Start idle → paused, so keystrokes typed before the first read (or while
  // output streams between reads) aren't echoed into the transcript.
  rl.pause()
  // Once stdin ends (Ctrl-D at an empty read, a closed pipe, a dropped terminal)
  // the interface is dead: it settles the outstanding read with EOF and, via this
  // flag, makes every subsequent readLine resolve null immediately. Calling
  // rl.question on a closed interface throws ERR_USE_AFTER_CLOSE, which would
  // otherwise crash the next composer read after an in-run Ctrl-D.
  let closed = false
  rl.on('close', () => {
    closed = true
    settle(null)
  })

  return {
    out,
    // Erase the current terminal line (e.g. the composer's typed-but-abandoned input
    // on Ctrl-C) so the next prompt redraws clean.
    clearLine: () => rawWrite(CLEAR_LINE),
    readLine: (prompt, opts) =>
      new Promise<string | null>((resolve) => {
        if (closed) {
          resolve(null) // interface already ended — no more reads possible
          return
        }
        pending = resolve
        // A per-read AbortController so cancelRead / EOF can cancel this exact
        // question (see `settle`), leaving no dangling callback for the next read.
        const ac = new AbortController()
        questionAbort = ac
        // Pause the spinner while a prompt is on screen so it can't repaint over it,
        // and hand stdin from the streaming Ctrl-C watcher to readline (which now owns
        // input, including its own Ctrl-C via the 'SIGINT' event).
        stopTimer(true)
        stopInterruptWatch()
        // Drop type-ahead before a security-sensitive prompt so a stray buffered
        // 'y' can't answer an approval the user never actually saw.
        if (opts?.discardPending) drainInput()
        rl.resume()
        rl.question(prompt, { signal: ac.signal }, (answer) => {
          questionAbort = null
          rl.pause() // back to idle: stop echoing until the next read
          pending = null
          startTimer() // resume the spinner if the turn is still running
          if (spinnerLabel !== null) startInterruptWatch() // …and re-arm Ctrl-C
          resolve(answer)
        })
      }),
    onInterrupt: (handler) => {
      // Debounce: a single Ctrl-C can surface via more than one path (the streaming
      // watcher vs. readline's own 'SIGINT'); collapse those near-simultaneous fires
      // so the run is cancelled — and the notice printed — exactly once. Kept small
      // (50ms) so a deliberate double-tap (Ctrl-C twice to exit the composer) still
      // registers as two.
      let last = -Infinity
      const fire = (): void => {
        const t = now()
        if (t - last < 50) return
        last = t
        handler()
      }
      // The streaming watcher (raw keypress) uses this while a turn runs and no
      // prompt is up; readline's 'SIGINT' covers a Ctrl-C typed at a cooked read
      // (and keeps readline's default close-on-Ctrl-C from ending the session).
      interruptHandler = fire
      rl.on('SIGINT', fire)
    },
    cancelRead: () => {
      settle(null)
      rl.pause()
    },
    startSpinner: (label) => {
      spinnerLabel = label
      spinnerStart = now()
      tick = 0
      startTimer()
      // A turn is now running with no prompt up — watch for Ctrl-C so it can be
      // interrupted while it streams.
      startInterruptWatch()
    },
    setSpinnerLabel: (label) => {
      if (spinnerLabel !== null) spinnerLabel = label
    },
    stopSpinner: () => {
      spinnerLabel = null
      stopTimer(true)
      stopInterruptWatch()
    },
    select: async (spec) => {
      // Stop the spinner while the picker owns the screen (mirrors readLine): its
      // 100ms redraw would otherwise paint frames into the picker's multi-line
      // region and fight its cursor-up redraw, tearing it. The picker also owns
      // stdin (its own raw keypress + Ctrl-C cancel), so release the watcher first.
      stopTimer(true)
      stopInterruptWatch()
      try {
        return await runPicker(spec, rl, rawWrite, paint)
      } finally {
        startTimer() // resume the spinner if a turn is still running
        if (spinnerLabel !== null) startInterruptWatch() // …and re-arm Ctrl-C
      }
    }
  }
}

/**
 * Run an arrow-key picker in transient raw mode, then restore the readline state.
 * Bounded strictly to this call — raw mode is entered and exited here, never held
 * across streaming output. Redraws only the picker's own N-line region
 * (cursor-up + erase-to-end + reprint, erase-before-write) so it stays tear-free.
 *
 * MANUAL-VERIFY: the raw-mode / keypress plumbing can't run in CI (no TTY). The
 * pure model + view + key mapping are unit-tested (tui-picker.test.ts); this
 * adapter is the thin, defensively-guarded binding to stdin. Any failure resolves
 * to `type`/`cancel`, so the driver falls back to the tested typed prompt (and an
 * approval cancel is a safe deny).
 */
function runPicker(
  spec: PickerSpec,
  rl: ReadlineLike,
  write: (s: string) => void,
  paint: Painter
): Promise<PickerOutcome> {
  const stdin = process.stdin
  // No real terminal, or no raw mode available → let the driver use the typed path.
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return Promise.resolve({ kind: 'type' })

  return new Promise<PickerOutcome>((resolve) => {
    let state = initialPickerState(spec)
    let prevCount = 0
    let done = false

    const draw = (first: boolean): void => {
      if (!first && prevCount > 0) write(`\x1b[${prevCount}A\x1b[0J`) // up N lines, erase to end
      const lines = renderPicker(state, paint)
      prevCount = lines.length
      write(`${lines.join('\n')}\n`)
    }
    const finish = (outcome: PickerOutcome): void => {
      if (done) return
      done = true
      try {
        stdin.removeListener('keypress', onKey)
        stdin.setRawMode(false)
        rl.resume() // hand input back to readline for the next read
        rl.pause()
      } catch {
        /* best-effort restore */
      }
      resolve(outcome)
    }
    const onKey = (_str: string, key: { name?: string; sequence?: string; ctrl?: boolean }): void => {
      try {
        const pk = keyToPickerKey(key ?? {})
        if (!pk) return
        const { state: next, outcome } = reducePicker(state, pk)
        state = next
        if (outcome) finish(outcome)
        else draw(false)
      } catch {
        // A redraw/write failure (e.g. a broken pipe) must not escape the keypress
        // handler as an uncaughtException with the listener still attached and raw
        // mode still on. Fall back to the typed prompt; finish() restores both.
        finish({ kind: 'type' })
      }
    }

    try {
      rl.pause()
      emitKeypressEvents(stdin)
      stdin.setRawMode(true)
      stdin.resume()
      stdin.on('keypress', onKey)
      draw(true)
    } catch {
      finish({ kind: 'type' })
    }
  })
}
