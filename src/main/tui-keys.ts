/**
 * Terminal input decoding for the raw-mode composer: raw stdin bytes in, semantic
 * editor keys out.
 *
 * Why not node:readline's keypress events: the composer needs BRACKETED PASTE
 * (a paste must land as one editable block, never as a line-by-line submission),
 * and readline decodes the `ESC[200~` / `ESC[201~` markers as ordinary escape
 * sequences while splitting the pasted body into per-character keypresses and
 * per-line `line` events. Owning the decode is what makes a paste recoverable —
 * and, unlike the keypress path, a pure `string -> keys` function is testable in
 * CI with no TTY at all.
 *
 * The decoder is chunk-oriented and stateful only where the terminal forces it to
 * be: an escape sequence or a paste body can be split across reads, so partial
 * input is held in `pending` until it completes.
 */

/** A semantic key the composer's editor model understands. */
export type EditorKey =
  /** One or more printable characters typed (or pasted without bracketing). */
  | { type: 'char'; value: string }
  /** A bracketed-paste block: inserted verbatim, never submitted. */
  | { type: 'paste'; value: string }
  /** Enter: submit the buffer. */
  | { type: 'enter' }
  /** Insert a literal newline (Ctrl-J / Alt-Enter), keeping the composer open. */
  | { type: 'newline' }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'word-left' }
  | { type: 'word-right' }
  /** Ctrl-K: kill to end of line. */
  | { type: 'kill-line' }
  /** Ctrl-U: kill to start of line. */
  | { type: 'kill-to-start' }
  /** Ctrl-W / Alt-Backspace: kill the word before the cursor. */
  | { type: 'kill-word' }
  /** Ctrl-Y: yank the last kill. */
  | { type: 'yank' }
  /** Ctrl-L: repaint. */
  | { type: 'clear-screen' }
  /** Ctrl-R: incremental reverse history search. */
  | { type: 'search' }
  | { type: 'tab' }
  /** Ctrl-C. */
  | { type: 'interrupt' }
  /** Ctrl-D on an empty buffer. */
  | { type: 'eof' }
  | { type: 'escape' }
  /** Ctrl-X Ctrl-E: hand the draft to $VISUAL/$EDITOR. */
  | { type: 'external-edit' }
  /**
   * The terminal reporting that its window gained/lost focus (DEC mode 1004).
   * Not a keystroke: it lets attention signals fire only when the user is away.
   */
  | { type: 'focus'; on: boolean }

// ESC (0x1b), built from a char code so no control character appears inside a
// regex literal (which trips eslint's no-control-regex), matching tui-wrap.ts.
const ESC = String.fromCharCode(27)
/** CSI: ESC [ <params> <final>. */
const CSI_RE = new RegExp(`^${ESC}\\[([0-9;]*)([A-Za-z~])`)
/** SS3 (application cursor mode): ESC O <final>. */
const SS3_RE = new RegExp(`^${ESC}O([A-Za-z])`)
/** A CSI/SS3 introducer with no final byte yet — held until the rest arrives. */
const PARTIAL_SEQ_RE = new RegExp(`^${ESC}(\\[[0-9;]*|O)$`)

/** Terminal escape codes for bracketed paste (DEC private mode 2004). */
export const PASTE_START = '\x1b[200~'
export const PASTE_END = '\x1b[201~'
/** Enable / disable bracketed paste. Written when the composer takes the terminal. */
export const ENABLE_BRACKETED_PASTE = '\x1b[?2004h'
export const DISABLE_BRACKETED_PASTE = '\x1b[?2004l'

/**
 * Enable / disable focus reporting (DEC mode 1004). The terminal then sends CSI I
 * on focus and CSI O on blur, which is the only way a terminal program can know
 * whether anyone is looking — and therefore whether a bell is a help or a nuisance.
 */
export const ENABLE_FOCUS_REPORTING = '\x1b[?1004h'
export const DISABLE_FOCUS_REPORTING = '\x1b[?1004l'
/** What the terminal sends for focus / blur under mode 1004. */
export const FOCUS_IN = '\x1b[I'
export const FOCUS_OUT = '\x1b[O'

/** Decoder state carried between chunks (a sequence or paste can be split across reads). */
export interface DecoderState {
  /** An incomplete escape sequence held until the rest arrives. */
  pending: string
  /** True while between the paste start/end markers. */
  inPaste: boolean
  /** Paste body accumulated so far. */
  pasteBuf: string
  /** True after Ctrl-X, so a following Ctrl-E means "edit in $EDITOR". */
  ctrlX: boolean
}

export function initialDecoderState(): DecoderState {
  return { pending: '', inPaste: false, pasteBuf: '', ctrlX: false }
}

/**
 * Normalize a pasted body: terminals send CR or CRLF for line breaks, and a paste
 * can carry control characters we must not inject into the buffer — the composer
 * echoes its buffer on every redraw, so an escape sequence smuggled in through the
 * clipboard would be handed straight back to the terminal to execute. Strips C0
 * (including ESC and BEL) and C1 (U+0080-U+009F, which carry 8-bit CSI/OSC/DCS
 * introducers some terminals honor); tabs and newlines survive.
 */
