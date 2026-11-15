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
  /**
   * `ctrlB`: it came from Ctrl-B, which moves the cursor at the composer but, while a
   * turn runs, moves the running command to the background.
   */
  | { type: 'left'; ctrlB?: true }
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
  /**
   * Esc. `double` is set by the composer (not the decoder, which has no clock) when
   * this press follows another within the double-press window.
   */
  | { type: 'escape'; double?: boolean }
  /** Ctrl-X Ctrl-E or Ctrl-G: hand the draft to $VISUAL/$EDITOR. */
  | { type: 'external-edit' }
  /** Ctrl-_ (Ctrl-/ on most keyboards): undo the last edit. */
  | { type: 'undo' }
  /** Ctrl-^ (Ctrl-6 on most keyboards): redo what undo took back. */
  | { type: 'redo' }
  /** Ctrl-S: stash the draft and clear the composer, or restore the stash on an empty one. */
  | { type: 'stash' }
  /** Ctrl-V / Alt-V: attach the image on the clipboard. */
  | { type: 'paste-image' }
  /** Ctrl-Z: suspend Houston to the shell (job control). */
  | { type: 'suspend' }
  /**
   * The terminal reporting that its window gained/lost focus (DEC mode 1004).
   * Not a keystroke: it lets attention signals fire only when the user is away.
   */
  | { type: 'focus'; on: boolean }
  /** Shift-Tab: step to the next approval mode. */
  | { type: 'cycle-mode' }
  /** Ctrl-O: open the transcript viewer. */
  | { type: 'transcript' }
  /** Alt-T: step to the next way of showing the model's reasoning. */
  | { type: 'cycle-thoughts' }
  /** Alt-P or Ctrl-X Ctrl-P: expand the collapsed pastes in the draft back to text. */
  | { type: 'expand-paste' }
  /** Page Up / Page Down: the composer ignores them; the transcript viewer pages. */
  | { type: 'page-up' }
  | { type: 'page-down' }

// ESC (0x1b), built from a char code so no control character appears inside a
// regex literal (which trips eslint's no-control-regex), matching tui-wrap.ts.
const ESC = String.fromCharCode(27)
/** CSI: ESC [ <params> <final>. */
const CSI_RE = new RegExp(`^${ESC}\\[([0-9;]*)([A-Za-z~])`)
/** SS3 (application cursor mode): ESC O <final>. */
const SS3_RE = new RegExp(`^${ESC}O([A-Za-z])`)
/** A CSI/SS3 introducer with no final byte yet — held until the rest arrives. */
const PARTIAL_SEQ_RE = new RegExp(`^${ESC}(\\[[0-9;]*|O)$`)

/**
 * OSC (ESC ] <number> ; <payload> BEL | ESC \): never typed, only a terminal's reply
 * to a query. A background-colour reply (OSC 11) that arrives after the startup probe
 * gave up waiting (slow links, SSH) lands in the first read, and must not become text.
 * A number is required straight after `ESC ]`, so Alt-] followed by a letter still
 * decodes as Alt-] and the letter.
 */
const OSC_RE = new RegExp(`^${ESC}\\](\\d+)(;[^\\x07${ESC}]*)?(\\x07|${ESC}\\\\)`)
/** An OSC reply with no terminator yet, held until the rest arrives. */
const PARTIAL_OSC_RE = new RegExp(`^${ESC}\\](\\d+(;[^\\x07${ESC}]*)?${ESC}?)?$`)
/** Longest OSC reply held while waiting for its terminator; past it, the bytes are input. */
const MAX_OSC = 1024

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

/**
 * Ask the terminal to report modified keys it would otherwise send as the plain key
 * (xterm's modifyOtherKeys, level 1). The one the composer needs is Shift-Enter:
 * without it a terminal sends a bare CR, indistinguishable from Enter. Level 1 leaves
 * every key with a conventional meaning (Ctrl-letters, Alt-letters) as it was, and a
 * terminal that does not know the sequence ignores it.
 */
export const ENABLE_MODIFIED_KEYS = '\x1b[>4;1m'
export const DISABLE_MODIFIED_KEYS = '\x1b[>4;0m'
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
 * `sanitizePastedKeys` for named keys: the same window, and inside it no key keeps
 * its name, so clipboard bytes can never trigger a user keybinding (a bound slash
 * command least of all).
 */
