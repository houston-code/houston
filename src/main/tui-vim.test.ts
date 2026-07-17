import { describe, it, expect } from 'vitest'
import { initialVimState, reduceVim, vimStatus, type VimState } from './tui-vim'
import { initialEditorState, editorText, setEditorText, type EditorState } from './tui-editor'
import { makePainter } from './tui'
import type { EditorKey } from './tui-keys'

const paint = makePainter(false)

/** A buffer with the cursor at row/col, in normal mode. */
function at(text: string, row = 0, col = 0): { vim: VimState; state: EditorState } {
  const state = { ...setEditorText(initialEditorState(), text), row, col }
  return { vim: { ...initialVimState(), mode: 'normal' }, state }
}

/** Feed keys; a bare string is typed as characters. */
function keys(
  start: { vim: VimState; state: EditorState },
  ...ks: (string | EditorKey)[]
): { vim: VimState; state: EditorState; text: string; outcome?: unknown } {
  let cur: { vim: VimState; state: EditorState; outcome?: unknown } = start
  for (const k of ks) {
    const key: EditorKey = typeof k === 'string' ? { type: 'char', value: k } : k
    const r = reduceVim(cur.vim, cur.state, key)
    cur = r
  }
  return { ...cur, text: editorText(cur.state) }
}

/** Where the cursor ended up, as `row:col`. */
const cursor = (r: { state: EditorState }): string => `${r.state.row}:${r.state.col}`

describe('modes', () => {
  it('starts in insert so vim mode does not surprise a normal typist mid-draft', () => {
    expect(initialVimState().mode).toBe('insert')
  })

  it('Esc leaves insert, i comes back', () => {
    const s = { vim: initialVimState(), state: initialEditorState() }
    const typed = keys(s, 'hello')
    expect(typed.text).toBe('hello')
    const normal = keys(typed, { type: 'escape' })
    expect(normal.vim.mode).toBe('normal')
    // Normal mode's cursor sits ON a character, never past the end.
    expect(cursor(normal)).toBe('0:4')
    const back = keys(normal, 'i')
    expect(back.vim.mode).toBe('normal' === back.vim.mode ? 'normal' : 'insert')
    expect(back.vim.mode).toBe('insert')
  })

  it('normal-mode keys are commands, not text', () => {
    const r = keys(at('abc'), 'x')
    expect(r.text).toBe('bc')
  })

  it('insert-mode keys are text, not commands', () => {
    const r = keys({ vim: initialVimState(), state: initialEditorState() }, 'x')
    expect(r.text).toBe('x')
  })

  it('shows which mode you are in', () => {
    expect(vimStatus('normal', paint)).toContain('N')
    expect(vimStatus('insert', paint)).toContain('I')
  })
})

