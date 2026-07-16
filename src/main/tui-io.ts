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
import {
  decodeInput,
  initialDecoderState,
  sanitizePastedKeys,
  ENABLE_BRACKETED_PASTE,
  DISABLE_BRACKETED_PASTE,
  type DecoderState
} from './tui-keys'
import {
  initialEditorState,
  reduceEditor,
  renderEditor,
  setEditorText,
  type EditorState
} from './tui-editor'

/** Carriage-return + erase-line: rewinds to column 0 and clears the current line. */
const CLEAR_LINE = '\r\x1b[2K'

/** Longest prefix shared by every candidate — how Tab completes an ambiguous token. */
function commonPrefix(items: string[]): string {
  if (!items.length) return ''
  let out = items[0]
  for (const it of items) {
    let i = 0
    while (i < out.length && i < it.length && out[i] === it[i]) i++
    out = out.slice(0, i)
  }
  return out
}

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
  /**
   * Live composer history (newest last), read fresh on each composer read so an
   * entry submitted this session is recallable on the next one.
   */
  history?: () => string[]
  /** Terminal width, for composer wrapping. Defaults to stdout.columns. */
  columns?: () => number
  /** Open the draft in $VISUAL/$EDITOR (Ctrl-X Ctrl-E); null when unavailable. */
  editText?: (initial: string) => Promise<string | null>
  /** Input stream. Defaults to process.stdin; a fake TTY in tests. */
  stdin?: NodeJS.ReadStream
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

