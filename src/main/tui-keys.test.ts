import { describe, it, expect } from 'vitest'
import {
  decodeInput,
  initialDecoderState,
  normalizePaste,
  sanitizePastedKeys,
  PASTE_START,
  PASTE_END,
  type EditorKey,
  type DecoderState
} from './tui-keys'

/** Decode a series of chunks through one decoder, returning every key produced. */
function feed(...chunks: string[]): EditorKey[] {
  let state: DecoderState = initialDecoderState()
  const keys: EditorKey[] = []
  for (const c of chunks) {
    const r = decodeInput(c, state)
    state = r.state
    keys.push(...r.keys)
  }
  return keys
}

describe('decodeInput — text', () => {
  it('coalesces a printable run into one key', () => {
    expect(feed('hello')).toEqual([{ type: 'char', value: 'hello' }])
  })

  it('decodes Enter as submit and Ctrl-J as a literal newline', () => {
    expect(feed('\r')).toEqual([{ type: 'enter' }])
    expect(feed('\n')).toEqual([{ type: 'newline' }])
  })

  it('splits a printable run at a control byte', () => {
    expect(feed('ab\rcd')).toEqual([
      { type: 'char', value: 'ab' },
      { type: 'enter' },
      { type: 'char', value: 'cd' }
    ])
  })

  it('keeps multi-byte characters intact', () => {
    expect(feed('héllo → 🚀')).toEqual([{ type: 'char', value: 'héllo → 🚀' }])
  })
})

describe('decodeInput — bracketed paste', () => {
  it('delivers a bracketed paste as ONE key, newlines and all', () => {
    const keys = feed(`${PASTE_START}line one\nline two\nline three${PASTE_END}`)
    expect(keys).toEqual([{ type: 'paste', value: 'line one\nline two\nline three' }])
  })

  // The regression that lost data: a pasted block must never submit at its first
  // line break. Inside a paste, CR is content — not Enter.
  it('never emits enter for a line break inside a paste', () => {
    const keys = feed(`${PASTE_START}a\r\nb${PASTE_END}`)
    expect(keys).toEqual([{ type: 'paste', value: 'a\nb' }])
    expect(keys.some((k) => k.type === 'enter')).toBe(false)
  })

  it('reassembles a paste split across chunks', () => {
    expect(feed(`${PASTE_START}one\ntw`, `o\nthree${PASTE_END}`)).toEqual([
      { type: 'paste', value: 'one\ntwo\nthree' }
    ])
  })

  it('reassembles a paste whose END marker is split across chunks', () => {
    expect(feed(`${PASTE_START}body\x1b[20`, `1~`)).toEqual([{ type: 'paste', value: 'body' }])
  })

  it('reassembles a paste whose START marker is split across chunks', () => {
    expect(feed('\x1b[2', `00~body${PASTE_END}`)).toEqual([{ type: 'paste', value: 'body' }])
  })

  it('keeps decoding normally after a paste ends', () => {
    expect(feed(`${PASTE_START}x${PASTE_END}\r`)).toEqual([
      { type: 'paste', value: 'x' },
      { type: 'enter' }
    ])
  })

  it('treats a big multi-line burst as pasted even without bracketing', () => {
    // Terminals send real keystrokes one at a time, so a large chunk containing a
    // line break can only be a paste — the safety net for terminals with no DEC 2004.
    const keys = feed('first line of a pasted block\rsecond line of it\r')
    expect(keys.some((k) => k.type === 'enter')).toBe(false)
    expect(keys.filter((k) => k.type === 'newline')).toHaveLength(2)
  })

  it('still submits on a short line ending in Enter', () => {
    expect(feed('hi\r')).toEqual([{ type: 'char', value: 'hi' }, { type: 'enter' }])
  })
})

describe('decodeInput — navigation and editing keys', () => {
  it('decodes arrows (CSI and SS3 forms)', () => {
    expect(feed('\x1b[A\x1b[B\x1b[C\x1b[D')).toEqual([
      { type: 'up' },
      { type: 'down' },
      { type: 'right' },
      { type: 'left' }
    ])
    expect(feed('\x1bOA\x1bOD')).toEqual([{ type: 'up' }, { type: 'left' }])
  })

  it('decodes ctrl/alt arrows as word motions', () => {
    expect(feed('\x1b[1;5C\x1b[1;5D\x1b[1;3C')).toEqual([
      { type: 'word-right' },
      { type: 'word-left' },
      { type: 'word-right' }
    ])
  })

  it('decodes home/end/delete in both forms', () => {
    expect(feed('\x1b[H\x1b[F\x1b[3~\x1b[1~\x1b[4~')).toEqual([
      { type: 'home' },
      { type: 'end' },
      { type: 'delete' },
      { type: 'home' },
      { type: 'end' }
    ])
  })

  it('decodes the emacs control keys', () => {
    expect(feed('\x01\x05\x0b\x15\x17\x19\x12\x0c\x7f')).toEqual([
      { type: 'home' },
      { type: 'end' },
      { type: 'kill-line' },
      { type: 'kill-to-start' },
      { type: 'kill-word' },
      { type: 'yank' },
      { type: 'search' },
      { type: 'clear-screen' },
      { type: 'backspace' }
    ])
  })

  it('decodes Alt-b / Alt-f / Alt-Backspace / Alt-Enter', () => {
    expect(feed('\x1bb\x1bf\x1b\x7f\x1b\r')).toEqual([
      { type: 'word-left' },
      { type: 'word-right' },
      { type: 'kill-word' },
      { type: 'newline' }
    ])
  })

  it('decodes interrupt and eof', () => {
    expect(feed('\x03\x04')).toEqual([{ type: 'interrupt' }, { type: 'eof' }])
  })

  it('decodes Ctrl-X Ctrl-E as the editor hand-off, and Ctrl-X alone as nothing', () => {
    expect(feed('\x18\x05')).toEqual([{ type: 'external-edit' }])
    expect(feed('\x18')).toEqual([])
  })

  it('treats a lone ESC as Escape but ESC+key as a combo', () => {
    expect(feed('\x1b')).toEqual([{ type: 'escape' }])
    expect(feed('\x1bb')).toEqual([{ type: 'word-left' }])
  })

  it('holds an incomplete escape sequence until the rest arrives', () => {
    expect(feed('\x1b[')).toEqual([])
    expect(feed('\x1b[', 'A')).toEqual([{ type: 'up' }])
  })

  it('swallows unbound sequences instead of inserting their bytes', () => {
    // Page-up and an unbound Alt-combo must not leak "[5~" / "z" into the buffer.
    expect(feed('\x1b[5~')).toEqual([])
    expect(feed('\x1bz')).toEqual([])
  })
})