describe('motions', () => {
  it('h j k l move, and stop at the edges', () => {
    expect(cursor(keys(at('abc', 0, 1), 'l'))).toBe('0:2')
    expect(cursor(keys(at('abc', 0, 1), 'h'))).toBe('0:0')
    expect(cursor(keys(at('abc', 0, 0), 'h'))).toBe('0:0') // no wrap off the front
    expect(cursor(keys(at('abc', 0, 2), 'l'))).toBe('0:2') // `l` stops on the last char
    expect(cursor(keys(at('ab\ncd', 0, 1), 'j'))).toBe('1:1')
    expect(cursor(keys(at('ab\ncd', 1, 1), 'k'))).toBe('0:1')
  })

  it('0 ^ $ reach the ends of a line', () => {
    expect(cursor(keys(at('  ab', 0, 3), '0'))).toBe('0:0')
    expect(cursor(keys(at('  ab', 0, 0), '^'))).toBe('0:2')
    expect(cursor(keys(at('abc', 0, 0), '$'))).toBe('0:2')
  })

  // The one real difference between w and W.
  it('w stops at punctuation, W only at whitespace', () => {
    expect(cursor(keys(at('foo.bar baz', 0, 0), 'w'))).toBe('0:3')
    expect(cursor(keys(at('foo.bar baz', 0, 0), 'W'))).toBe('0:8')
  })

  it('b goes back a word, e to the end of one', () => {
    expect(cursor(keys(at('foo bar', 0, 4), 'b'))).toBe('0:0')
    expect(cursor(keys(at('foo bar', 0, 0), 'e'))).toBe('0:2')
    expect(cursor(keys(at('foo bar', 0, 2), 'e'))).toBe('0:6')
  })

  // A line break is just another blank to a word motion.
  it('word motions cross lines', () => {
    expect(cursor(keys(at('foo\nbar', 0, 1), 'w'))).toBe('1:0')
    expect(cursor(keys(at('foo\nbar', 1, 0), 'b'))).toBe('0:0')
  })

  it('gg and G go to the first and last line', () => {
    expect(cursor(keys(at('a\nb\nc', 2, 0), 'g', 'g'))).toBe('0:0')
    expect(cursor(keys(at('a\nb\nc', 0, 0), 'G'))).toBe('2:0')
    // A count makes gg absolute.
    expect(cursor(keys(at('a\nb\nc', 0, 0), '2', 'g', 'g'))).toBe('1:0')
  })

  it('counts multiply a motion', () => {
    expect(cursor(keys(at('a b c d', 0, 0), '3', 'w'))).toBe('0:6')
    expect(cursor(keys(at('abcdef', 0, 0), '3', 'l'))).toBe('0:3')
    expect(cursor(keys(at('a\nb\nc\nd', 0, 0), '2', 'j'))).toBe('2:0')
  })

  // A leading 0 is the motion; a trailing one is part of the count.
  it('tells the 0 motion from a 0 inside a count', () => {
    expect(cursor(keys(at('abcdefghijkl', 0, 5), '0'))).toBe('0:0')
    expect(cursor(keys(at('abcdefghijkl', 0, 0), '1', '0', 'l'))).toBe('0:10')
  })
})

describe('entering insert', () => {
  it('i a I A put the cursor where their names say', () => {
    expect(cursor(keys(at('ab', 0, 0), 'i'))).toBe('0:0')
    expect(cursor(keys(at('ab', 0, 0), 'a'))).toBe('0:1')
    expect(cursor(keys(at('  ab', 0, 3), 'I'))).toBe('0:2')
    expect(cursor(keys(at('ab', 0, 0), 'A'))).toBe('0:2')
    for (const k of ['i', 'a', 'I', 'A']) expect(keys(at('ab'), k).vim.mode).toBe('insert')
  })

  it('o and O open a line below and above', () => {
    const below = keys(at('a\nb', 0, 0), 'o', 'x')
    expect(below.text).toBe('a\nx\nb')
    const above = keys(at('a\nb', 1, 0), 'O', 'x')
    expect(above.text).toBe('a\nx\nb')
  })

  it('s takes the character and leaves you typing', () => {
    const r = keys(at('abc', 0, 0), 's', 'X')
    expect(r.text).toBe('Xbc')
    expect(r.vim.mode).toBe('insert')
  })
})

