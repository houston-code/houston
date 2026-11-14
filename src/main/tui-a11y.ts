import type { AppSettings } from '@shared/types'

/**
 * Accessibility modes for the interactive terminal, decided once at launch from the
 * flag, the environment and the saved settings, plus the plain-text transform that
 * screen-reader mode puts every write through. Pure, so both are testable.
 */

/** The spinner's refresh interval with reduced motion on: the timer, not an animation. */
export const REDUCED_MOTION_REFRESH_MS = 5000

/** The still mark the activity line shows in place of the spinner's frames. */
export const STATIC_SPINNER_GLYPH = '•'

/** An environment switch: `1`, `true`, `yes` or `on` (any case) turns it on. */
export function envFlag(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim())
}

export interface AccessibilityModes {
  screenReader: boolean
  /**
   * The reduced-motion preference on its own. Screen-reader mode implies it (the
   * driver passes both to the adapter), but turning screen-reader mode off later
   * must not leave motion reduced for someone who never asked for that.
   */
  reduceMotion: boolean
}

/**
 * Screen-reader mode is on when the flag asks for it, `HOUSTON_SCREEN_READER` is set,
 * or the saved setting says so. Reduced motion is on with its own env var or setting.
 */
export function resolveAccessibility(
  flags: { screenReader?: boolean },
  env: NodeJS.ProcessEnv,
  settings: Pick<AppSettings, 'tuiScreenReader' | 'reduceMotion'>
): AccessibilityModes {
  const screenReader =
    flags.screenReader === true || envFlag(env.HOUSTON_SCREEN_READER) || settings.tuiScreenReader === true
  const reduceMotion = envFlag(env.HOUSTON_REDUCE_MOTION) || settings.reduceMotion === true
  return { screenReader, reduceMotion }
}

// Built from char codes so no control character sits in a regex literal (eslint's
// no-control-regex), matching tui-keys.ts.
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
/**
 * Every terminal escape: CSI (colors, cursor moves, erases), OSC (titles, links) and
 * the two-byte forms. A screen reader speaks none of them, and in this mode nothing
 * may move the cursor or rewrite a line.
 */
const ANSI_RE = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`,
  'g'
)
/** Control characters other than newline and tab (a bare CR rewinds the line). */
const CONTROL_RE = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`, 'g')

/**
 * Marks that open a line, and the words a screen reader should hear instead. Bullets
 * and arrows that only decorate say nothing; status marks say what they mean.
 */
const LEADING_MARKS: Record<string, string> = {
  '·': '',
  '•': '',
  '›': '',
  '↳': '',
  '⎿': '',
  '☰': '',
  '▣': '',
  '▦': '',
  '■': '',
  '│': '',
  '┌': 'code ',
  '✓': 'done: ',
  '✗': 'failed: ',
  '✕': 'failed: ',
  '⚠': 'warning: ',
  '●': 'done: ',
  '◐': 'in progress: ',
  '○': 'to do: ',
  '✎': 'edited: ',
  '⊘': 'stopped: ',
  '⋯': 'skipped: '
}
const LEADING_RE = new RegExp(`^([ \\t]*)([${Object.keys(LEADING_MARKS).join('')}])(?:[ \\t]+|$)`, 'gm')

/** Braille spinner frames: pure animation. */
const SPINNER_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g

/**
 * Text as a screen reader should get it: no escapes, no line rewinds, and the
 * decorative glyphs (meter bars, box lines, bullets, arrows) replaced with words or
 * dropped. The words around them are left alone, so a model's reply reads as written.
 */
export function plainText(s: string): string {
  return (
    s
      .replace(ANSI_RE, '')
      // A CR that ends a line (CRLF) is a line end; any other rewinds the line.
      .replace(/\r\n/g, '\n')
      .replace(CONTROL_RE, '')
      .replace(SPINNER_RE, '')
      // The context meter (`▓▓▓░░░░░░░ 30%`): the percent says it, the bar is noise.
      .replace(/[▓░]{2,} ?/g, 'context ')
      // Speaker marks in the resume recap.
      .replace(/\b(you|houston) ›/g, '$1:')
      .replace(LEADING_RE, (_m, indent: string, mark: string) => `${indent}${LEADING_MARKS[mark] ?? ''}`)
      // Rules and table separators drawn with box lines.
      .replace(/[─━═]+(?:┼[─━═]+)*/g, '')
      .replace(/[ \t]+[│┃║][ \t]+/g, ', ')
      .replace(/[ \t]+·[ \t]+/g, ', ')
      // A status mark inside a row ("Anthropic  ✗ no key"): the words after it say it.
      .replace(/([ \t])[✓✗✕][ \t]+/g, '$1')
      // A prompt's arrow ("setup › ") reads as a colon.
      .replace(/ ›( |$)/gm, ':$1')
      .replace(/[ \t]+→[ \t]+/g, ' to ')
      .replace(/[ \t]+⇒[ \t]+/g, ' gives ')
  )
}
