import { createInterface as nodeCreateInterface, emitKeypressEvents } from 'node:readline'
import { StringDecoder } from 'node:string_decoder'
import { randomUUID } from 'node:crypto'
import { spinnerFrame, type TuiIo, type Painter, type ImagePasteRequest, type ImagePasteResult } from './tui'
import { filterTerminalOutput, stripAnsi, stripControlChars, truncateVisible, truncateVisibleStart, visibleWidth } from './tui-wrap'
import type { NotifySpec } from '@shared/notify'
import { findUltrathink, ultrathinkHint, type KeywordRange, type UltrathinkEffect } from '@shared/ultrathink'
import {
  createPickerSession,
  pickerKeyFor,
  renderNumberedPicker,
  parseNumberedPick,
  type PickerSpec,
  type PickerOutcome
} from './tui-picker'
import {
  decodeInput,
  initialDecoderState,
  sanitizePastedKeys,
  ENABLE_BRACKETED_PASTE,
  DISABLE_BRACKETED_PASTE,
  ENABLE_FOCUS_REPORTING,
  DISABLE_FOCUS_REPORTING,
  ENABLE_MODIFIED_KEYS,
  DISABLE_MODIFIED_KEYS,
  type DecoderState
} from './tui-keys'
import { alertSequence, IDLE_REMINDER_MS, titleSequence, type NotifyMode, type TerminalSignal } from './tui-notify'
import { REDUCED_MOTION_REFRESH_MS, STATIC_SPINNER_GLYPH, plainText } from './tui-a11y'
import {
  initialPagerState,
  maxTop,
  reducePager,
  renderPagerScreen,
  rewrapTop,
  type PagerSource,
  type PagerState,
  type TranscriptDoc
} from './tui-pager'
import {
  initialEditorState,
  reduceEditor,
  renderEditor,
  setEditorText,
  editorEmpty,
  editorText,
  parseImagePaths,
  type DraftSnapshot,
  type EditorState,
  type EditorOutcome
} from './tui-editor'
import type { EditorKey } from './tui-keys'
import { midRunRows, oneLine, waitingAnnouncement, type WaitingInput } from './tui-midrun'
import {
  initialVimState,
  reduceVim,
  vimStatus,
  CURSOR_BAR,
  CURSOR_BLOCK,
  CURSOR_RESET,
  type VimState
} from './tui-vim'

/** Carriage-return + erase-line: rewinds to column 0 and clears the current line. */
const CLEAR_LINE = '\r\x1b[2K'

/**
 * Synchronized output (DEC private mode 2026): a terminal that supports it holds
 * everything between these two and paints it at once, so a multi-row repaint never
 * shows half drawn. Terminals without it ignore both.
 */
export const SYNC_BEGIN = '\x1b[?2026h'
export const SYNC_END = '\x1b[?2026l'

/** The alternate screen (DEC 1049): the transcript viewer draws there, leaving the scrollback alone. */
const ALT_SCREEN_ON = '\x1b[?1049h'
const ALT_SCREEN_OFF = '\x1b[?1049l'
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'

/** Two Esc presses this close together are a double press (clear the draft, or rewind). */
export const DOUBLE_ESC_MS = 600

/** What Ctrl-Z says on Windows, which has no job control to hand the terminal back to. */
const NO_SUSPEND_NOTE = '· Ctrl-Z (suspend to the shell) is not available on Windows'

/**
 * Stop the process the way the terminal's own Ctrl-Z would, and call `onContinue`
 * once the shell resumes it (`fg`). The whole process group gets the signal, as it
 * does from the tty: a command Houston is running for the turn stops and resumes
 * with it.
 */
function defaultSuspend(onContinue: () => void): void {
  process.once('SIGCONT', onContinue)
  process.kill(0, 'SIGTSTP')
}

/** Whether writing `s` leaves the cursor at the start of a line (colour codes after the newline aside). */
const endsLine = (s: string): boolean => stripAnsi(s).endsWith('\n')

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
  /** Type text into the open question as if the user had (node:readline's `write`). */
  write?(data: string): void
}

export interface TerminalIoDeps {
  /** Build the readline interface. Defaults to node:readline over stdin/stdout. */
  createInterface?: () => ReadlineLike
  /** Write to the output stream. Defaults to process.stdout.write. */
  write?: (s: string) => void
  /** Discard buffered type-ahead before a sensitive read. Defaults to draining stdin. */
  drainInput?: () => void
  /**
   * Painter for what the adapter draws itself (the spinner, the picker, the composer's
   * marks and the menu under it), until the driver hands it the session's theme
   * through `setPaint`.
   */
  paint?: Painter
  /** Schedule a repeating tick; returns a canceller. Injectable for tests. */
  schedule?: (fn: () => void, ms: number) => () => void
  /** Schedule a one-shot callback; returns a canceller. Injectable for tests. */
  timeout?: (fn: () => void, ms: number) => () => void
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
  /**
   * Subscribe to terminal resizes; returns the unsubscribe. Defaults to stdout's
   * 'resize' event for the process's real terminal, and to none for an injected stream.
   */
  onResize?: (listener: () => void) => () => void
  /** Open the draft in $VISUAL/$EDITOR (Ctrl-X Ctrl-E); null when unavailable. */
  editText?: (initial: string) => Promise<string | null>
  /** Input stream. Defaults to process.stdin; a fake TTY in tests. */
  stdin?: NodeJS.ReadStream
  /**
   * Rows to show under the composer for the current line: the live command menu,
   * or the files matching an `@` mention. Called on every redraw, so it must be
   * cheap and synchronous; work that isn't (a file lookup) calls `redraw` when it
   * has rows to show. `paint` is the composer's current painter (the session's theme).
   */
  menuFor?: (line: string, redraw: () => void, paint: Painter) => string[]
  /**
   * Which key set the composer answers to, read fresh on each read so `/vim` takes
   * effect on the next prompt rather than the next launch. Absent = emacs.
   */
  editorMode?: () => 'emacs' | 'vim'
  /** Terminal height, for the transcript viewer and the picker's window. Defaults to stdout.rows. */
  rows?: () => number
  /**
   * Open text read-only in $VISUAL/$EDITOR (the viewer's `v`). Resolves false when
   * no editor is set. Absent = the key says it is unavailable.
   */
  viewText?: (text: string) => Promise<boolean>
  /**
   * Wrap in-place repaints in synchronized-output markers. Defaults to on for the
   * process's own terminal and off for an injected `write` (or a stdout that is not
   * a TTY), where there is no screen to paint atomically.
   */
  syncOutput?: boolean

