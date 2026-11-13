/**
 * The live view of a running shell command's output: what the desktop app shows in
 * the tool row before the command ends. Bounded on every side, since a command can
 * print without end:
 *
 * - it keeps only the last {@link KEEP_CHARS} characters of raw output;
 * - it sends at most one update per {@link THROTTLE_MS}, each the last
 *   {@link SHOWN_LINES} lines (at most {@link SHOWN_CHARS} characters) of that buffer;
 * - every update goes through the run's secret redactor first. The whole kept buffer is
 *   redacted, then cut, so a secret that straddles a chunk boundary is still caught;
 *   only one cut off at the far end of the kept buffer could be partly missed, and that
 *   end is never in the part shown.
 *
 * The result of the tool, not this, is what the model and the saved chat get.
 */

/** Raw characters kept, far more than are shown, so redaction sees whole secrets. */
export const KEEP_CHARS = 64 * 1024
/** Most characters in one update. */
export const SHOWN_CHARS = 8 * 1024
/** Most lines in one update. */
export const SHOWN_LINES = 200
/** Least time between two updates. */
export const THROTTLE_MS = 150

export interface LiveOutputSink {
  /** Feed a chunk of output as it arrives. */
  push: (chunk: string) => void
  /** Stop: send nothing more (the tool's result takes over). */
  close: () => void
}

/** The part of `text` a live view shows: its last lines, within the character cap. */
export function liveTail(text: string): string {
  let tail = text.length > SHOWN_CHARS ? text.slice(-SHOWN_CHARS) : text
  const lines = tail.split('\n')
  if (lines.length > SHOWN_LINES) tail = lines.slice(-SHOWN_LINES).join('\n')
  // Cut where a line starts, unless that would leave nothing.
  else if (tail.length < text.length) {
    const nl = tail.indexOf('\n')
    if (nl >= 0 && nl < tail.length - 1) tail = tail.slice(nl + 1)
  }
  return tail
}

/**
 * A sink that sends the tail of what it is fed through `send`, throttled. `redact`
 * scrubs credentials; `now` and the timer functions are injectable for tests.
 */
export function createLiveOutput(
  send: (tail: string) => void,
  redact: (text: string) => string,
  clock: {
    now: () => number
    setTimer: (fn: () => void, ms: number) => unknown
    clearTimer: (t: unknown) => void
  } = {
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>)
  }
): LiveOutputSink {
  let buffer = ''
  let closed = false
  let lastSent = -Infinity
  let timer: unknown = null
  let dirty = false

  const flush = (): void => {
    timer = null
    if (closed || !dirty) return
    dirty = false
    lastSent = clock.now()
    try {
      send(liveTail(redact(buffer)))
    } catch {
      // A failed update never touches the command.
    }
  }

  return {
    push(chunk) {
      if (closed || !chunk) return
      buffer += chunk
      if (buffer.length > KEEP_CHARS) buffer = buffer.slice(-KEEP_CHARS)
      dirty = true
      if (timer !== null) return
      const wait = THROTTLE_MS - (clock.now() - lastSent)
      if (wait <= 0) flush()
      else timer = clock.setTimer(flush, wait)
    },
    close() {
      closed = true
      if (timer !== null) clock.clearTimer(timer)
      timer = null
      buffer = ''
    }
  }
}