export function normalizePaste(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
}

/** True for a C1 control (U+0080-U+009F): an 8-bit escape introducer, never text. */
function isC1(ch: string): boolean {
  const c = ch.charCodeAt(0)
  return c >= 0x80 && c <= 0x9f
}

/**
 * Keys allowed to survive `sanitizePastedKeys` — pure content, plus focus reports
 * (which the terminal, not the clipboard, generates, and which change no state).
 */
const PASTE_SAFE_KEYS = new Set<EditorKey['type']>(['char', 'paste', 'newline', 'focus'])

/**
 * Neutralize keys that arrive on the heels of a paste.
 *
 * THREAT: bracketed paste marks a block with `ESC[200~` … `ESC[201~`, but the
 * BODY is attacker-controlled (text copied from a web page or a file). A body
 * containing its own `ESC[201~` ends paste mode early, and whatever the attacker
 * put after it would otherwise decode as live keystrokes: a bare CR submits the
 * turn with no human ever pressing Enter, and Ctrl-X Ctrl-E spawns $EDITOR,
 * Ctrl-D quits, Ctrl-U hides the payload by wiping the visible draft.
 *
 * DEFENSE: a terminal delivers a paste as one continuous burst, so anything
 * arriving within `windowMs` of paste bytes came from the clipboard, not from
 * hands. Inside that window only content keys pass: Enter degrades to a line
 * break, and every action key is dropped. A human's real Enter lands many
 * milliseconds later and is unaffected.
 *
 * Kept separate from `decodeInput` (and given an injected clock) so it stays pure
 * and directly testable.
 */
export function sanitizePastedKeys(
  keys: EditorKey[],
  lastPasteAt: number,
  now: number,
  windowMs = 50
): { keys: EditorKey[]; lastPasteAt: number } {
  let last = lastPasteAt
  const out: EditorKey[] = []
  for (const key of keys) {
    if (key.type === 'paste') {
      last = now
      out.push(key)
      continue
    }
    if (now - last >= windowMs) {
      out.push(key)
      continue
    }
    if (key.type === 'enter') out.push({ type: 'newline' })
    else if (PASTE_SAFE_KEYS.has(key.type)) out.push(key)
    // Anything else in the window is dropped: it cannot be a real keystroke.
  }
  return { keys: out, lastPasteAt: last }
}

/**
 * How many trailing characters of `buf` could be the start of `marker`. Lets the
 * decoder hold a marker that got split across chunk boundaries instead of leaking
 * half of it into the paste body.
 */
function partialTail(buf: string, marker: string): number {
  const max = Math.min(buf.length, marker.length - 1)
  for (let n = max; n > 0; n--) {
    if (marker.startsWith(buf.slice(buf.length - n))) return n
  }
  return 0
}

/** CSI final-byte lookup for the cursor/edit keys the composer cares about. */
function csiKey(params: string, final: string): EditorKey | null {
  // Modified keys arrive as `1;<mod><final>`: 5 = Ctrl, 3 = Alt. Both mean word-wise.
  const mod = /^1;([0-9]+)$/.exec(params)?.[1]
  const wordwise = mod === '5' || mod === '3'
  switch (final) {
    // Focus reporting (mode 1004). Only ever sent with no params, which keeps
    // these distinct from any modified cursor key.
    case 'I':
      return params === '' ? { type: 'focus', on: true } : null
    case 'O':
      return params === '' ? { type: 'focus', on: false } : null
    case 'A':
      return { type: 'up' }
    case 'B':
      return { type: 'down' }
    case 'C':
      return wordwise ? { type: 'word-right' } : { type: 'right' }
    case 'D':
      return wordwise ? { type: 'word-left' } : { type: 'left' }
    case 'H':
      return { type: 'home' }
    case 'F':
      return { type: 'end' }
    case '~':
      switch (params) {
        case '1':
        case '7':
          return { type: 'home' }
        case '3':
          return { type: 'delete' }
        case '4':
        case '8':
          return { type: 'end' }
        default:
          return null // page up/down, function keys: ignored by the composer
      }
    default:
      return null
  }
}

/** A single control byte, or null when it isn't one the composer binds. */
function controlKey(ch: string, pasted: boolean): EditorKey | null {
  switch (ch) {
    case '\r':
      // Inside an unbracketed paste burst a CR is a line break, NOT a submission —
      // the safety net for terminals that don't support bracketed paste.
      return pasted ? { type: 'newline' } : { type: 'enter' }
    case '\n':
      return { type: 'newline' } // Ctrl-J
    case '\t':
      return { type: 'tab' }
    case '\x7f':
    case '\b':
      return { type: 'backspace' }
    case '\x01':
      return { type: 'home' }
    case '\x02':
      return { type: 'left' }
    case '\x03':
      return { type: 'interrupt' }
    case '\x04':
      return { type: 'eof' }
    case '\x05':
      return { type: 'end' }
    case '\x06':
      return { type: 'right' }
    case '\x0b':
      return { type: 'kill-line' }
    case '\x0c':
      return { type: 'clear-screen' }
    case '\x0e':
      return { type: 'down' }
    case '\x10':
      return { type: 'up' }
    case '\x12':
      return { type: 'search' }
    case '\x15':
      return { type: 'kill-to-start' }
    case '\x17':
      return { type: 'kill-word' }
    case '\x19':
      return { type: 'yank' }
    default:
      return null
  }
}