  /**
   * Save a draft that left the composer unsent (Ctrl-C, Esc Esc, a displaced Ctrl-S
   * stash) to history, so Up brings it back. Absent = in-read history only.
   */
  remember?: (text: string) => void
  /** The host platform; Ctrl-Z is a note on Windows. Defaults to process.platform. */
  platform?: NodeJS.Platform
  /**
   * Suspend the process to the shell and call `onContinue` when it is resumed.
   * Injectable for tests; defaults to raising SIGTSTP and waiting for SIGCONT.
   */
  suspendProcess?: (onContinue: () => void) => void
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

/** Per-read options for the composer. */
export interface ComposerReadOptions {
  /**
   * What the `ultrathink` keyword would do to a turn sent now (see ultrathinkEffect).
   * A thunk, read on each redraw. Absent reads as raising the turn.
   */
  ultrathinkEffect?: () => UltrathinkEffect
  /** Told the draft's text after each edit, so it can be saved for this chat. */
  onDraft?: (text: string) => void
}

/**
 * Ranges over the whole draft (lines joined by a newline) as per-line ranges, for the
 * editor to colour. A range never spans lines, since the keyword holds no newline.
 */
export function marksByLine(lines: readonly string[], ranges: readonly KeywordRange[]): KeywordRange[][] {
  const out: KeywordRange[][] = lines.map(() => [])
  let offset = 0
  lines.forEach((line, i) => {
    for (const r of ranges) {
      if (r.start >= offset && r.end <= offset + line.length) {
        out[i].push({ start: r.start - offset, end: r.end - offset })
      }
    }
    offset += line.length + 1
  })
  return out
}

/**
 * How many physical rows the cursor sits below the top of a drawn composer once the
 * terminal is `columns` wide. The composer draws each row to fit the width it had;
 * a narrower terminal rewraps every longer row onto several, so the logical row
 * count the redraw climbs would leave the top of the old draw on screen.
 */
export function physicalCursorRow(
  rows: readonly string[],
  cursorRow: number,
  cursorCol: number,
  columns: number
): number {
  const cols = Math.max(1, columns)
  return pickerPhysicalRows(rows.slice(0, cursorRow), cols) + Math.floor(cursorCol / cols)
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
  // Synchronized output for in-place repaints (see SYNC_BEGIN). Each repaint is
  // built as one string and written once, so its begin and end can never come apart;
  // `atomically` covers the few that take several writes, closing in a finally.
  const syncOn = deps.syncOutput ?? (!deps.write && process.stdout.isTTY === true)
  let syncDepth = 0
  const atomically = (fn: () => void): void => {
    if (!syncOn) return fn()
    if (syncDepth++ === 0) rawWrite(SYNC_BEGIN)
    try {
      fn()
    } finally {
      if (--syncDepth === 0) rawWrite(SYNC_END)
    }
  }
  /** One in-place repaint, painted at once where the terminal supports it. */
  const repaint = (s: string): void => {
    if (!s) return
    if (syncOn && syncDepth === 0) rawWrite(SYNC_BEGIN + s + SYNC_END)
    else rawWrite(s)
  }
  // Resizes only matter on the process's real terminal: an injected (test) stream
  // has no window, and a process-wide listener per instance would leak.
  const onResize =
    deps.onResize ??
    (stdin === process.stdin && process.stdout.isTTY
      ? (listener: () => void): (() => void) => {
          process.stdout.on('resize', listener)
          return () => void process.stdout.off('resize', listener)
        }
      : undefined)
  const drainInput = deps.drainInput ?? defaultDrain
  const platform = deps.platform ?? process.platform
  const suspendProcess = deps.suspendProcess ?? defaultSuspend
  // Replaced by setPaint once the driver knows the session's theme, and on /theme.
  let paint: Painter = deps.paint ?? ((s: string) => s)
  const columnsNow = (): number => deps.columns?.() ?? process.stdout.columns ?? 80
  const now = deps.now ?? Date.now
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number): (() => void) => {
      const id = setInterval(fn, ms)
      return () => clearInterval(id)
    })

  // --- Focus: whether the user is actually looking at this terminal.
  //
  // `sawFocusEvent` is the honest part. A terminal that doesn't implement mode
  // 1004 simply never reports, and we must not read that silence as "focused" —
  // that would silently disable every attention signal on those terminals. Until
  // one arrives we don't know, and an unknown gets the signal.
  let focused = true
  let sawFocusEvent = false
  // Unknown counts as away: a terminal that never reports would otherwise silence
  // every signal, which is the failure we set out to fix. Once the terminal does
  // report, its answer is authoritative.
  const userIsAway = (): boolean => !sawFocusEvent || !focused
  const noteFocus = (on: boolean): void => {
    sawFocusEvent = true
    focused = on
    // Back at the window: whatever we would have reminded them of is in front of them.
    if (on) disarmReminder()
  }
  const timeout =
    deps.timeout ??
    ((fn: () => void, ms: number): (() => void) => {
      const id = setTimeout(fn, ms)
      // A pending reminder must never be what keeps the process alive.
      id.unref?.()
      return () => clearTimeout(id)
    })

  // --- Idle reminder: a turn finished while the user was away, and they still have
  // not come back. One more nudge, once, after IDLE_REMINDER_MS; any keystroke or a
  // focus-in cancels it. Focus reporting stays on while it is armed, so coming back
  // to the window can cancel it even at an idle composer.
  let cancelReminder: (() => void) | null = null
  const reminderReportsFocus = (): boolean => stdin.isTTY === true
  function disarmReminder(): void {
    if (!cancelReminder) return
    cancelReminder()
    cancelReminder = null
    // The streaming watcher owns focus reporting while a turn runs.
    if (reminderReportsFocus() && !watching) rawWrite(DISABLE_FOCUS_REPORTING)
  }
  const armReminder = (spec: NotifySpec, mode: NotifyMode, ms: number): void => {
    disarmReminder()
    if (mode === 'off' || !userIsAway()) return
    if (reminderReportsFocus() && !watching) rawWrite(ENABLE_FOCUS_REPORTING)
    const cancel = timeout(() => {
      if (cancelReminder !== cancel) return
      if (userIsAway()) rawWrite(alertSequence(spec, mode))
      disarmReminder()
    }, ms)
    cancelReminder = cancel
  }

  let pending: ((line: string | null) => void) | null = null
  /** The open raw-mode composer, while one is: whether nothing is typed, and how to close it. */
  let openComposer: { empty: () => boolean; close: () => void } | null = null
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

  // The transcript viewer is on the alternate screen: output waits for it to close.
  let pagerOpen = false
  let heldOutput: string[] = []

  // --- Spinner: a single redrawn line, erased before any real output. This is the
  // ONLY in-place redraw in the TUI; confining it to one line + erase-before-write
  // keeps the transcript tear-free.
  let spinnerLabel: string | null = null
  let spinnerStart = 0
  let tick = 0
  let cancelTimer: (() => void) | null = null
  // Reduced motion: a still mark instead of the frames, and the timer refreshed every
  // few seconds rather than ten times a second. Set by the driver (setAccessibility).
  let reduceMotion = false
  // Screen-reader mode: nothing is ever redrawn in place. The spinner never draws (its
  // label changes are printed once, as lines), reads use the append-only line reader
  // below, pickers are numbered lists, and every write goes through plainText.
  let screenReader = false
  // The last status line printed in screen-reader mode, so a repeat says nothing.
  let announced: string | null = null
  const announce = (s: string): void => {
    rawWrite(`${plainText(s)}\n`)
  }
  const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1)
  // Whether the cursor sits after output that did not end its line. The spinner
  // erases the line it is on before every frame and every write, so it must never
  // share a line with real output: a half-written line was wiped by the next frame.
  let midLine = false
  /**
   * Output from outside the prompt on screen (a background session's notice, which
   * lands whenever that session ends), printed above the prompt, which is drawn
   * again under it. Set while the composer or a picker is open. Written into the
   * prompt's redraw region instead, it tore the region: the half-typed message
   * stayed above the notice looking sent.
   */
  let printAbove: ((s: string) => void) | null = null
  // Rows drawn under the spinner line (the waiting messages and a key hint). The
  // cursor stays on the spinner line, so erasing the whole region is one clear to
  // the end of the screen from there.
  let regionRows = 0
  const eraseRegionSeq = (): string => {
    const s = regionRows ? `${CLEAR_LINE}\x1b[J` : CLEAR_LINE
    regionRows = 0
    return s
  }
  const drawSpinner = (): void => {
    if (spinnerLabel === null || screenReader) return
    const frame = (status: string, shownDraft: string): string =>
      spinnerFrame(tick, spinnerLabel ?? '', Math.floor((now() - spinnerStart) / 1000), paint, {
        ...(reduceMotion ? { glyph: STATIC_SPINNER_GLYPH } : {}),
        ...(modeLabel ? { mode: modeLabel } : {}),
        ...(status ? { status } : {}),
        ...(shownDraft ? { draft: shownDraft } : {}),
        ...(waiting.length ? { queued: waiting.length } : {})
      })
    // A wrapped spinner line can't be erased in place: every frame would leave the
    // row above it behind. The status is the first thing to go when the line is full,
    // since the draft matters more; then the start of the draft, since its end is
    // where the user is typing. The draft is one row however many lines it has: its
    // line breaks show as a mark.
    const width = columnsNow() - 1
    const flat = oneLine(draft)
    let line = frame(statusLabel, flat)
    if (statusLabel && visibleWidth(line) > width) line = frame('', flat)
    if (flat && visibleWidth(line) > width) {
      // The draft shows after "  › ", four columns.
      const room = width - visibleWidth(frame('', '')) - 4
      line = frame('', room > 1 ? truncateVisibleStart(flat, room) : '')
    }
    if (visibleWidth(line) > width) line = truncateVisible(line, width)
    tick++
    // The transcript viewer owns the screen while it is open.
    if (pagerOpen) return
    // Below a half-written line, not over it.
    let s = `${midLine ? '\n' : ''}${eraseRegionSeq()}${line}`
    const rows = midRunRows(waiting, { width, paint, typing: draft.length > 0 })
    if (rows.length) {
      s += `\n${rows.join('\n')}\x1b[${rows.length}A\r`
      const col = visibleWidth(line)
      if (col > 0) s += `\x1b[${col}C`
      regionRows = rows.length
    }
    repaint(s)
    midLine = false
  }
  const startTimer = (): void => {
    if (screenReader) return
    if (!cancelTimer && spinnerLabel !== null) {
      cancelTimer = schedule(drawSpinner, reduceMotion ? REDUCED_MOTION_REFRESH_MS : 100)
      // At the slow pace the first tick is seconds away: draw the line now.
      if (reduceMotion) drawSpinner()
    }
  }
  const stopTimer = (erase: boolean): void => {
    if (cancelTimer) {
      cancelTimer()
      cancelTimer = null
    }
    // Erase the spinner's line (and the rows under it), never a half-written line of
    // output, and nothing while the transcript viewer has the screen or in
    // screen-reader mode (no redraws there).
    if (erase && !pagerOpen && !screenReader && !midLine) rawWrite(eraseRegionSeq())
  }
  /** Start a prompt at the left edge: below a half-written line rather than on it. */
  const toFreshLine = (): void => {
    if (midLine && !pagerOpen && !screenReader) rawWrite('\n')
    midLine = false
  }
  const out = (s: string): void => {
    // Nothing to print: leave the spinner alone. The streaming renderer holds a block
    // until it is complete, so most text deltas arrive here empty, and erasing the
    // spinner for each one left it blank for most of a long answer.
    if (!s) return
    const safe = filterTerminalOutput(s)
    // The transcript viewer owns the screen: hold the output and print it, in order,
    // once the viewer closes, so nothing lands on the alternate screen and is lost.
    // Checked first: an open prompt sits under the viewer, off screen, until then.
    if (pagerOpen) {
      heldOutput.push(safe)
      return
    }
    // Screen-reader mode redraws nothing in place: every write is a plain append, even
    // with a prompt open (whose reads there are append-only lines too).
    if (screenReader) {
      const plain = plainText(safe)
      if (plain) rawWrite(plain)
      return
    }
    if (printAbove) return printAbove(safe)
    // Clear the spinner line before real output so streamed text never lands on a
    // spinner frame; the timer redraws it on the next tick, on the fresh line.
    // Everything the TUI prints comes through here, much of it text Houston didn't
    // write. The filter keeps Houston's own colours and links and shows any other
    // control character, so no string can repaint the lines above, write the
    // clipboard or query the terminal (see filterTerminalOutput).
    // A line still being written holds no spinner, and is continued instead.
    if (cancelTimer && !midLine) repaint(eraseRegionSeq() + safe)
    else rawWrite(safe)
    midLine = !endsLine(safe)
  }

  // --- Interrupt watch. While a turn streams, the interface is paused AND the
  // terminal is raw, so a Ctrl-C is neither a SIGINT (raw disables ISIG) nor a
  // delivered byte (paused stdin doesn't flow) — it just sits buffered, so the run
  // couldn't be interrupted. During that window we resume stdin under a minimal raw
  // keypress listener that acts ONLY on Ctrl-C and swallows everything else (no
  // echo, no type-ahead into the next prompt). readLine and the picker detach it
  // and handle their own Ctrl-C (readline's 'SIGINT' / the picker's cancel key), so
  // exactly one consumer owns stdin at a time — the same discipline the picker uses.
  // When paste bytes last arrived, so keys riding in on their tail are treated as
  // clipboard content rather than keystrokes (see sanitizePastedKeys). Shared by
  // the composer and the streaming watcher: it describes the byte stream, not
  // whichever reader currently owns it.
  let lastPasteAt = -Infinity
  // One UTF-8 decoder for the byte stream, shared by the composer and the streaming
  // watcher for the same reason: a multi-byte character can be split across two
  // reads, and decoding each chunk on its own turns both halves into U+FFFD.
  const utf8 = new StringDecoder('utf8')
  const decodeChunk = (data: Buffer | string): string => (typeof data === 'string' ? data : utf8.write(data))

  let interruptHandler: (() => void) | null = null
  // Ctrl-O and Alt-T, at the composer or mid-run. The driver decides what they mean
  // (and whether the viewer can open now); this reports the keypress.
  let transcriptHandler: ((during: 'composer' | 'run') => Promise<void>) | null = null
  let cycleThoughtsHandler: (() => void) | null = null
  // Ctrl-V / Alt-V and a pasted image path: the driver owns the staged images.
  let imagePasteHandler: ((req: ImagePasteRequest) => ImagePasteResult) | null = null
  // Esc Esc on an empty composer: the driver opens the rewind picker.
  let rewindHandler: (() => void) | null = null
  // The draft Ctrl-S put aside. Kept here, across reads, so a stash survives sending
  // something else first: that is what it is for.
  let composerStash: DraftSnapshot | null = null
  // Fired by Shift-Tab, at the composer or mid-run. The driver owns what the modes
  // ARE and what changing one means; this just reports the keypress.
  let cycleModeHandler: (() => void) | null = null
  /**
   * Hand a line typed mid-run to the live turn. Returns true when the turn took it;
   * false means there was nothing running to steer, and the line falls back to the
   * follow-up queue rather than being dropped.
   */
  let steerHandler: ((text: string, id: string) => boolean | 'handled') | null = null
  // Take a steer back from the live run before it lands (Up on an empty line).
  let unsteerHandler: ((id: string) => boolean) | null = null
  // Told whenever the mid-run draft or the waiting messages change, so the driver can
  // save them; `acked` when a message was just shown as queued or steered.
  let pendingInputHandler: ((p: { draft: string; queued: string[] }, acked: boolean) => void) | null = null
  // The approval mode, shown on the spinner line so it stays visible while a turn
  // runs — the one time it matters most and the composer's status line is gone.
  let modeLabel = ''
  // The rest of the status line, carried on the spinner line while a turn runs.
  let statusLabel = ''
  let watching = false
  // Messages typed while the agent works that have not reached the model: steers the
  // run holds for its next step, and follow-ups for after the turn. Kept here (not in
  // the driver) because the driver is blocked awaiting the run.
  let waiting: WaitingInput[] = []
  const pendingChanged = (acked: boolean): void => {
    pendingInputHandler?.({ draft, queued: waiting.map((w) => w.text) }, acked)
  }
  /** Add a message to the waiting list, say so, and save it before anything else. */
  const addWaiting = (item: WaitingInput): void => {
    waiting.push(item)
    pendingChanged(true)
    if (screenReader) announce(waitingAnnouncement(item, waiting.filter((w) => w.kind === 'queued').length))
  }
  /**
   * Up on an empty line: the newest waiting message comes back into the draft. A steer
   * is taken back from the run first; one the run already read stays where it is.
   */
  const takeBackLast = (): void => {
    const last = waiting.at(-1)
    if (!last) return
    if (last.kind === 'steer' && !(unsteerHandler?.(last.id) ?? false)) {
      if (screenReader) announce('that message already reached the turn')
      return
    }
    waiting = waiting.slice(0, -1)
    draft = last.text
    pendingChanged(true)
    if (screenReader) announce(`took back: ${last.text}`)
  }
  // What the user is typing right now, rendered on the spinner line.
  let draft = ''
  let watchDec: DecoderState = initialDecoderState()

  /**
   * Every byte that arrives while a turn streams.
   *
   * This used to act on Ctrl-C and DROP everything else, which meant a thought you
   * had while watching the agent work had to be held in your head until it
   * finished — or forced through an interrupt that threw the turn away. Now the
   * keystrokes accumulate into a draft on the spinner line, and Enter queues it for
   * the moment the turn ends.
   */
  const onWatchData = (data: Buffer | string): void => {
    const chunk = decodeChunk(data)
    const r = decodeInput(chunk, watchDec)
    watchDec = r.state
    if (r.keys.some((k) => k.type !== 'focus')) disarmReminder()
    // A paste here is as untrusted as one in the composer: its tail must not be
    // able to submit or fire actions.
    const g = sanitizePastedKeys(r.keys, lastPasteAt, now())
    lastPasteAt = g.lastPasteAt
    for (const key of g.keys) {
      switch (key.type) {
        case 'interrupt':
          return void interruptHandler?.()
        case 'escape':
          // Esc with something typed clears it; Esc on an empty line stops the run.
          // Both are "undo the thing in front of me", scaled to what is in front.
          if (draft) {
            draft = ''
            pendingChanged(false)
            if (screenReader) announce('cleared what you typed')
            drawSpinner()
            return
          }
          return void interruptHandler?.()
        case 'focus':
          noteFocus(key.on)
          break
        case 'cycle-mode':
          // Shift-Tab mid-run: the driver retargets the live run and calls setMode,
          // which redraws this line with the new mode.
          cycleModeHandler?.()
          break
        case 'transcript':
          void transcriptHandler?.('run')
          break
        case 'cycle-thoughts':
          cycleThoughtsHandler?.()
          break
        case 'suspend':
          // Ctrl-Z mid-run: hand the terminal back and stop. The run is not
          // cancelled; it carries on from where it was once `fg` resumes us.
          if (platform === 'win32') {
            if (screenReader) {
              announce(NO_SUSPEND_NOTE)
              break
            }
            atomically(() => {
              rawWrite(`${eraseRegionSeq()}${paint(NO_SUSPEND_NOTE, 'dim')}\n`)
              drawSpinner()
            })
            break
          }
          stopTimer(true)
          stopInterruptWatch()
          try {
            stdin.setRawMode(false)
          } catch {
            /* best-effort: the shell gets a cooked terminal back */
          }
          suspendProcess(() => {
            if (spinnerLabel === null || watching) return
            startInterruptWatch()
            startTimer()
            drawSpinner()
          })
          return
        case 'char':
          draft += key.value
          pendingChanged(false)
          drawSpinner()
          break
        case 'paste':
          // Line breaks are kept: a follow-up can be several lines, as at the composer.
          draft += key.value.replace(/\r\n?/g, '\n')
          pendingChanged(false)
          drawSpinner()
          break
        case 'newline':
          // Shift-Enter, Alt-Enter or Ctrl-J: a line break in the draft.
          draft += '\n'
          pendingChanged(false)
          drawSpinner()
          break
        case 'enter':
        case 'tab': {
          const line = draft.trim()
          draft = ''
          // Enter steers the turn that is running if it can still take the line; a
          // turn that has already finished cannot, and then this is a follow-up for
          // the next one. Tab queues it for after the turn without steering. Never
          // dropped either way.
          if (line) {
            const id = randomUUID()
            const took = key.type === 'enter' ? (steerHandler?.(line, id) ?? false) : false
            if (took === 'handled') pendingChanged(true)
            else addWaiting({ id, text: line, kind: took ? 'steer' : 'queued' })
          }
          drawSpinner()
          break
        }
        case 'up':
          if (draft) break
          takeBackLast()
          drawSpinner()
          break
        case 'backspace':
          draft = [...draft].slice(0, -1).join('')
          pendingChanged(false)
          drawSpinner()
          break
        case 'kill-to-start':
        case 'kill-line':
          draft = ''
          pendingChanged(false)
          drawSpinner()
          break
        default:
          break // cursor keys, history, completion: not meaningful on one line
      }
    }
  }
  const startInterruptWatch = (): void => {
    if (watching || !stdin.isTTY || typeof stdin.setRawMode !== 'function') return
    try {
      emitKeypressEvents(stdin)
      stdin.setRawMode(true)
      stdin.resume()
      // Ask the terminal to report focus while the turn runs — the window in which
      // the user is most likely to wander off, and the only time we ping them.
      rawWrite(ENABLE_FOCUS_REPORTING)
      // A paste lands whole (its line breaks kept, never sent line by line), and
      // Shift-Enter is told apart from Enter, as at the composer.
      rawWrite(ENABLE_BRACKETED_PASTE)
      rawWrite(ENABLE_MODIFIED_KEYS)
      stdin.on('data', onWatchData)
      watching = true
    } catch {
      /* no TTY / raw mode unavailable — Ctrl-C during streaming just won't fire */
    }
  }
  const stopInterruptWatch = (): void => {
    if (!watching) return
    watching = false
    try {
      // An armed idle reminder still wants focus reports (see armReminder).
      if (!cancelReminder) rawWrite(DISABLE_FOCUS_REPORTING)
      rawWrite(DISABLE_BRACKETED_PASTE)
      rawWrite(DISABLE_MODIFIED_KEYS)
      stdin.removeListener('data', onWatchData)
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
        stdin.removeListener('data', onWatchData)
        // Focus reporting MUST go off with us: left on, the user's shell receives
        // a CSI I / CSI O burst every time they switch windows — visible garbage
        // in a terminal we no longer own.
        rawWrite(DISABLE_FOCUS_REPORTING)
        rawWrite(DISABLE_BRACKETED_PASTE)
        rawWrite(DISABLE_MODIFIED_KEYS)
        // Leaving with the viewer open would strand the shell on the alternate screen.
        if (pagerOpen) rawWrite(SHOW_CURSOR + ALT_SCREEN_OFF)
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
  const plainRead = (prompt: string, opts?: { discardPending?: boolean; initial?: string }): Promise<string | null> =>
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
      toFreshLine()
      stopInterruptWatch()
      // Drop type-ahead before a security-sensitive prompt so a stray buffered
      // 'y' can't answer an approval the user never actually saw.
      if (opts?.discardPending) drainInput()
      // readline only turns raw mode on in its constructor, and every raw reader
      // (composer, picker, readSecret) turns it off on the way out. Without this the
      // question runs in cooked mode: the tty echoes each key on top of readline's
      // own echo, and Ctrl-C is a real SIGINT that kills the process instead of
      // reaching readline's 'SIGINT' event (and so the interrupt handler).
      if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
        try {
          stdin.setRawMode(true)
        } catch {
          /* best-effort: a cooked read still works, just with the double echo */
        }
      }
      rl.resume()
      // A prompt can carry a server's field label (an MCP elicitation), so it is
      // filtered like any other write.
      rl.question(filterTerminalOutput(prompt), { signal: ac.signal }, (answer) => {
        questionAbort = null
        rl.pause() // back to idle: stop echoing until the next read
        pending = null
        midLine = false // the answer's Enter ended the line
        startTimer() // resume the spinner if the turn is still running
        if (spinnerLabel !== null) startInterruptWatch() // …and re-arm Ctrl-C
        resolve(answer)
      })
      // The line opens with this already typed (a picker's key that began the answer).
      if (opts?.initial) rl.write?.(opts.initial)
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
      toFreshLine()
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
        midLine = false
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
        disarmReminder()
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
            // A screen reader would read each bullet aloud; an asterisk is quieter.
            rawWrite((screenReader ? '*' : '•').repeat(printable.length))
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
   * The screen-reader line reader: append-only, in raw mode with bracketed paste.
   *
   * Every read in screen-reader mode goes through here, the composer included. A
   * screen reader follows text as it is written, so a redraw (cursor up, erase,
   * reprint) reads as a burst of noise on every keystroke. Here a typed character is
   * echoed once, Backspace is `\b \b`, and anything that changes more than the end
   * of the line (history, Shift-Tab, Ctrl-U, a completion list) starts a new line
   * with the prompt and the text again. readline would do for single lines, but it
   * repaints the line on edits and has no bracketed paste, so a multi-line paste
   * would submit its first line. Off a TTY it falls back to plainRead.
   */
  const readLinear = (
    prompt: string | (() => string),
    opts: { composer?: boolean; discardPending?: boolean; initial?: string; onDraft?: (text: string) => void } = {}
  ): Promise<string | null> => {
    const promptNow = (): string => plainText(typeof prompt === 'string' ? prompt : prompt())
    if (closed) return Promise.resolve(null)
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return plainRead(promptNow(), opts)
    return new Promise<string | null>((resolve) => {
      stopTimer(false)
      stopInterruptWatch()
      if (opts.discardPending) drainInput()
      rl.pause()
      const composer = opts.composer === true
      const history = composer ? (deps.history?.() ?? []) : []
      let histIdx = history.length
      let buf = opts.initial ?? ''
      let dec: DecoderState = initialDecoderState()
      let done = false
      // When the last Esc came, so a second one inside DOUBLE_ESC_MS is Esc Esc.
      let lastEscAt = -Infinity
      const priorKeypress = stdin.listeners('keypress') as Array<(...args: unknown[]) => void>
      // The user's own text, echoed as lines: control characters never reach the
      // terminal (a paste can carry anything).
      const echo = (text: string): void => {
        rawWrite(text.split('\n').map(stripControlChars).join('\n'))
      }
      /** Start over on a new line: the prompt, then the text as it now stands. */
      const restate = (): void => {
        rawWrite(`\n${promptNow()}`)
        echo(buf)
      }
      const teardown = (): void => {
        try {
          stdin.removeListener('data', onData)
          rawWrite(DISABLE_BRACKETED_PASTE)
          if (composer) rawWrite(DISABLE_MODIFIED_KEYS)
          for (const l of priorKeypress) if (!stdin.listeners('keypress').includes(l)) stdin.on('keypress', l)
          stdin.setRawMode(false)
          rl.resume()
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
        if (composer) rawWrite(ENABLE_MODIFIED_KEYS)
        stdin.on('data', onData)
      }
      const finish = (value: string | null): void => {
        if (done) return
        done = true
        pending = null
        if (composer) openComposer = null
        teardown()
        startTimer()
        if (spinnerLabel !== null) startInterruptWatch()
        resolve(value)
      }
      pending = (line) => finish(line)
      if (composer) {
        openComposer = {
          empty: () => buf.length === 0,
          close: () => {
            rawWrite('\n')
            finish(null)
          }
        }
      }
      const complete = async (): Promise<void> => {
        const completer = deps.completer
        if (!completer) return
        const line = buf.slice(buf.lastIndexOf('\n') + 1)
        const [hits, sub] = await new Promise<[string[], string]>((res) => {
          try {
            completer(line, (_e, result) => res(result))
          } catch {
            res([[], line])
          }
        })
        if (done || !hits.length) return
        const insert = hits.length === 1 ? hits[0] : commonPrefix(hits)
        if (insert.length > sub.length && insert.startsWith(sub)) {
          const more = insert.slice(sub.length)
          buf += more
          echo(more)
        } else if (hits.length > 1) {
          rawWrite(`\n${plainText(`${hits.length} matches: ${hits.map((h) => h.trim()).join(', ')}`)}`)
          restate()
        }
      }
      const externalEdit = async (): Promise<void> => {
        if (!deps.editText) return
        teardown()
        let edited: string | null
        try {
          edited = await deps.editText(buf)
        } catch {
          edited = null
        }
        if (done) return
        setup()
        if (edited !== null) buf = edited.replace(/\n$/, '')
        restate()
      }
      const showTranscript = async (): Promise<void> => {
        teardown()
        rawWrite('\n')
        try {
          await transcriptHandler?.('composer')
        } catch {
          /* the driver reports its own failures */
        }
        if (done) return
        setup()
        rawWrite(promptNow())
        echo(buf)
      }
      /** Notes about the draft (an attached image, say), each a line, then the prompt again. */
      const noteLines = (lines: string[]): void => {
        rawWrite('\n')
        for (const l of lines) announce(l)
        rawWrite(promptNow())
        echo(buf)
      }
      /**
       * Ctrl-Z: hand the terminal back cooked and stop; on `fg`, take it again and
       * state the prompt with the draft on a fresh line (the shell printed its own).
       */
      const suspendLinear = (): void => {
        if (platform === 'win32') return noteLines([NO_SUSPEND_NOTE])
        rawWrite('\n')
        teardown()
        suspendProcess(() => {
          if (done) return
          try {
            setup()
          } catch {
            /* best-effort: the read still settles through close/cancel */
          }
          rawWrite(promptNow())
          echo(buf)
        })
      }
      function onData(data: Buffer | string): void {
        const r = decodeInput(decodeChunk(data), dec)
        dec = r.state
        if (r.keys.some((k) => k.type !== 'focus')) disarmReminder()
        // A paste body can end paste mode early with its own end marker; keys after it
        // must not submit or act (see sanitizePastedKeys).
        const guarded = sanitizePastedKeys(r.keys, lastPasteAt, now())
        lastPasteAt = guarded.lastPasteAt
        const before = buf
        try {
          handleKeys(guarded.keys)
        } finally {
          if (!done && buf !== before) opts.onDraft?.(buf)
        }
      }
      function handleKeys(keys: EditorKey[]): void {
        for (const key of keys) {
          if (done) return
          if (key.type !== 'escape' && key.type !== 'focus') lastEscAt = -Infinity
          switch (key.type) {
            case 'focus':
              noteFocus(key.on)
              break
            case 'char':
              buf += key.value
              echo(key.value)
              break
            case 'paste': {
              // A paste that is only image files attaches them, as in the full composer.
              if (composer && imagePasteHandler) {
                const paths = parseImagePaths(key.value, { windows: platform === 'win32' })
                const r = paths ? imagePasteHandler({ kind: 'files', paths }) : null
                if (r?.handled) {
                  noteLines(r.notes)
                  break
                }
              }
              // A sub-prompt answer is one line; only the composer keeps line breaks.
              const text = composer ? key.value.replace(/\r\n?/g, '\n') : key.value.replace(/\r\n|\r|\n/g, ' ')
              buf += text
              echo(text)
              break
            }
            case 'newline':
              if (composer) {
                buf += '\n'
                rawWrite('\n')
              }
              break
            case 'backspace': {
              const chars = [...buf]
              const last = chars.pop()
              if (last === undefined) break
              buf = chars.join('')
              // A deleted line break can't be taken back on screen without moving the
              // cursor up; the text is what counts, and the next restate shows it.
              if (last !== '\n') rawWrite('\b \b')
              break
            }
            case 'kill-line':
            case 'kill-to-start':
              if (buf) {
                buf = ''
                rawWrite('\n(cleared)')
                restate()
              }
              break
            case 'escape': {
              // Esc Esc: clear the draft (kept in history for Up), or on an empty
              // composer open /rewind. A lone Esc does nothing here.
              if (!composer) break
              const t = now()
              const double = t - lastEscAt < DOUBLE_ESC_MS
              lastEscAt = double ? -Infinity : t
              if (!double) break
              if (buf.trim()) {
                deps.remember?.(buf)
                buf = ''
                rawWrite('\n(cleared)')
                restate()
              } else if (rewindHandler) {
                rawWrite('\n')
                rewindHandler()
                finish(null)
                return
              }
              break
            }
            case 'paste-image':
              if (!composer) break
              noteLines(
                imagePasteHandler
                  ? imagePasteHandler({ kind: 'clipboard' }).notes
                  : ['· pasting images is unavailable here; use /image <path>']
              )
              break
            case 'suspend':
              if (!composer) break
              suspendLinear()
              return
            case 'up':
            case 'down':
              if (!composer || !history.length) break
              histIdx = key.type === 'up' ? Math.max(0, histIdx - 1) : Math.min(history.length, histIdx + 1)
              buf = history[histIdx] ?? ''
              restate()
              break
            case 'cycle-mode':
              if (!composer) break
              rawWrite('\n')
              cycleModeHandler?.()
              rawWrite(promptNow())
              echo(buf)
              break
            case 'tab':
              if (!composer) break
              stdin.removeListener('data', onData)
              void complete().finally(() => {
                if (!done) stdin.on('data', onData)
              })
              return
            case 'external-edit':
              if (!composer) break
              void externalEdit()
              return
            case 'transcript':
              // Ctrl-O: the driver prints the transcript as lines, then the prompt
              // is stated again under it with the draft as it was.
              if (!composer || !transcriptHandler) break
              void showTranscript()
              return
            case 'cycle-thoughts':
              if (!composer) break
              rawWrite('\n')
              cycleThoughtsHandler?.()
              rawWrite(promptNow())
              echo(buf)
              break
            case 'enter':
              rawWrite('\n')
              finish(buf)
              return
            case 'eof':
              if (buf) break
              rawWrite('\n')
              finish(null)
              return
            case 'interrupt':
              rawWrite('\n')
              // The discarded draft goes to history first, so Up brings it back.
              if (composer && buf.trim()) deps.remember?.(buf)
              // The shared handler owns what Ctrl-C means here (discard, exit, stop
              // the run); it settles this read through cancelRead, or we do.
              interruptHandler?.()
              finish(null)
              return
            default:
              // Cursor movement, Ctrl-R search, Ctrl-L repaint, undo/redo and the
              // Ctrl-S stash all need a redraw; in this mode the line is only ever
              // appended to.
              break
          }
        }
      }
      try {
        setup()
        rawWrite(promptNow())
        echo(buf)
      } catch {
        teardown()
        done = true
        pending = null
        if (composer) openComposer = null
        void plainRead(promptNow(), opts).then(resolve)
      }
    })
  }

  /** A picker as a numbered list, answered by typing the number (screen-reader mode). */
  const selectNumbered = async (spec: PickerSpec): Promise<PickerOutcome> => {
    rawWrite(`${plainText(renderNumberedPicker(spec).join('\n'))}\n`)
    for (;;) {
      const answer = await readLinear('Your choice: ', { discardPending: true })
      if (answer === null) return { kind: 'cancel' }
      const r = parseNumberedPick(spec, answer)
      if (r.kind !== 'invalid') return r
      announce(r.message)
    }
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
  const readComposer = (
    prompt: string | (() => string),
    initial?: string,
    opts?: ComposerReadOptions
  ): Promise<string | null> => {
    if (screenReader) {
      return readLinear(prompt, {
        composer: true,
        ...(initial ? { initial } : {}),
        ...(opts?.onDraft ? { onDraft: opts.onDraft } : {})
      })
    }
    const promptNow = (): string => (typeof prompt === 'string' ? prompt : prompt())
    if (closed) return Promise.resolve(null)
    // No TTY / no raw mode → the readline path still works (tests, pipes). It can't
    // be pre-filled; the driver has already shown any `initial` text above it.
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return plainRead(promptNow())

    return new Promise<string | null>((resolve) => {
      stopTimer(true)
      toFreshLine()
      stopInterruptWatch()
      rl.pause()

      let state: EditorState = initialEditorState(deps.history?.() ?? [], initial, composerStash)
      let dec: DecoderState = initialDecoderState()
      // Vim keys are decided per read, and a read always starts in insert: a fresh
      // prompt is for typing, and coming back to one in normal mode would swallow
      // the first word as commands.
      const vimOn = (deps.editorMode?.() ?? 'emacs') === 'vim'
      let vim: VimState = initialVimState()
      // The last Esc: when, and whether vim was already in normal mode for it (in
      // vim, only two presses both made in normal mode are a double press).
      let lastEsc = { at: -Infinity, normal: false }
      let done = false
      let drawn = false
      let prevCursorRow = 0
      // The last draw, for a resize to find its top again (see physicalCursorRow).
      let prevRows: string[] = []
      let prevCursorCol = 0
      let stopResize: (() => void) | null = null
      // Reserve the last column: writing exactly `columns` cells makes some
      // terminals wrap and insert a phantom row, which would desync the redraw.
      const width = (): number => Math.max(8, columnsNow() - 1)
      const view = (withMenu = true): ReturnType<typeof renderEditor> => {
        // The line under the cursor drives the menu: typing `/` shows what you can
        // run, without having to already know its name.
        const menu = withMenu ? (deps.menuFor?.(state.lines[state.row] ?? '', redrawMenu, paint) ?? []) : []
        // The `ultrathink` keyword in the draft: say what it will do to this turn, and
        // colour the word where it will raise the turn's reasoning. The hint only where
        // it fits on one row: a wrapped row would desync the redraw region.
        const uses = withMenu ? findUltrathink(state.lines.join('\n')) : []
        const effect = uses.length ? (opts?.ultrathinkEffect?.() ?? 'raises') : null
        const hint = effect ? ultrathinkHint(effect) : ''
        const belowRows = hint && hint.length <= width() ? [...menu, paint(hint, 'dim')] : [...menu]
        // A stashed draft on an empty composer: say how to get it back, or it is lost
        // to anyone who pressed Ctrl-S by accident.
        const stashHint = 'stashed draft: Ctrl-S brings it back'
        if (withMenu && state.stashed && editorEmpty(state) && stashHint.length <= width()) {
          belowRows.push(paint(stashHint, 'dim'))
        }
        // Every row under the composer is cut to the width: the
        // redraw moves up by rows as drawn, and a menu row that wrapped (a long command
        // description) left a stale copy of the prompt behind on each keystroke.
        const below = belowRows.map((r) => truncateVisible(r, width()))
        const marks = effect === 'raises' ? marksByLine(state.lines, uses) : undefined
        return renderEditor(state, {
          // The mode marker rides in front of the prompt, so which mode you are in
          // is answered where you are already looking.
          prompt: vimOn ? vimStatus(vim.mode, paint) + promptNow() : promptNow(),
          width: width(),
          paint,
          continuation: paint('… ', 'dim'),
          ...(below.length ? { below } : {}),
          ...(marks ? { marks } : {})
        })
      }

      // readline software-echoes every keystroke off its own 'keypress' listener,
      // even in raw mode. Detach for the duration (exactly as readSecret does) and
      // restore on the way out, or every character would print twice.
      const priorKeypress = stdin.listeners('keypress') as Array<(...args: unknown[]) => void>

      const eraseRegion = (): void => {
        if (!drawn) return
        let s = ''
        if (prevCursorRow > 0) s += `\x1b[${prevCursorRow}A`
        s += '\r\x1b[0J'
        repaint(s)
        drawn = false
        prevCursorRow = 0
      }
      // Output that arrived while $EDITOR had the screen, printed when the composer is back.
      let heldAbove = ''
      const flushHeld = (): void => {
        if (heldAbove) rawWrite(endsLine(heldAbove) ? heldAbove : `${heldAbove}\n`)
        heldAbove = ''
      }
      const showAbove = (s: string): void => {
        if (!drawn) {
          heldAbove += s
          return
        }
        atomically(() => {
          eraseRegion()
          rawWrite(endsLine(s) ? s : `${s}\n`)
          draw()
        })
      }
      const draw = (): void => {
        if (!drawn) flushHeld()
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
        repaint(s)
        drawn = true
        prevCursorRow = v.cursorRow
        prevRows = v.rows
        prevCursorCol = v.cursorCol
      }
      // The terminal changed width under the composer: it rewrapped the old draw, so
      // climb its physical rows (not its logical ones), clear, and draw it again at
      // the new width. Not while the region is off screen ($EDITOR) or the read is over.
      const onTerminalResize = (): void => {
        if (done || !drawn) return
        const cols = deps.columns?.() ?? process.stdout.columns ?? 80
        const up = physicalCursorRow(prevRows, prevCursorRow, prevCursorCol, cols)
        atomically(() => {
          rawWrite(`${up > 0 ? `\x1b[${up}A` : ''}\r\x1b[0J`)
          drawn = false
          prevCursorRow = 0
          draw()
        })
      }
      // A menu whose rows arrived late (an `@` file lookup): repaint, unless the read
      // is over or the region is not on screen (handed to $EDITOR).
      const redrawMenu = (): void => {
        if (!done && drawn) draw()
      }
      const teardown = (): void => {
        stopResize?.()
        stopResize = null
        try {
          stdin.removeListener('data', onData)
          // Hand the cursor back: a block cursor left behind outlives Houston and
          // shows up in the user's shell as a bug we caused.
          if (vimOn) rawWrite(CURSOR_RESET)
          rawWrite(DISABLE_BRACKETED_PASTE)
          rawWrite(DISABLE_MODIFIED_KEYS)
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
        // Shift-Enter for a new line, on terminals that can report it.
        rawWrite(ENABLE_MODIFIED_KEYS)
        stdin.on('data', onData)
        stopResize = onResize?.(onTerminalResize) ?? null
      }
      const finish = (value: string | null, echo = false): void => {
        if (done) return
        done = true
        composerStash = state.stashed
        pending = null
        openComposer = null
        printAbove = null
        atomically(() => {
          eraseRegion()
          flushHeld()
          // Leave the submitted message in the scrollback, exactly as readline did:
          // just the prompt and text, not the command menu that was open under it.
          if (echo && value !== null) {
            const v = view(false)
            rawWrite(`${v.rows.join('\n')}\n`)
          }
        })
        midLine = false
        teardown()
        startTimer()
        if (spinnerLabel !== null) startInterruptWatch()
        resolve(value)
      }
      // Register with the same settle mechanism readLine uses, so an interface
      // close (EOF / dropped terminal) or a cancelRead resolves this read.
      pending = (line) => finish(line)
      openComposer = {
        empty: () => state.lines.every((l) => l.length === 0),
        close: () => finish(null)
      }
      printAbove = showAbove

      /** Print notes above the composer, then draw it again under them. */
      const noteAbove = (lines: string[]): void => {
        atomically(() => {
          eraseRegion()
          if (lines.length) rawWrite(lines.map((l) => `${l}\n`).join(''))
          draw()
        })
      }

      /**
       * Ctrl-Z: give the terminal back exactly as the shell left it (cooked mode,
       * bracketed paste and modified keys off, the cursor shape reset, all in
       * teardown) and stop. On `fg`, take it again and repaint the draft.
       */
      const suspendComposer = (): void => {
        if (platform === 'win32') return noteAbove([paint(NO_SUSPEND_NOTE, 'dim')])
        eraseRegion()
        teardown()
        suspendProcess(() => {
          if (done) return
          try {
            setup()
            if (vimOn) rawWrite(vim.mode === 'normal' ? CURSOR_BLOCK : CURSOR_BAR)
          } catch {
            /* best-effort: the read still settles through close/cancel */
          }
          draw()
        })
      }

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
        } else if (hits.length > 1 && !(deps.menuFor?.(state.lines[state.row] ?? '', redrawMenu, paint) ?? []).length) {
          // Ambiguous and nothing more to insert: show the candidates above the
          // composer, unless the live menu under it already lists them (a slash
          // command). Printing them there too left a copy in the scrollback on
          // every Tab.
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

      /**
       * Ctrl-O: the transcript viewer takes the terminal, then the composer comes
       * back exactly as it was (draft, cursor, vim mode), as with $EDITOR above.
       */
      const runOverlay = async (open: () => Promise<void>): Promise<void> => {
        eraseRegion()
        teardown()
        try {
          await open()
        } catch {
          /* the viewer failing must not take the composer with it */
        }
        if (done) return
        setup()
        draw()
      }

      function onData(data: Buffer | string): void {
        const chunk = decodeChunk(data)
        const r = decodeInput(chunk, dec)
        dec = r.state
        if (r.keys.some((k) => k.type !== 'focus')) disarmReminder()
        // A paste body is attacker-controlled and can end paste mode early with its
        // own ESC[201~; without this, the bytes it puts after that marker would run
        // as real keys (submitting the turn, quitting, spawning $EDITOR).
        const guarded = sanitizePastedKeys(r.keys, lastPasteAt, now())
        lastPasteAt = guarded.lastPasteAt
        for (const key of guarded.keys) {
          if (done) return
          // The user is typing here, so focus can only mean the window state — and
          // the editor has nothing to do with it.
          if (key.type === 'focus') {
            noteFocus(key.on)
            continue
          }
          // A pasted (or dropped) list of image files attaches them, when every one is
          // a real file; anything else pastes as text, as it always has.
          if (key.type === 'paste' && imagePasteHandler && !state.search) {
            const paths = parseImagePaths(key.value, { windows: platform === 'win32' })
            const r = paths ? imagePasteHandler({ kind: 'files', paths }) : null
            if (r?.handled) {
              noteAbove(r.notes)
              continue
            }
          }
          // The decoder has no clock, so a double Esc is recognized here.
          let k: EditorKey = key
          if (key.type === 'escape') {
            const t = now()
            const inNormal = vimOn && vim.mode === 'normal'
            const double =
              !state.search && t - lastEsc.at < DOUBLE_ESC_MS && (!vimOn || (lastEsc.normal && inNormal))
            // An Esc that closed a search is not half of a double press, nor is the
            // second half of one the first half of the next.
            lastEsc = double || state.search ? { at: -Infinity, normal: false } : { at: t, normal: inNormal }
            if (double) k = { type: 'escape', double: true }
          } else {
            lastEsc = { at: -Infinity, normal: false }
          }
          let next: EditorState
          let outcome: EditorOutcome | undefined
          if (vimOn) {
            const before = vim.mode
            const r2 = reduceVim(vim, state, k)
            vim = r2.vim
            next = r2.state
            outcome = r2.outcome
            // The cursor shape is the signal a vim user reads without looking; only
            // written when the mode actually changed, so a keystroke stays one write.
            if (vim.mode !== before) rawWrite(vim.mode === 'normal' ? CURSOR_BLOCK : CURSOR_BAR)
          } else {
            const r2 = reduceEditor(state, k)
            next = r2.state
            outcome = r2.outcome
          }
          const changed = state.lines !== next.lines
          state = next
          if (changed && opts?.onDraft) opts.onDraft(editorText(state))
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
              // The discarded draft goes to history first, so Up brings it back.
              const discarded = editorText(state)
              if (discarded.trim()) deps.remember?.(discarded)
              eraseRegion()
              done = true
              composerStash = state.stashed
              pending = null
              // Closed before the handler runs: what it prints goes to the transcript,
              // not above a composer that is no longer there.
              openComposer = null
              printAbove = null
              flushHeld()
              midLine = false
              teardown()
              startTimer()
              if (spinnerLabel !== null) startInterruptWatch()
              interruptHandler?.()
              resolve(null)
              return
            }
            case 'clear-screen':
              atomically(() => {
                rawWrite('\x1b[2J\x1b[H')
                drawn = false
                draw()
              })
              break
            case 'cycle-thoughts':
              // The driver prints a line saying what changed; it lands where the
              // composer was, and the composer is drawn again under it, draft intact.
              atomically(() => {
                eraseRegion()
                cycleThoughtsHandler?.()
                draw()
              })
              break
            case 'transcript':
              // runOverlay re-attaches the listener itself, via setup().
              void runOverlay(() => transcriptHandler?.('composer') ?? Promise.resolve())
              return
            case 'cycle-mode':
              // The handler updates the driver's policy; promptNow() then renders the
              // new one on the very next draw, with the draft untouched.
              cycleModeHandler?.()
              draw()
              break
            case 'remember':
              // Left the buffer unsent (Esc Esc, a displaced stash): kept for Up.
              deps.remember?.(outcome.text)
              draw()
              break
            case 'rewind':
              // Esc Esc on an empty composer: the driver runs the /rewind picker once
              // this read is closed.
              if (!rewindHandler) {
                draw()
                break
              }
              rewindHandler()
              finish(null)
              return
            case 'paste-image': {
              const r = imagePasteHandler?.({ kind: 'clipboard' })
              noteAbove(r ? r.notes : [paint('· pasting images is unavailable here; use /image <path>', 'dim')])
              break
            }
            case 'suspend':
              suspendComposer()
              return
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
        openComposer = null
        printAbove = null
        void plainRead(promptNow()).then(resolve)
      }
    })
  }

  /**
   * The transcript viewer: `source` full screen on the alternate screen, until q,
   * Esc or Ctrl-C. Owns stdin in raw mode for its lifetime (the caller has released
   * it), rewraps on resize, and holds any output that arrives meanwhile until it
   * closes. Resolves false when there is no terminal to open it on.
   */
  const pager = (source: PagerSource): Promise<boolean> => {
    if (closed || pagerOpen) return Promise.resolve(false)
    // Screen-reader mode: no alternate screen and no cursor positioning. The whole
    // transcript is printed as plain lines, in order, for the reader to follow.
    if (screenReader) {
      out(`\n${source.plain().replace(/\n*$/, '')}\n\nend of transcript\n`)
      return Promise.resolve(true)
    }
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      stopTimer(true)
      stopInterruptWatch()
      rl.pause()
      const priorKeypress = stdin.listeners('keypress') as Array<(...args: unknown[]) => void>
      for (const l of priorKeypress) stdin.removeListener('keypress', l)
      const cols = (): number => Math.max(20, deps.columns?.() ?? process.stdout.columns ?? 80)
      const rows = (): number => Math.max(3, deps.rows?.() ?? process.stdout.rows ?? 24)
      let width = cols()
      let doc: TranscriptDoc = source.render(width - 1)
      let state: PagerState = { ...initialPagerState(), top: maxTop(doc, rows() - 1) }
      let dec: DecoderState = initialDecoderState()
      let stopResize: (() => void) | null = null
      let editing = false
      let done = false
      pagerOpen = true
      const draw = (): void => {
        const screen = renderPagerScreen(state, doc, { rows: rows(), cols: width, title: source.title, paint })
        // Every row is positioned and cleared on its own: nothing scrolls, nothing wraps.
        // Rows are chat text, so each passes the same filter as every other write.
        repaint(screen.map((row, i) => `\x1b[${i + 1};1H\x1b[2K${filterTerminalOutput(row)}`).join(''))
      }
      const listen = (): void => {
        stdin.setRawMode(true)
        stdin.resume()
        stdin.on('data', onData)
      }
      const unlisten = (): void => {
        stdin.removeListener('data', onData)
        stdin.setRawMode(false)
        stdin.pause()
      }
      const finish = (): void => {
        if (done) return
        done = true
        stopResize?.()
        try {
          unlisten()
        } catch {
          /* best-effort restore */
        }
        rawWrite(SHOW_CURSOR + ALT_SCREEN_OFF)
        pagerOpen = false
        try {
          for (const l of priorKeypress) stdin.on('keypress', l)
          rl.resume()
          rl.pause()
        } catch {
          /* best-effort restore */
        }
        // What arrived while the viewer was open, in the order it came.
        const held = heldOutput
        heldOutput = []
        for (const s of held) out(s)
        startTimer()
        if (spinnerLabel !== null) startInterruptWatch()
        resolve(true)
      }
      const edit = async (): Promise<void> => {
        editing = true
        unlisten()
        rawWrite(SHOW_CURSOR + ALT_SCREEN_OFF)
        let opened: boolean
        try {
          opened = deps.viewText ? await deps.viewText(source.plain()) : false
        } catch {
          opened = false
        }
        editing = false
        if (done) return
        rawWrite(ALT_SCREEN_ON + HIDE_CURSOR)
        listen()
        if (!opened) state = { ...state, message: 'set $VISUAL or $EDITOR to open the transcript in an editor' }
        draw()
      }
      const onTerminalResize = (): void => {
        if (done || editing) return
        const before = doc.lines.length
        width = cols()
        doc = source.render(width - 1)
        const top = rewrapTop(state.top, before, doc.lines.length)
        state = { ...state, top: Math.max(0, Math.min(maxTop(doc, rows() - 1), top)) }
        draw()
      }
      function onData(data: Buffer | string): void {
        const r = decodeInput(decodeChunk(data), dec)
        dec = r.state
        for (const key of r.keys) {
          if (done || editing) return
          if (key.type === 'focus') {
            noteFocus(key.on)
            continue
          }
          const next = reducePager(state, key, { doc, height: rows() - 1 })
          state = next.state
          if (next.outcome?.kind === 'close') return finish()
          if (next.outcome?.kind === 'edit') return void edit()
        }
        draw()
      }
      try {
        rawWrite(ALT_SCREEN_ON + HIDE_CURSOR)
        listen()
        stopResize = onResize?.(onTerminalResize) ?? null
        draw()
      } catch {
        finish()
      }
    })
  }

  return {
    out,
    pager,
    onTranscript: (handler) => {
      transcriptHandler = handler
    },
    onCycleThoughts: (handler) => {
      cycleThoughtsHandler = handler
    },
    // Erase the current terminal line (e.g. the composer's typed-but-abandoned input
    // on Ctrl-C) so the next prompt redraws clean.
    clearLine: () => {
      if (!screenReader) rawWrite(CLEAR_LINE)
      midLine = false
    },
    // The session's theme: the next frame, prompt, or menu is drawn with it.
    setPaint: (p) => {
      paint = p
    },
    readLine: (prompt, opts) => (screenReader ? readLinear(prompt, opts) : plainRead(prompt, opts)),
    readComposer,
    readSecret,
    yieldComposer: () => {
      // The viewer is up over the composer: whatever wants the turn waits for it.
      if (pagerOpen || !openComposer || !openComposer.empty()) return false
      openComposer.close()
      return true
    },
    /**
     * Write an attention signal. The title is ambient and always set; the bell and
     * notification only fire when the terminal has told us it lost focus — a bell
     * for something you are already watching is pure nuisance, and a nuisance bell
     * is one people turn off.
     */
    /** Take (and clear) what the user typed while the agent was working. */
    takeQueued: () => {
      // Steers still waiting come back from the run itself (`steers_returned`), so
      // only the follow-ups are handed over here.
      const out = waiting.filter((w) => w.kind === 'queued').map((w) => w.text)
      waiting = []
      return out
    },
    steerLanded: (id) => {
      const before = waiting.length
      waiting = waiting.filter((w) => w.id !== id)
      if (waiting.length === before) return
      pendingChanged(true)
      drawSpinner()
    },
    /** Take (and clear) the line typed mid-run but not yet sent with Enter. */
    takeDraft: () => {
      const out = draft
      draft = ''
      return out
    },
    onCycleMode: (handler) => {
      cycleModeHandler = handler
    },
    onImagePaste: (handler) => {
      imagePasteHandler = handler
    },
    onRewindKey: (handler) => {
      rewindHandler = handler
    },
    onSteer: (handler) => {
      steerHandler = handler
    },
    onUnsteer: (handler) => {
      unsteerHandler = handler
    },
    onPendingInput: (handler) => {
      pendingInputHandler = handler
    },
    setAccessibility: (a) => {
      if (a.screenReader !== undefined && a.screenReader !== screenReader) {
        // Take the spinner line down while it can still be erased, then stop drawing.
        if (a.screenReader && cancelTimer) stopTimer(true)
        screenReader = a.screenReader
        announced = null
        // Screen-reader output is never tracked for in-place redraws; start clean either way.
        midLine = false
        if (!screenReader) startTimer()
      }
      if (a.reduceMotion !== undefined && a.reduceMotion !== reduceMotion) {
        reduceMotion = a.reduceMotion
        // A running timer keeps its old pace otherwise; restart it at the new one.
        if (cancelTimer) {
          stopTimer(false)
          startTimer()
        }
      }
    },
    setMode: (label) => {
      modeLabel = label
      if (spinnerLabel !== null) drawSpinner()
    },
    setStatus: (status) => {
      statusLabel = filterTerminalOutput(status)
      if (spinnerLabel !== null) drawSpinner()
    },
    signal: (sig: TerminalSignal) => {
      if (sig.title) rawWrite(titleSequence(sig.title))
      if (sig.alert && userIsAway()) rawWrite(alertSequence(sig.alert, sig.mode ?? 'auto'))
    },
    remindIfIdle: (spec, mode, ms = IDLE_REMINDER_MS) => armReminder(spec, mode, ms),
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
      // A turn is running again, so nothing is waiting on the user any more.
      disarmReminder()
      spinnerLabel = filterTerminalOutput(label)
      spinnerStart = now()
      tick = 0
      // Said once, as a line: what it is doing now.
      if (screenReader) {
        announced = spinnerLabel
        announce(lowerFirst(spinnerLabel))
      }
      startTimer()
      // A turn is now running with no prompt up — watch for Ctrl-C so it can be
      // interrupted while it streams.
      startInterruptWatch()
    },
    setSpinnerLabel: (label) => {
      if (spinnerLabel === null) return
      // A label can name an MCP server's tool, which the server chose.
      const safeLabel = filterTerminalOutput(label)
      spinnerLabel = safeLabel
      if (screenReader && safeLabel !== announced) {
        announced = safeLabel
        announce(lowerFirst(safeLabel))
      }
    },
    stopSpinner: () => {
      spinnerLabel = null
      announced = null
      stopTimer(true)
      stopInterruptWatch()
    },
    select: async (spec) => {
      // Stop the spinner while the picker owns the screen (mirrors readLine): its
      // 100ms redraw would otherwise paint frames into the picker's multi-line
      // region and fight its cursor-up redraw, tearing it. The picker also owns
      // stdin (its own raw keypress + Ctrl-C cancel), so release the watcher first.
      if (screenReader) return selectNumbered(spec)
      stopTimer(true)
      toFreshLine()
      stopInterruptWatch()
      // A key answers the picker in one press, so drop what was typed before it was on
      // screen: a stray buffered "y" must not approve something the user never saw.
      drainInput()
      try {
        return await runPicker(spec, rl, repaint, paint, stdin, {
          size: () => ({ rows: deps.rows?.() ?? process.stdout.rows ?? 0, columns: columnsNow() }),
          printAbove: (fn) => {
            printAbove = fn
          }
        })
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
/**
 * How many PHYSICAL terminal rows `lines` occupy at width `cols` (0 = no wrapping known,
 * fall back to the logical line count). A rendered line wider than the terminal wraps to
 * `ceil(width / cols)` rows; the picker's in-place redraw must move the cursor up by this
 * total, not the logical line count, or it desyncs when any line wraps.
 */
export function pickerPhysicalRows(lines: string[], cols: number): number {
  return cols > 0
    ? lines.reduce((n, l) => n + Math.max(1, Math.ceil(visibleWidth(l) / cols)), 0)
    : lines.length
}

function runPicker(
  spec: PickerSpec,
  rl: ReadlineLike,
  write: (s: string) => void,
  paint: Painter,
  stdin: NodeJS.ReadStream,
  screen: {
    /** The terminal's size now (0 when unknown), read on every redraw. */
    size: () => { rows: number; columns: number }
    /** Register how outside output is printed above the open picker (null once it closes). */
    printAbove: (fn: ((s: string) => void) | null) => void
  }
): Promise<PickerOutcome> {
  // No real terminal, or no raw mode available → let the driver use the typed path.
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return Promise.resolve({ kind: 'type' })

  return new Promise<PickerOutcome>((resolve) => {
    // The model, the filter's row fetches and in-picker actions (rename, delete) all
    // live in the session; this adapter only maps keys and redraws its region.
    const session = createPickerSession(spec, paint)
    let prevRows = 0
    let done = false
    // Keys are handled one at a time: an action may await, and a key arriving
    // meanwhile must see the state it left.
    let queue: Promise<void> = Promise.resolve()

    // readline keeps its own 'keypress' listener on stdin, and it runs whether or not
    // the interface is paused: left attached, Up/Down also walk readline's history and
    // repaint "> <old entry>" under the picker, Enter submits a junk line, and Ctrl-C
    // reaches both handlers. Detach every other listener while the picker owns input
    // (as readComposer and readSecret do) and restore them in finish.
    const priorKeypress = stdin.listeners('keypress') as Array<(...args: unknown[]) => void>
    const draw = (first: boolean): void => {
      // \r first: the up-move is counted from column 0 of the row under the picker.
      // Erase and redraw go out as one write, so `write` can paint them atomically.
      const erase = !first && prevRows > 0 ? `\r\x1b[${prevRows}A\x1b[0J` : '' // up N physical rows, erase to end
      // Option labels can be the model's text (an ask_user answer) and /resume rows are
      // chat titles and previews, so every line passes the same filter as other writes.
      const { rows, columns } = screen.size()
      // The real screen size: the window of rows fits its height (the redraw moves up
      // over the region and can't pass the top), and each line is cut to its width.
      const lines = session.lines({ width: columns, height: rows }).map(filterTerminalOutput)
      // Count PHYSICAL rows, not logical lines: a rendered line wider than the terminal
      // wraps to several rows, so moving up by the logical count would under-count and
      // the picker would walk down the screen, leaving duplicated rows on each keypress.
      prevRows = pickerPhysicalRows(lines, columns || 0)
      write(`${erase}${lines.join('\n')}\n`)
    }
    // Outside output goes above the picker, which is drawn again under it.
    // One write, erase and text, then the redraw, so `write` can paint each at once.
    screen.printAbove((s) => {
      write(`${prevRows > 0 ? `\r\x1b[${prevRows}A\x1b[0J` : ''}${endsLine(s) ? s : `${s}\n`}`)
      draw(true)
    })
    const finish = (outcome: PickerOutcome): void => {
      if (done) return
      done = true
      screen.printAbove(null)
      try {
        stdin.removeListener('keypress', onKey)
        for (const l of priorKeypress) if (!stdin.listeners('keypress').includes(l)) stdin.on('keypress', l)
        stdin.setRawMode(false)
        rl.resume() // hand input back to readline for the next read
        rl.pause()
      } catch {
        /* best-effort restore */
      }
      resolve(outcome)
    }
    const onKey = (_str: string, key: { name?: string; sequence?: string; ctrl?: boolean }): void => {
      const pk = pickerKeyFor(spec, key ?? {})
      if (!pk) return
      queue = queue.then(async () => {
        if (done) return
        try {
          const outcome = await session.press(pk)
          if (outcome) finish(outcome)
          else draw(false)
        } catch {
          // A redraw/write failure (e.g. a broken pipe) must not escape the keypress
          // handler as an unhandled rejection with the listener still attached and raw
          // mode still on. Fall back to the typed prompt; finish() restores both.
          finish({ kind: 'type' })
        }
      })
    }

    try {
      rl.pause()
      emitKeypressEvents(stdin)
      for (const l of priorKeypress) stdin.removeListener('keypress', l)
      stdin.setRawMode(true)
      stdin.resume()
      stdin.on('keypress', onKey)
      draw(true)
    } catch {
      finish({ kind: 'type' })
    }
  })
}