describe('deleting and changing', () => {
  it('x and X take a character either side of the cursor', () => {
    expect(keys(at('abc', 0, 1), 'x').text).toBe('ac')
    expect(keys(at('abc', 0, 1), 'X').text).toBe('bc')
    expect(keys(at('abcde', 0, 0), '3', 'x').text).toBe('de')
  })

  // The classic way to lose a line break by accident.
  it('x never eats the line break', () => {
    expect(keys(at('ab\ncd', 0, 1), '5', 'x').text).toBe('a\ncd')
  })

  it('D and C clear to the end of the line', () => {
    expect(keys(at('abcd', 0, 2), 'D').text).toBe('ab')
    const c = keys(at('abcd', 0, 2), 'C', 'X')
    expect(c.text).toBe('abX')
    expect(c.vim.mode).toBe('insert')
  })

  it('dw deletes a word, dd a line', () => {
    expect(keys(at('foo bar', 0, 0), 'd', 'w').text).toBe('bar')
    expect(keys(at('a\nb\nc', 1, 0), 'd', 'd').text).toBe('a\nc')
  })

  it('cc empties the line but keeps it', () => {
    const r = keys(at('a\nbbb\nc', 1, 1), 'c', 'c')
    expect(r.text).toBe('a\n\nc')
    expect(r.vim.mode).toBe('insert')
    expect(cursor(r)).toBe('1:0')
  })

  it('cw changes a word and leaves you typing', () => {
    const r = keys(at('foo bar', 0, 0), 'c', 'w', 'X')
    expect(r.text).toBe('Xbar')
    expect(r.vim.mode).toBe('insert')
  })

  it('d$ and d0 cut to the ends of the line', () => {
    expect(keys(at('abcd', 0, 2), 'd', '$').text).toBe('ab')
    expect(keys(at('abcd', 0, 2), 'd', '0').text).toBe('cd')
  })

  // e is inclusive: it takes the character it lands on.
  it('de takes the whole word, not all but its last letter', () => {
    expect(keys(at('foo bar', 0, 0), 'd', 'e').text).toBe(' bar')
  })

  it('dj takes both lines, because j is linewise', () => {
    expect(keys(at('a\nb\nc', 0, 0), 'd', 'j').text).toBe('c')
  })

  it('counts work on both sides of the operator', () => {
    expect(keys(at('a b c d', 0, 0), '2', 'd', 'w').text).toBe('c d')
    expect(keys(at('a b c d', 0, 0), 'd', '2', 'w').text).toBe('c d')
    expect(keys(at('a\nb\nc\nd', 0, 0), '2', 'd', 'd').text).toBe('c\nd')
  })

  // Vim discards the whole command rather than guessing.
  it('an operator followed by a non-motion does nothing', () => {
    const r = keys(at('abc', 0, 0), 'd', 'z')
    expect(r.text).toBe('abc')
    expect(r.vim.pending).toBe('')
  })
})

describe('yank and put', () => {
  it('yy then p puts the line below', () => {
    const r = keys(at('a\nb', 0, 0), 'y', 'y', 'p')
    expect(r.text).toBe('a\na\nb')
  })

  it('P puts a yanked line above', () => {
    expect(keys(at('a\nb', 1, 0), 'y', 'y', 'P').text).toBe('a\nb\nb')
  })

  it('a charwise yank puts after the cursor', () => {
    const r = keys(at('ab', 0, 0), 'y', 'l', 'p')
    expect(r.text).toBe('aab')
  })

  it('dd then p moves a line', () => {
    expect(keys(at('a\nb\nc', 0, 0), 'd', 'd', 'p').text).toBe('b\na\nc')
  })

  it('yank leaves the text alone and the cursor at the start of it', () => {
    const r = keys(at('foo bar', 0, 4), 'y', 'w')
    expect(r.text).toBe('foo bar')
    expect(cursor(r)).toBe('0:4')
  })

  it('p with an empty register does nothing', () => {
    expect(keys(at('ab', 0, 0), 'p').text).toBe('ab')
  })

  it('a count repeats the put', () => {
    expect(keys(at('a', 0, 0), 'y', 'y', '2', 'p').text).toBe('a\na\na')
  })
})

describe('r', () => {
  it('replaces the character under the cursor and stays in normal mode', () => {
    const r = keys(at('abc', 0, 1), 'r', 'X')
    expect(r.text).toBe('aXc')
    expect(r.vim.mode).toBe('normal')
  })

  it('takes its replacement literally, even a key that would be a command', () => {
    expect(keys(at('abc', 0, 0), 'r', 'd').text).toBe('dbc')
    expect(keys(at('abc', 0, 0), 'r', 'x').text).toBe('xbc')
  })

  it('refuses rather than pad when the count runs past the line', () => {
    expect(keys(at('abc', 0, 1), '5', 'r', 'X').text).toBe('abc')
  })
})

describe('u', () => {
  it('undoes the last change', () => {
    const r = keys(at('abc', 0, 0), 'x', 'u')
    expect(r.text).toBe('abc')
  })

  it('undoes a whole insert session, not one character', () => {
    const r = keys(at('abc', 0, 0), 'i', 'XY', { type: 'escape' }, 'u')
    expect(r.text).toBe('abc')
  })

  it('steps back through several changes', () => {
    const r = keys(at('abcd', 0, 0), 'x', 'x', 'u')
    expect(r.text).toBe('bcd')
    expect(keys(at('abcd', 0, 0), 'x', 'x', 'u', 'u').text).toBe('abcd')
  })

  it('does nothing with nothing to undo', () => {
    expect(keys(at('abc', 0, 0), 'u').text).toBe('abc')
  })
})