export function createTerminalIo(deps: TerminalIoDeps = {}): TuiIo {
  // The input stream, injectable so the raw-mode readers (the composer, the
  // picker, readSecret) can be driven by a fake TTY in tests — they own raw mode
  // and key decoding, which is exactly the logic worth covering.
  const stdin = deps.stdin ?? process.stdin
  /** Best-effort discard of bytes already buffered on stdin (type-ahead). */
  const defaultDrain = (): void => {
    while (stdin.read() !== null) {
      /* discard whatever the user typed while output was streaming */
    }
  }
  const rl =
    deps.createInterface?.() ??
    (nodeCreateInterface({
      input: stdin,
      output: process.stdout,
      // Tab-complete slash commands + @-file mentions, and seed persisted history
      // (readline drives Up/Down navigation once the array is seeded, newest last).
      // Only the sub-prompt reads use this path now; the composer runs its own
      // raw-mode editor (readComposer), which owns history and completion itself.
      completer: deps.completer,
      history: deps.history ? [...deps.history()].reverse() : undefined
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
      stdin.removeListener('keypress', onWatchKey)
      stdin.pause()
    } catch {
      /* best-effort */
    }
  }
  // Safety net: however the process ends (clean exit, uncaught error, SIGTERM),
  // leave the terminal usable — drop the keypress listener, turn bracketed paste
  // back off, and restore cooked mode. Raw mode is on during every streaming turn
  // (the watcher) and every composer read, so a crash could otherwise leave the
  // user's shell in raw mode — pasting into it garbage — until they run `reset`.
  // Only for the process's real terminal: an injected (test) stream has no shell
  // to hand back, and registering a process-wide hook per instance would leak.
  if (stdin === process.stdin && stdin.isTTY && typeof stdin.setRawMode === 'function') {
    process.on('exit', () => {
      try {
        stdin.removeListener('keypress', onWatchKey)
        rawWrite(DISABLE_BRACKETED_PASTE)
        stdin.setRawMode(false)
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

  // A normal echoed line read. Extracted so `readSecret` can reuse it as its
  // off-TTY fallback (where masking isn't possible anyway).
  const plainRead = (prompt: string, opts?: { discardPending?: boolean }): Promise<string | null> =>
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
    })

  /**
   * Read a line WITHOUT echoing it — for pasting an API key (the `/login` flow).
   * Runs in transient raw mode (same discipline as the picker: entered and exited
   * here, never held across streaming output), masking each character as `•`.
   * Resolves the typed value, or null on Ctrl-C / a bare Ctrl-D. The secret is never
   * handed to readline, so it can't enter Up/Down history. Off-TTY (no raw mode) it
   * degrades to a visible `plainRead` — the interactive client always has a TTY, so
   * that path is only a defensive fallback.
   *
   * MANUAL-VERIFY: the raw-mode keypress plumbing can't run in CI (no TTY), exactly
   * like `runPicker`. The off-TTY fallback and the settle/close integration are
   * unit-tested (tui-io.test.ts); the masking + backspace behavior is verified by hand.
   */
  const readSecret = (prompt: string): Promise<string | null> => {
    if (closed) return Promise.resolve(null)
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return plainRead(prompt)
    return new Promise<string | null>((resolve) => {
      // Hand stdin from the streaming Ctrl-C watcher / spinner to this reader, and
      // drop any type-ahead so buffered bytes can't seed the secret.
      stopTimer(true)
      stopInterruptWatch()
      drainInput()
      rl.pause()
      let buf = ''
      let done = false
      // CRITICAL for secrecy: readline keeps its own 'keypress' listener on stdin and
      // SOFTWARE-echoes every typed character to the output — even in raw mode, which
      // only stops the *terminal* driver's echo, not readline's. Left attached, each
      // keystroke would print the real character next to our mask (`b•2•4•…`), leaking
      // the key. Detach every current keypress listener for the duration (the spinner
      // watcher's was already removed by stopInterruptWatch above, so this is
      // readline's) and restore them in finish so the next read still works.
      const priorKeypress = stdin.listeners('keypress') as Array<(...args: unknown[]) => void>
      for (const l of priorKeypress) stdin.removeListener('keypress', l)
      rawWrite(prompt)
      const finish = (value: string | null): void => {
        if (done) return
        done = true
        // Release the close/cancel hook we registered below (whether we got here via a
        // keypress or via settle itself), so a later close can't double-fire.
        pending = null
        try {
          stdin.removeListener('keypress', onKey)
          for (const l of priorKeypress) stdin.on('keypress', l) // restore readline's echo/edit
          stdin.setRawMode(false)
          rl.resume() // re-sync readline for the next read (mirrors the picker)
          rl.pause()
        } catch {
          /* best-effort restore */
        }
        rawWrite('\n') // raw mode swallowed the Enter, so terminate the line ourselves
        startTimer()
        if (spinnerLabel !== null) startInterruptWatch()
        resolve(value)
      }
      // Register with the same settle mechanism readLine uses, so an interface
      // `close` (EOF / dropped terminal / closed pipe) or a `cancelRead` resolves this
      // hidden prompt to null instead of hanging the loop. settle() calls this with
      // null; a real submit goes through finish() from the keypress handler first.
      pending = finish
      const onKey = (
        str: string,
        key: { name?: string; ctrl?: boolean } | undefined
      ): void => {
        const k = key ?? {}
        if (k.ctrl && k.name === 'c') return finish(null) // cancel
        if (k.ctrl && k.name === 'd') return finish(buf.length ? buf : null) // EOF: submit or cancel
        if (k.name === 'return' || k.name === 'enter') return finish(buf)
        if (k.name === 'backspace' || k.name === 'delete') {
          if (buf.length) {
            buf = buf.slice(0, -1)
            rawWrite('\b \b')
          }
          return
        }
        // Accept printable characters only (a paste may arrive as a multi-char burst);
        // ignore control/navigation keys so arrows and the like don't corrupt the key.
        if (!k.ctrl && typeof str === 'string' && str.length) {
          const printable = [...str].filter((c) => c >= ' ' && c !== '\x7f')
          if (printable.length) {
            buf += printable.join('')
            rawWrite('•'.repeat(printable.length))
          }
        }
      }
      try {
        emitKeypressEvents(stdin)
        stdin.setRawMode(true)
        stdin.resume()
        stdin.on('keypress', onKey)
      } catch {
        finish(null) // raw mode unavailable — treat as cancel (TTY is guaranteed in practice)
      }
    })
  }

  /**
   * The composer read: a raw-mode line editor (tui-editor.ts) instead of readline.
   *
   * This exists for bracketed paste. readline decides where a line ends, and that
   * decision silently destroyed multi-line pastes: the first line submitted as a
   * turn and the rest was replayed as further input. Owning raw mode lets the
   * paste markers (DEC 2004) mark a block as pasted, so it lands whole and
   * editable. Owning the buffer also buys multi-line editing, Ctrl-R search over
   * persisted history, and an $EDITOR hand-off, none of which readline could do
   * over a driver that streams output between reads.
   *
   * Discipline matches the picker: raw mode is entered and exited HERE, never held
   * across streaming output, and the redraw is bounded to the composer's own rows
   * (cursor-up + erase-to-end) — never a full-screen clear. Any failure resolves
   * through the readline fallback, so the composer can't become unusable.
   *
   * Unlike the picker, this is covered end to end in CI: `deps.stdin` takes a fake
   * TTY, so tui-io.test.ts drives the real decoder, editor, and redraw over a
   * PassThrough (data loss on paste is too costly a regression to leave to a
   * manual check). The decoder (tui-keys.ts) and editor (tui-editor.ts) are pure
   * and separately unit-tested.
   */
  const readComposer = (prompt: string): Promise<string | null> => {
    if (closed) return Promise.resolve(null)
    // No TTY / no raw mode → the readline path still works (tests, pipes).
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return plainRead(prompt)

    return new Promise<string | null>((resolve) => {
      stopTimer(true)
      stopInterruptWatch()
      rl.pause()

      let state: EditorState = initialEditorState(deps.history?.() ?? [])
      let dec: DecoderState = initialDecoderState()
      // When paste bytes last arrived, so keys riding in on their tail can be
      // treated as clipboard content rather than keystrokes (see sanitizePastedKeys).
      let lastPasteAt = -Infinity
      let done = false
      let drawn = false
      let prevCursorRow = 0
      // Reserve the last column: writing exactly `columns` cells makes some
      // terminals wrap and insert a phantom row, which would desync the redraw.
      const width = (): number =>
        Math.max(8, (deps.columns?.() ?? process.stdout.columns ?? 80) - 1)
      const view = (): ReturnType<typeof renderEditor> =>
        renderEditor(state, { prompt, width: width(), paint, continuation: paint('… ', 'dim') })

      // readline software-echoes every keystroke off its own 'keypress' listener,
      // even in raw mode. Detach for the duration (exactly as readSecret does) and
      // restore on the way out, or every character would print twice.
      const priorKeypress = stdin.listeners('keypress') as Array<(...args: unknown[]) => void>

      const eraseRegion = (): void => {
        if (!drawn) return
        let s = ''
        if (prevCursorRow > 0) s += `\x1b[${prevCursorRow}A`
        s += '\r\x1b[0J'
        rawWrite(s)
        drawn = false
        prevCursorRow = 0
      }
      const draw = (): void => {
        const v = view()
        let s = ''
        if (drawn) {
          if (prevCursorRow > 0) s += `\x1b[${prevCursorRow}A`
          s += '\r\x1b[0J'
        }
        s += v.rows.join('\n')
        const up = v.rows.length - 1 - v.cursorRow
        if (up > 0) s += `\x1b[${up}A`
        s += '\r'
        if (v.cursorCol > 0) s += `\x1b[${v.cursorCol}C`
        rawWrite(s)
        drawn = true
        prevCursorRow = v.cursorRow
      }
      const teardown = (): void => {
        try {
          stdin.removeListener('data', onData)
          rawWrite(DISABLE_BRACKETED_PASTE)
          for (const l of priorKeypress) stdin.on('keypress', l)
          stdin.setRawMode(false)
          rl.resume() // re-sync readline for the next (sub-prompt) read
          rl.pause()
        } catch {
          /* best-effort restore */
        }
      }
      const setup = (): void => {
        emitKeypressEvents(stdin)
        for (const l of priorKeypress) stdin.removeListener('keypress', l)
        stdin.setRawMode(true)
        stdin.resume()
        rawWrite(ENABLE_BRACKETED_PASTE)
        stdin.on('data', onData)
      }
      const finish = (value: string | null, echo = false): void => {
        if (done) return
        done = true
        pending = null
        eraseRegion()
        // Leave the submitted message in the scrollback, exactly as readline did.
        if (echo && value !== null) {
          const v = view()
          rawWrite(`${v.rows.join('\n')}\n`)
        }
        teardown()
        startTimer()
        if (spinnerLabel !== null) startInterruptWatch()
        resolve(value)
      }
      // Register with the same settle mechanism readLine uses, so an interface
      // close (EOF / dropped terminal) or a cancelRead resolves this read.
      pending = (line) => finish(line)

      /** Tab: ask the injected completer about the token under the cursor. */
      const runComplete = async (): Promise<void> => {
        const completer = deps.completer
        if (!completer) return void draw()
        const line = [...(state.lines[state.row] ?? '')].slice(0, state.col).join('')
        const [hits, sub] = await new Promise<[string[], string]>((res) => {
          try {
            completer(line, (_e, result) => res(result))
          } catch {
            res([[], line])
          }
        })
        if (done) return
        if (!hits.length) return void draw()
        const insert = hits.length === 1 ? hits[0] : commonPrefix(hits)
        if (insert.length > sub.length) {
          // Replace the completed token with the (longer) completion.
          const back = [...sub].length
          let next = state
          for (let i = 0; i < back; i++) next = reduceEditor(next, { type: 'backspace' }).state
          state = reduceEditor(next, { type: 'char', value: insert }).state
        } else if (hits.length > 1) {
          // Ambiguous and nothing more to insert: show the candidates above the composer.
          eraseRegion()
          rawWrite(`${hits.map((h) => h.trim()).join('  ')}\n`)
        }
        draw()
      }

      /**
       * Ctrl-X Ctrl-E: hand the draft to $EDITOR, which owns the terminal while
       * open. Owns its own teardown/setup pair (and therefore the 'data' listener),
       * so the caller must NOT re-add the listener afterwards — doing both
       * registered it twice, doubling every later keystroke and feeding the shared
       * decoder each chunk twice (which corrupts a chunk-split paste).
       */
      const runExternalEdit = async (text: string): Promise<void> => {
        if (!deps.editText) return void draw()
        eraseRegion()
        teardown()
        let edited: string | null
        try {
          edited = await deps.editText(text)
        } catch {
          edited = null
        }
        if (done) return
        setup()
        if (edited !== null) state = setEditorText(state, edited.replace(/\n$/, ''))
        draw()
      }

      function onData(data: Buffer | string): void {
        const chunk = typeof data === 'string' ? data : data.toString('utf8')
        const r = decodeInput(chunk, dec)
        dec = r.state
        // A paste body is attacker-controlled and can end paste mode early with its
        // own ESC[201~; without this, the bytes it puts after that marker would run
        // as real keys (submitting the turn, quitting, spawning $EDITOR).
        const guarded = sanitizePastedKeys(r.keys, lastPasteAt, now())
        lastPasteAt = guarded.lastPasteAt
        for (const key of guarded.keys) {
          if (done) return
          const { state: next, outcome } = reduceEditor(state, key)
          state = next
          if (!outcome) {
            draw()
            continue
          }
          switch (outcome.kind) {
            case 'submit':
              finish(outcome.text, true)
              return
            case 'eof':
              finish(null)
              return
            case 'interrupt': {
              // Hand off to the shared interrupt handler (which owns the
              // discard-vs-exit double-tap), then resolve this read as cancelled.
              eraseRegion()
              done = true
              pending = null
              teardown()
              startTimer()
              if (spinnerLabel !== null) startInterruptWatch()
              interruptHandler?.()
              resolve(null)
              return
            }
            case 'clear-screen':
              rawWrite('\x1b[2J\x1b[H')
              drawn = false
              draw()
              break
            case 'complete':
              stdin.removeListener('data', onData)
              void runComplete().finally(() => {
                if (!done) stdin.on('data', onData)
              })
              return
            case 'external-edit':
              // runExternalEdit re-attaches the listener itself, via setup().
              void runExternalEdit(outcome.text)
              return
          }
        }
      }

      try {
        setup()
        draw()
      } catch {
        // Raw mode unavailable after all — fall back to the readline composer.
        teardown()
        done = true
        pending = null
        void plainRead(prompt).then(resolve)
      }
    })
  }

  return {
    out,
    // Erase the current terminal line (e.g. the composer's typed-but-abandoned input
    // on Ctrl-C) so the next prompt redraws clean.
    clearLine: () => rawWrite(CLEAR_LINE),
    readLine: plainRead,
    readComposer,
    readSecret,
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
        return await runPicker(spec, rl, rawWrite, paint, stdin)
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
  paint: Painter,
  stdin: NodeJS.ReadStream
): Promise<PickerOutcome> {
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