export function sanitizePastedNamed(
  entries: NamedKey[],
  lastPasteAt: number,
  now: number,
  windowMs = 50
): { entries: NamedKey[]; lastPasteAt: number } {
  let last = lastPasteAt
  const out: NamedKey[] = []
  for (const e of entries) {
    if (e.key?.type === 'paste') {
      last = now
      out.push({ key: e.key, name: null })
      continue
    }
    if (now - last >= windowMs) {
      out.push(e)
      continue
    }
    if (!e.key) continue
    if (e.key.type === 'enter') out.push({ key: { type: 'newline' }, name: null })
    else if (PASTE_SAFE_KEYS.has(e.key.type)) out.push({ key: e.key, name: null })
  }
  return { entries: out, lastPasteAt: last }
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

/**
 * Enter as a terminal reports it with modifiers: xterm's modifyOtherKeys form
 * (`CSI 27;<mod>;13~`) or the CSI-u form (`CSI 13;<mod>u`). Any modifier (Shift,
 * Alt, Ctrl) means "new line"; the unmodified report is Enter. Null when the
 * sequence is not Enter at all.
 */
function modifiedEnter(params: string, final: string): EditorKey | null {
  let mod: string | undefined
  if (final === '~') mod = /^27;([0-9]+);13$/.exec(params)?.[1]
  else if (final === 'u') {
    const m = /^13(?:;([0-9]+))?$/.exec(params)
    if (!m) return null
    mod = m[1] ?? '1'
  }
  if (mod === undefined) return null
  return Number(mod) > 1 ? { type: 'newline' } : { type: 'enter' }
}

/**
 * Undo and redo reported in the extended forms (`CSI 27;5;<code>~` from
 * modifyOtherKeys, `CSI <code>;5u` from CSI-u). A terminal can switch Ctrl-/ and
 * Ctrl-6 to these once modified-key reporting is on, and then the undo key would go
 * dead on exactly the terminals that report Shift-Enter. Only Ctrl alone (modifier
 * 5), and only the keys that mean undo (`/`, `-`, `_`) or redo (`6`, `^`): every
 * other modified key stays ignored.
 */
function modifiedUndoKey(params: string, final: string): EditorKey | null {
  let code: number | undefined
  if (final === '~') {
    const m = /^27;5;([0-9]+)$/.exec(params)
    if (m) code = Number(m[1])
  } else if (final === 'u') {
    const m = /^([0-9]+);5$/.exec(params)
    if (m) code = Number(m[1])
  }
  if (code === 0x2f || code === 0x2d || code === 0x5f) return { type: 'undo' }
  if (code === 0x36 || code === 0x5e) return { type: 'redo' }
  return null
}

/** CSI final-byte lookup for the cursor/edit keys the composer cares about. */
function csiKey(params: string, final: string): EditorKey | null {
  const enter = modifiedEnter(params, final)
  if (enter) return enter
  const ctrl = modifiedUndoKey(params, final)
  if (ctrl) return ctrl
  // Modified keys arrive as `1;<mod><final>`: 5 = Ctrl, 3 = Alt. Both mean word-wise.
  const mod = /^1;([0-9]+)$/.exec(params)?.[1]
  const wordwise = mod === '5' || mod === '3'
  switch (final) {
    // Focus reporting (mode 1004). Only ever sent with no params, which keeps
    // these distinct from any modified cursor key.
    // Shift-Tab (backtab). Conventionally "the other Tab", which is why it is the
    // mode key: Tab completes, Shift-Tab changes how much runs without asking.
    case 'Z':
      return { type: 'cycle-mode' }
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
        case '5':
          return { type: 'page-up' }
        case '6':
          return { type: 'page-down' }
        default:
          return null // function keys: ignored
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
      return { type: 'left', ctrlB: true }
    case '\x03':
      return { type: 'interrupt' }
    case '\x04':
      return { type: 'eof' }
    case '\x05':
      return { type: 'end' }
    case '\x06':
      return { type: 'right' }
    case '\x07':
      return { type: 'external-edit' } // Ctrl-G
    case '\x0b':
      return { type: 'kill-line' }
    case '\x0c':
      return { type: 'clear-screen' }
    case '\x0e':
      return { type: 'down' }
    case '\x0f':
      return { type: 'transcript' } // Ctrl-O
    case '\x10':
      return { type: 'up' }
    case '\x12':
      return { type: 'search' }
    case '\x13':
      return { type: 'stash' } // Ctrl-S (raw mode turns XON/XOFF flow control off)
    case '\x15':
      return { type: 'kill-to-start' }
    case '\x17':
      return { type: 'kill-word' }
    case '\x16':
      return { type: 'paste-image' } // Ctrl-V
    case '\x19':
      return { type: 'yank' }
    case '\x1a':
      return { type: 'suspend' } // Ctrl-Z (raw mode turns the tty's own SIGTSTP off)
    case '\x1e':
      return { type: 'redo' } // Ctrl-^
    case '\x1f':
      return { type: 'undo' } // Ctrl-_
    default:
      return null
  }
}

/**
 * A decoded key with the name of the physical key that sent it (`ctrl-k`, `alt-b`,
 * `up`, `f5`, `q`), for user keybindings. `key` is null for a key the composer does
 * not bind (Ctrl-T, Alt-X, a function key), which still has a name a binding can
 * claim; `name` is null for what no binding may claim (text runs, pastes, focus).
 */
export interface NamedKey {
  key: EditorKey | null
  name: string | null
}

/** The name of a control byte, as a keybinding spells it. */
export function controlName(ch: string): string | null {
  const c = ch.charCodeAt(0)
  switch (c) {
    case 0x00:
      return 'ctrl-space'
    case 0x08:
    case 0x7f:
      return 'backspace'
    case 0x09:
      return 'tab'
    case 0x0d:
      return 'enter'
    case 0x1c:
      return 'ctrl-\\'
    case 0x1d:
      return 'ctrl-]'
    case 0x1e:
      return 'ctrl-^'
    case 0x1f:
      return 'ctrl-_'
    default:
      return c >= 1 && c <= 26 ? `ctrl-${String.fromCharCode(c + 96)}` : null
  }
}

/** A modifier parameter (xterm's 1 + bits) as a name prefix: 2 shift, 3 alt, 5 ctrl. */
function modPrefix(mod: string | undefined): string | null {
  switch (mod) {
    case undefined:
    case '1':
      return ''
    case '2':
      return 'shift-'
    case '3':
      return 'alt-'
    case '5':
      return 'ctrl-'
    default:
      return null
  }
}

const TILDE_NAMES: Record<string, string> = {
  '1': 'home', '3': 'delete', '4': 'end', '5': 'pageup', '6': 'pagedown', '7': 'home', '8': 'end',
  '11': 'f1', '12': 'f2', '13': 'f3', '14': 'f4', '15': 'f5', '17': 'f6', '18': 'f7', '19': 'f8',
  '20': 'f9', '21': 'f10', '23': 'f11', '24': 'f12'
}
const FINAL_NAMES: Record<string, string> = {
  A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', P: 'f1', Q: 'f2', R: 'f3', S: 'f4'
}

/** Enter's modifier in the modifyOtherKeys or CSI-u report, or undefined when it isn't Enter. */
function enterModifier(params: string, final: string): string | undefined {
  if (final === '~') return /^27;([0-9]+);13$/.exec(params)?.[1]
  if (final !== 'u') return undefined
  const m = /^13(?:;([0-9]+))?$/.exec(params)
  return m ? (m[1] ?? '1') : undefined
}

/** The name of a CSI (or SS3, with no params) sequence, or null for one no binding can claim. */
export function csiName(params: string, final: string): string | null {
  if (final === 'Z') return 'shift-tab'
  if ((final === 'I' || final === 'O') && params === '') return null // focus reports
  const enterMod = enterModifier(params, final)
  if (enterMod !== undefined) {
    const pre = modPrefix(enterMod)
    return pre === null ? null : `${pre}enter`
  }
  const undo = modifiedUndoKey(params, final)
  if (undo) return undo.type === 'undo' ? 'ctrl-_' : 'ctrl-^'
  if (final === '~') {
    const [code, mod] = params.split(';')
    const base = TILDE_NAMES[code]
    const pre = modPrefix(mod)
    return base && pre !== null ? pre + base : null
  }
  const base = FINAL_NAMES[final]
  if (!base) return null
  const mod = params === '' ? undefined : /^1;([0-9]+)$/.exec(params)?.[1]
  if (params !== '' && mod === undefined) return null
  const pre = modPrefix(mod)
  return pre === null ? null : pre + base
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
  state: DecoderState,
  opts: { named?: boolean } = {}
): { keys: EditorKey[]; state: DecoderState; named: NamedKey[] } {
  const keys: EditorKey[] = []
  const named: NamedKey[] = []
  const next: DecoderState = { ...state }
  let buf = next.pending + chunk
  next.pending = ''
  const pasted = chunk.length > 16 && /[\r\n]/.test(chunk)
  // Naming is only asked for when user keybindings are on. Nothing in an
  // unbracketed paste burst gets a name, so a paste can never fire a binding.
  const naming = opts.named === true
  const emit = (key: EditorKey | null, name: string | null): void => {
    if (key) keys.push(key)
    if (naming) named.push({ key, name: pasted ? null : name })
  }

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
      emit({ type: 'paste', value: normalizePaste(next.pasteBuf) }, null)
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
      const osc = OSC_RE.exec(buf)
      if (osc) {
        buf = buf.slice(osc[0].length)
        continue
      }
      if (buf.length > 1 && buf.length <= MAX_OSC && PARTIAL_OSC_RE.test(buf)) {
        next.pending = buf
        break
      }
      const csi = CSI_RE.exec(buf)
      if (csi) {
        const key = csiKey(csi[1], csi[2])
        if (key || naming) emit(key, csiName(csi[1], csi[2]))
        buf = buf.slice(csi[0].length)
        continue
      }
      const ss3 = SS3_RE.exec(buf)
      if (ss3) {
        const key = csiKey('', ss3[1])
        if (key || naming) emit(key, csiName('', ss3[1]))
        buf = buf.slice(ss3[0].length)
        continue
      }
      // An introducer with no final byte yet — hold it. (`ESC` alone is deliberately
      // excluded: that's the Escape key, emitted below.)
      if (PARTIAL_SEQ_RE.test(buf)) {
        next.pending = buf
        break
      }
      // Two Escapes in one read (a fast double press): both are the Escape key.
      if (buf === ESC + ESC) {
        emit({ type: 'escape' }, 'escape')
        emit({ type: 'escape' }, 'escape')
        buf = ''
        continue
      }
      // ESC + char = Alt-<char>.
      const alt = buf[1]
      if (alt !== undefined) {
        buf = buf.slice(2)
        const altName =
          alt === '\x7f' || alt === '\b'
            ? 'alt-backspace'
            : alt === '\r' || alt === '\n'
              ? 'alt-enter'
              : alt === ' '
                ? 'alt-space'
                : alt > ' ' && !isC1(alt)
                  ? `alt-${alt}`
                  : null
        if (alt === 'b' || alt === 'B') emit({ type: 'word-left' }, altName)
        // Alt-V: the image-paste key where the terminal keeps Ctrl-V for itself.
        else if (alt === 'v' || alt === 'V') emit({ type: 'paste-image' }, altName)
        else if (alt === 'f' || alt === 'F') emit({ type: 'word-right' }, altName)
        else if (alt === '\x7f' || alt === '\b') emit({ type: 'kill-word' }, altName)
        else if (alt === '\r' || alt === '\n') emit({ type: 'newline' }, altName)
        else if (alt === 't' || alt === 'T') emit({ type: 'cycle-thoughts' }, altName)
        else if (alt === 'p' || alt === 'P') emit({ type: 'expand-paste' }, altName)
        // Any other Alt-combo is unbound: swallow it rather than inserting the char.
        else if (naming) emit(null, altName)
        continue
      }
      // A lone ESC in its own chunk is the Escape key.
      emit({ type: 'escape' }, 'escape')
      buf = buf.slice(1)
      continue
    }

    if (ch < ' ' || ch === '\x7f') {
      buf = buf.slice(1)
      // With keybindings on, chords (Ctrl-X Ctrl-E among them) are the keybinding
      // layer's to resolve, so every control key is reported as itself.
      if (naming) {
        emit(controlKey(ch, pasted), controlName(ch))
        continue
      }
      // Ctrl-X Ctrl-E hands the draft to $EDITOR (Ctrl-G does too, see controlKey);
      // Ctrl-X alone is a dead prefix.
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
        if (ch === '\x10') {
          keys.push({ type: 'expand-paste' }) // Ctrl-X Ctrl-P
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
    const run = buf.slice(0, i)
    emit({ type: 'char', value: run }, [...run].length === 1 ? (run === ' ' ? 'space' : run) : null)
    buf = buf.slice(i)
  }

  return { keys, state: next, named }
}