describe('pending commands', () => {
  it('holds a half-typed command until it means something', () => {
    const r = keys(at('abc', 0, 0), '1', '2')
    expect(r.vim.pending).toBe('12')
    expect(r.text).toBe('abc')
  })

  it('Esc abandons a half-typed command without touching the buffer', () => {
    const r = keys(at('abc', 0, 0), '2', 'd', { type: 'escape' })
    expect(r.vim.pending).toBe('')
    expect(r.text).toBe('abc')
    // …and the next key is read fresh, not as the tail of the abandoned one.
    expect(keys(r, 'x').text).toBe('bc')
  })

  it('an unknown key is dropped quietly', () => {
    const r = keys(at('abc', 0, 0), 'z')
    expect(r.text).toBe('abc')
    expect(r.vim.pending).toBe('')
  })
})

describe('what normal mode leaves to the editor', () => {
  // The whole point of a modal layer over the editor rather than beside it: submit,
  // interrupt and history must not be reimplemented per mode.
  it('Enter submits from normal mode too', () => {
    const r = keys(at('hello', 0, 0), { type: 'enter' })
    expect(r.outcome).toEqual({ kind: 'submit', text: 'hello' })
  })

  it('Ctrl-C interrupts from normal mode', () => {
    const r = keys(at('hello', 0, 0), { type: 'interrupt' })
    expect(r.outcome).toEqual({ kind: 'interrupt' })
  })

  it('a paste is text in either mode, never a run of commands', () => {
    const r = keys(at('', 0, 0), { type: 'paste', value: 'dd' })
    expect(r.text).toBe('dd')
  })

  it('arrows work in normal mode, clamped to the line', () => {
    expect(cursor(keys(at('ab', 0, 0), { type: 'right' }))).toBe('0:1')
    expect(cursor(keys(at('ab', 0, 1), { type: 'end' }))).toBe('0:1')
  })

  // Ctrl-R is its own modal state and owns every key while it is up.
  it('reverse-search keeps its keys away from normal mode', () => {
    const start = at('', 0, 0)
    const searching = keys(start, { type: 'search' })
    expect(searching.state.search).not.toBeNull()
    const typed = keys(searching, 'd')
    expect(typed.state.search?.query).toBe('d')
  })
})

/**
 * A terminal without bracketed paste delivers a paste as ordinary keystrokes, and
 * in normal mode a keystroke is a command. So a pasted digit run reaches a count,
 * and an unbounded count is an out-of-memory or a hung composer from a paste.
 */
describe('a hostile count', () => {
  it('cannot make p repeat a register into out-of-memory', () => {
    const yanked = keys(at('abc', 0, 0), 'y', 'y')
    const started = Date.now()
    const r = keys(yanked, ...'999999999'.split(''), 'p')
    // Bounded, not billions: the line count proves the clamp held.
    expect(r.state.lines.length).toBeLessThanOrEqual(10_002)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('cannot make a word motion loop billions of times', () => {
    const started = Date.now()
    const r = keys(at('foo bar baz', 0, 0), ...'999999999'.split(''), 'w')
    expect(cursor(r)).toBe('0:10')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('drops a command too long to be one someone typed', () => {
    const r = keys(at('abc', 0, 0), ...'12345678901234567890'.split(''))
    expect(r.vim.pending.length).toBeLessThanOrEqual(16)
    expect(r.text).toBe('abc')
  })
})

describe('multi-byte text', () => {
  // An astral character is one cursor step, not two.
  it('counts emoji as single characters', () => {
    expect(keys(at('a😀b', 0, 1), 'x').text).toBe('ab')
    expect(cursor(keys(at('a😀b', 0, 0), '2', 'l'))).toBe('0:2')
  })
})

describe('a batched keystroke run', () => {
  // The decoder hands over everything read in one chunk, so a fast typist's keys
  // can arrive as one `char`. In normal mode each is its own command.
  it('is read as commands one at a time', () => {
    const r = keys(at('abcdef', 0, 0), { type: 'char', value: 'xxx' })
    expect(r.text).toBe('def')
  })

  it('applies a whole command spread across one chunk', () => {
    expect(keys(at('foo bar', 0, 0), { type: 'char', value: 'dw' }).text).toBe('bar')
  })
})