/**
 * Decode one raw stdin chunk into editor keys, carrying `state` across calls.
 *
 * `pasted` heuristic: a terminal delivers real keystrokes one at a time, so a
 * chunk that is both large and contains a line break can only be a paste from a
 * terminal without bracketed paste. Treating its CRs as line breaks (rather than
 * submissions) keeps the multi-line-paste data loss fixed even there.
 */
export function decodeInput(
  chunk: string,
  state: DecoderState
): { keys: EditorKey[]; state: DecoderState } {
  const keys: EditorKey[] = []
  const next: DecoderState = { ...state }
  let buf = next.pending + chunk
  next.pending = ''
  const pasted = chunk.length > 16 && /[\r\n]/.test(chunk)

  while (buf.length > 0) {
    if (next.inPaste) {
      const end = buf.indexOf(PASTE_END)
      if (end === -1) {
        // Hold back anything that could be a split END marker.
        const keep = partialTail(buf, PASTE_END)
        next.pasteBuf += buf.slice(0, buf.length - keep)
        next.pending = buf.slice(buf.length - keep)
        break
      }
      next.pasteBuf += buf.slice(0, end)
      keys.push({ type: 'paste', value: normalizePaste(next.pasteBuf) })
      next.pasteBuf = ''
      next.inPaste = false
      buf = buf.slice(end + PASTE_END.length)
      continue
    }

    const ch = buf[0]

    if (ch === '\x1b') {
      if (buf.startsWith(PASTE_START)) {
        next.inPaste = true
        buf = buf.slice(PASTE_START.length)
        continue
      }
      // An incomplete paste marker: wait for the rest. Requires more than the bare
      // ESC, which is the Escape key itself (see below) — holding that would mean
      // Escape never fires until the user pressed another key.
      if (buf.length > 1 && PASTE_START.startsWith(buf)) {
        next.pending = buf
        break
      }
      const csi = CSI_RE.exec(buf)
      if (csi) {
        const key = csiKey(csi[1], csi[2])
        if (key) keys.push(key)
        buf = buf.slice(csi[0].length)
        continue
      }
      const ss3 = SS3_RE.exec(buf)
      if (ss3) {
        const key = csiKey('', ss3[1])
        if (key) keys.push(key)
        buf = buf.slice(ss3[0].length)
        continue
      }
      // An introducer with no final byte yet — hold it. (`ESC` alone is deliberately
      // excluded: that's the Escape key, emitted below.)
      if (PARTIAL_SEQ_RE.test(buf)) {
        next.pending = buf
        break
      }
      // ESC + char = Alt-<char>.
      const alt = buf[1]
      if (alt !== undefined) {
        buf = buf.slice(2)
        if (alt === 'b' || alt === 'B') keys.push({ type: 'word-left' })
        else if (alt === 'f' || alt === 'F') keys.push({ type: 'word-right' })
        else if (alt === '\x7f' || alt === '\b') keys.push({ type: 'kill-word' })
        else if (alt === '\r' || alt === '\n') keys.push({ type: 'newline' })
        // Any other Alt-combo is unbound: swallow it rather than inserting the char.
        continue
      }
      // A lone ESC in its own chunk is the Escape key.
      keys.push({ type: 'escape' })
      buf = buf.slice(1)
      continue
    }

    if (ch < ' ' || ch === '\x7f') {
      buf = buf.slice(1)
      // Ctrl-X Ctrl-E hands the draft to $EDITOR; Ctrl-X alone is a dead prefix.
      if (ch === '\x18') {
        next.ctrlX = true
        continue
      }
      if (next.ctrlX) {
        next.ctrlX = false
        if (ch === '\x05') {
          keys.push({ type: 'external-edit' })
          continue
        }
      }
      const key = controlKey(ch, pasted)
      if (key) keys.push(key)
      continue
    }

    // A C1 control (8-bit CSI/OSC/DCS introducer) is never text: drop it rather
    // than let it into the buffer, which the composer echoes back to the terminal.
    if (isC1(ch)) {
      buf = buf.slice(1)
      continue
    }

    next.ctrlX = false
    // A printable run: take everything up to the next control byte in one key.
    let i = 0
    while (i < buf.length && buf[i] >= ' ' && buf[i] !== '\x7f' && buf[i] !== '\x1b' && !isC1(buf[i])) i++
    keys.push({ type: 'char', value: buf.slice(0, i) })
    buf = buf.slice(i)
  }

  return { keys, state: next }
}