describe('normalizePaste', () => {
  it('normalizes CRLF and CR to newlines', () => {
    expect(normalizePaste('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('strips control characters but keeps newlines and tabs', () => {
    expect(normalizePaste('a\x1b[31mb\x00c\td\ne')).toBe('a[31mbc\td\ne')
  })

  // The composer echoes its buffer on every redraw, so anything the clipboard
  // smuggles in is handed back to the terminal to execute.
  it('strips 8-bit C1 introducers, not just 7-bit ESC', () => {
    // U+009B is CSI and U+009D is OSC: an ESC-free way to reach the terminal.
    expect(normalizePaste('a\u009b31mred\u009d0;title')).toBe('a31mred0;title')
  })

  it('strips BEL, which terminates an OSC payload', () => {
    expect(normalizePaste('safe\x07text')).toBe('safetext')
  })
})

describe('decodeInput — C1 controls', () => {
  it('drops C1 introducers from typed input instead of buffering them', () => {
    expect(feed('ab\u009b31mc')).toEqual([
      { type: 'char', value: 'ab' },
      { type: 'char', value: '31mc' }
    ])
  })
})

describe('sanitizePastedKeys', () => {
  const T0 = 1000
  const enter: EditorKey[] = [{ type: 'enter' }]

  it('passes keys through once the paste burst is over', () => {
    const r = sanitizePastedKeys(enter, T0, T0 + 500)
    expect(r.keys).toEqual([{ type: 'enter' }])
  })

  it('degrades Enter to a line break inside the post-paste window', () => {
    const r = sanitizePastedKeys(enter, T0, T0 + 5)
    expect(r.keys).toEqual([{ type: 'newline' }])
  })

  it('drops action keys inside the window but keeps content', () => {
    const keys: EditorKey[] = [
      { type: 'char', value: 'text' },
      { type: 'external-edit' },
      { type: 'eof' },
      { type: 'interrupt' },
      { type: 'kill-to-start' },
      { type: 'search' },
      { type: 'newline' }
    ]
    const r = sanitizePastedKeys(keys, T0, T0 + 5)
    expect(r.keys).toEqual([{ type: 'char', value: 'text' }, { type: 'newline' }])
  })

  it('starts the window at the paste in the same batch', () => {
    // The attack shape: paste, then the body's own end marker frees a live CR.
    const keys: EditorKey[] = [{ type: 'paste', value: 'payload' }, { type: 'enter' }]
    const r = sanitizePastedKeys(keys, -Infinity, T0)
    expect(r.keys).toEqual([{ type: 'paste', value: 'payload' }, { type: 'newline' }])
    expect(r.lastPasteAt).toBe(T0)
  })

  it('keeps keys typed before a paste in the same batch', () => {
    const keys: EditorKey[] = [{ type: 'enter' }, { type: 'paste', value: 'x' }]
    const r = sanitizePastedKeys(keys, -Infinity, T0)
    expect(r.keys[0]).toEqual({ type: 'enter' })
  })

  it('carries the window across chunks', () => {
    // A CR arriving in a LATER chunk is still clipboard-driven if it is close enough.
    const first = sanitizePastedKeys([{ type: 'paste', value: 'x' }], -Infinity, T0)
    const second = sanitizePastedKeys(enter, first.lastPasteAt, T0 + 2)
    expect(second.keys).toEqual([{ type: 'newline' }])
  })
})

describe('decodeInput — focus reporting (mode 1004)', () => {
  it('decodes focus in / focus out', () => {
    expect(feed('\x1b[I')).toEqual([{ type: 'focus', on: true }])
    expect(feed('\x1b[O')).toEqual([{ type: 'focus', on: false }])
  })

  it('does not mistake a modified cursor key for a focus report', () => {
    // CSI O with params is not focus; only the bare form is.
    expect(feed('\x1b[1;5I')).toEqual([])
  })

  it('keeps SS3 cursor keys working alongside it', () => {
    expect(feed('\x1bOA')).toEqual([{ type: 'up' }])
  })
})

describe('decodeInput — Shift-Tab', () => {
  it('decodes backtab as the mode key', () => {
    expect(feed('\x1b[Z')).toEqual([{ type: 'cycle-mode' }])
  })

  it('keeps plain Tab as completion', () => {
    expect(feed('\t')).toEqual([{ type: 'tab' }])
  })

  // Changing how much runs without asking is an action, so a pasted tail must not
  // be able to trigger it.
  it('is dropped inside the post-paste window', () => {
    const r = sanitizePastedKeys([{ type: 'cycle-mode' }], 1000, 1005)
    expect(r.keys).toEqual([])
  })
})
