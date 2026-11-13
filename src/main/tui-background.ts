/**
 * Whether the terminal has a light or a dark background, so the terminal client can
 * start on the `light` theme in a light terminal when the user hasn't picked one
 * (a saved `/theme` choice always wins).
 *
 * Two sources, in order:
 * - `COLORFGBG` ("fg;bg", set by rxvt, Konsole, iTerm2 and others): the background
 *   is the last field, an ANSI color index; 7 (white) and 15 (bright white) are light.
 * - An OSC 11 query (`ESC ] 11 ; ? BEL`), which most modern terminals answer with
 *   the background color (`ESC ] 11 ; rgb:RRRR/GGGG/BBBB BEL`). A terminal that
 *   doesn't support it stays silent, so the query gives up after a short wait.
 * Neither answers: null, and the default theme stays.
 */

export type Background = 'light' | 'dark'

/** The background `COLORFGBG` describes, or null when it is unset or unreadable. */
export function backgroundFromColorFgBg(value: string | undefined): Background | null {
  if (!value) return null
  const last = value.split(';').pop()?.trim() ?? ''
  if (!/^\d+$/.test(last)) return null
  const bg = Number(last)
  if (bg > 15) return null
  return bg === 7 || bg === 15 ? 'light' : 'dark'
}

/**
 * The background color in an OSC 11 reply (`rgb:` with 1 to 4 hex digits per
 * channel, terminated by BEL or ST), as 0..1 channels, or null when there is none.
 */
export function parseOsc11(reply: string): { r: number; g: number; b: number } | null {
  // eslint-disable-next-line no-control-regex
  const m = /\x1b\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?(?:\x07|\x1b\\)/i.exec(reply)
  if (!m) return null
  const channel = (hex: string): number => parseInt(hex, 16) / (16 ** hex.length - 1)
  return { r: channel(m[1]), g: channel(m[2]), b: channel(m[3]) }
}

/** Light when the color's relative luminance is above the midpoint. */
export function backgroundFromRgb(c: { r: number; g: number; b: number }): Background {
  const lin = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const luminance = 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
  return luminance > 0.4 ? 'light' : 'dark'
}

/** The bits of a TTY stream the query needs (real process streams satisfy it). */
export interface QueryStreams {
  input: {
    isTTY?: boolean
    isRaw?: boolean
    setRawMode?: (on: boolean) => unknown
    on(event: 'data', fn: (chunk: Buffer | string) => void): unknown
    off(event: 'data', fn: (chunk: Buffer | string) => void): unknown
    isPaused?: () => boolean
    pause?: () => unknown
  }
  output: { isTTY?: boolean; write(s: string): unknown }
}

/** How long to wait for a terminal to answer the OSC 11 query. */
export const OSC11_TIMEOUT_MS = 150

/**
 * Detect the terminal background: `COLORFGBG` first, then an OSC 11 query when both
 * streams are a TTY. Leaves the input stream as it found it (raw mode and paused
 * state). Never throws; null when nothing answers.
 */
export async function detectTerminalBackground(
  streams: QueryStreams,
  env: NodeJS.ProcessEnv,
  timeoutMs = OSC11_TIMEOUT_MS
): Promise<Background | null> {
  const fromEnv = backgroundFromColorFgBg(env.COLORFGBG)
  if (fromEnv) return fromEnv
  const { input, output } = streams
  if (!input.isTTY || !output.isTTY || !input.setRawMode || env.TERM === 'dumb') return null
  const wasRaw = input.isRaw === true
  const wasPaused = input.isPaused?.() ?? false
  return new Promise<Background | null>((resolve) => {
    let buf = ''
    let done = false
    const finish = (result: Background | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      input.off('data', onData)
      try {
        if (!wasRaw) input.setRawMode?.(false)
        if (wasPaused) input.pause?.()
      } catch {
        // A closed TTY: nothing to restore.
      }
      resolve(result)
    }
    const onData = (chunk: Buffer | string): void => {
      buf += chunk.toString()
      const rgb = parseOsc11(buf)
      if (rgb) finish(backgroundFromRgb(rgb))
      else if (buf.length > 256) finish(null)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    try {
      input.setRawMode?.(true)
      input.on('data', onData)
      output.write('\x1b]11;?\x07')
    } catch {
      finish(null)
    }
  })
}
