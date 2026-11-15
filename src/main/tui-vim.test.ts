import { describe, it, expect } from 'vitest'
import { initialVimState, reduceVim, vimSelection, vimStatus, type VimState } from './tui-vim'
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

  it('is still vim undo alongside the composer undo key', () => {
    // Ctrl-_ in insert mode takes back the typing; `u` in normal mode its own stack.
    const s = { vim: initialVimState(), state: initialEditorState() }
    const typed = keys(s, 'hello', { type: 'undo' })
    expect(typed.text).toBe('')
    // In normal mode the undo key is `u`, so it takes back vim's own changes.
    expect(keys(at('abcd', 0, 0), 'x', 'x', { type: 'undo' }).text).toBe('bcd')
    expect(keys(at('abc', 0, 0), 'x', 'u').text).toBe('abc')
  })

  it('starts a fresh composer undo step after leaving insert', () => {
    const s = { vim: initialVimState(), state: initialEditorState() }
    const r = keys(s, 'one', { type: 'escape' }, 'a', ' two', { type: 'undo' })
    expect(r.text).toBe('one')
  })
})

describe('Esc Esc in vim', () => {
  const dbl: EditorKey = { type: 'escape', double: true }

  it('opens rewind from normal mode on an empty composer', () => {
    expect(keys(at(''), dbl).outcome).toEqual({ kind: 'rewind' })
  })

  it('never clears text', () => {
    const r = keys(at('keep this'), dbl)
    expect(r.text).toBe('keep this')
    expect(r.outcome).toBeUndefined()
  })

  it('is only the switch to normal mode from insert', () => {
    const r = keys({ vim: initialVimState(), state: initialEditorState() }, dbl)
    expect(r.vim.mode).toBe('normal')
    expect(r.outcome).toBeUndefined()
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

  // Once a command in the chunk enters insert mode, the rest is what the user typed
  // next: "Ahello" used to run "hello" as commands (h, e, l, l, o opened a new line).
  it('types the rest of the chunk once a command enters insert mode', () => {
    const r = keys(at('abc', 0, 0), { type: 'char', value: 'Ahello' })
    expect(r.vim.mode).toBe('insert')
    expect(r.state.lines).toEqual(['abchello'])
    expect(keys(at('abc', 0, 0), { type: 'char', value: 'ox y' }).state.lines).toEqual(['abc', 'x y'])
    // A burst that ends on the command itself just enters insert mode.
    expect(keys(at('abc', 0, 0), { type: 'char', value: 'A' }).state.lines).toEqual(['abc'])
  })
})

describe('f F t T, ; and ,', () => {
  it('f and t find a character forward, F and T backward', () => {
    expect(cursor(keys(at('a,b,c,d', 0, 0), 'f', ','))).toBe('0:1')
    expect(cursor(keys(at('a,b,c,d', 0, 0), 't', 'c'))).toBe('0:3')
    expect(cursor(keys(at('a,b,c,d', 0, 6), 'F', ','))).toBe('0:5')
    expect(cursor(keys(at('a,b,c,d', 0, 6), 'T', 'b'))).toBe('0:3')
  })

  it('takes a count and stays put when the character is not there', () => {
    expect(cursor(keys(at('a,b,c,d', 0, 0), '2', 'f', ','))).toBe('0:3')
    expect(cursor(keys(at('abc', 0, 0), 'f', 'z'))).toBe('0:0')
  })

  it('; repeats the last find and , repeats it the other way', () => {
    const r = keys(at('a,b,c,d', 0, 0), 'f', ',', ';', ';')
    expect(cursor(r)).toBe('0:5')
    expect(cursor(keys(r, ','))).toBe('0:3')
  })

  it('a repeated t moves past the character it already sits before', () => {
    expect(cursor(keys(at('a,b,c', 0, 0), 't', ',', ';'))).toBe('0:2')
  })

  it('works under an operator: df is inclusive, dt stops short, dF takes back to it', () => {
    expect(keys(at('foo(bar)', 0, 0), 'd', 'f', '(').text).toBe('bar)')
    expect(keys(at('foo(bar)', 0, 0), 'd', 't', '(').text).toBe('(bar)')
    expect(keys(at('foo(bar)', 0, 7), 'd', 'F', '(').text).toBe('foo)')
  })

  it('takes any key as its character, even a digit or a command', () => {
    expect(cursor(keys(at('ab1x', 0, 0), 'f', '1'))).toBe('0:2')
    expect(cursor(keys(at('abdx', 0, 0), 'f', 'd'))).toBe('0:2')
  })
})

describe('%', () => {
  it('jumps between a bracket and its match, across lines', () => {
    expect(cursor(keys(at('f(a, (b))', 0, 1), '%'))).toBe('0:8')
    expect(cursor(keys(at('f(a, (b))', 0, 8), '%'))).toBe('0:1')
    expect(cursor(keys(at('{\n  x\n}', 0, 0), '%'))).toBe('2:0')
  })

  it('finds the first bracket after the cursor on the line', () => {
    expect(cursor(keys(at('call [x]', 0, 0), '%'))).toBe('0:7')
  })

  it('d% takes the whole bracketed span', () => {
    expect(keys(at('a (b c) d', 0, 2), 'd', '%').text).toBe('a  d')
  })

  it('does nothing without a bracket', () => {
    expect(cursor(keys(at('plain', 0, 1), '%'))).toBe('0:1')
  })
})

describe('text objects', () => {
  it('iw is the word under the cursor, aw takes the space after it too', () => {
    expect(keys(at('one two three', 0, 5), 'd', 'i', 'w').text).toBe('one  three')
    expect(keys(at('one two three', 0, 5), 'd', 'a', 'w').text).toBe('one three')
  })

  it('aw takes the space before the last word on a line', () => {
    expect(keys(at('one two', 0, 5), 'd', 'a', 'w').text).toBe('one')
  })

  it('iW and aW run to whitespace, across punctuation', () => {
    expect(keys(at('see a.b-c now', 0, 6), 'd', 'i', 'W').text).toBe('see  now')
    expect(keys(at('see a.b-c now', 0, 6), 'd', 'a', 'W').text).toBe('see now')
    expect(keys(at('see a.b-c now', 0, 6), 'd', 'i', 'w').text).toBe('see a.-c now')
  })

  it('ciw changes the word and leaves you typing', () => {
    const r = keys(at('say hello there', 0, 6), 'c', 'i', 'w', 'bye')
    expect(r.text).toBe('say bye there')
    expect(r.vim.mode).toBe('insert')
  })

  it('i" and a" are the quoted text, without and with the quotes', () => {
    expect(keys(at('x = "a b" + y', 0, 6), 'd', 'i', '"').text).toBe('x = "" + y')
    expect(keys(at('x = "a b" + y', 0, 6), 'd', 'a', '"').text).toBe('x = + y')
    expect(keys(at("say 'here' now", 0, 6), 'd', 'i', "'").text).toBe("say '' now")
  })

  it('a quote object finds the next pair when the cursor is before it', () => {
    expect(keys(at('call "arg"', 0, 0), 'c', 'i', '"', 'x').text).toBe('call "x"')
  })

  it('i( a( i[ a[ i{ a{ work from anywhere inside, through nesting and lines', () => {
    expect(keys(at('f(a, g(b), c)', 0, 3), 'd', 'i', '(').text).toBe('f()')
    expect(keys(at('f(a, g(b), c)', 0, 7), 'd', 'i', ')').text).toBe('f(a, g(), c)')
    expect(keys(at('f(a, g(b), c)', 0, 3), 'd', 'a', '(').text).toBe('f')
    expect(keys(at('x[1, 2]', 0, 3), 'd', 'i', '[').text).toBe('x[]')
    expect(keys(at('x[1, 2]', 0, 3), 'd', 'a', ']').text).toBe('x')
    expect(keys(at('{\n  a\n}', 1, 2), 'd', 'i', '{').text).toBe('{}')
    expect(keys(at('{ a }', 0, 2), 'd', 'a', '{').text).toBe('')
  })

  it('i( on an empty pair puts you between the brackets', () => {
    const r = keys(at('f()', 0, 1), 'c', 'i', '(', 'x')
    expect(r.text).toBe('f(x)')
  })

  it('an object that is not there does nothing', () => {
    const r = keys(at('no brackets', 0, 3), 'd', 'i', '(')
    expect(r.text).toBe('no brackets')
    expect(r.vim.pending).toBe('')
    expect(keys(at('abc', 0, 1), 'd', 'i', 'z').text).toBe('abc')
  })

  it('yi( yanks the inside for p', () => {
    const r = keys(at('(ab)', 0, 1), 'y', 'i', '(', '$', 'p')
    expect(r.text).toBe('(ab)ab')
  })
})

describe('> and <', () => {
  it('>> indents the line, << takes it back', () => {
    const r = keys(at('a\nb', 0, 0), '>', '>')
    expect(r.text).toBe('  a\nb')
    expect(keys(r, '<', '<').text).toBe('a\nb')
  })

  it('takes a count of lines and a motion', () => {
    expect(keys(at('a\nb\nc', 0, 0), '2', '>', '>').text).toBe('  a\n  b\nc')
    expect(keys(at('a\nb\nc', 0, 0), '>', 'j').text).toBe('  a\n  b\nc')
  })

  it('leaves empty lines empty and < stops at the margin', () => {
    expect(keys(at('a\n\nb', 0, 0), '>', 'G').text).toBe('  a\n\n  b')
    expect(keys(at(' a', 0, 0), '<', '<').text).toBe('a')
    expect(keys(at('a', 0, 0), '<', '<').vim.undo).toHaveLength(0)
  })
})

describe('visual mode', () => {
  it('v starts a selection that motions stretch, and shows its mode', () => {
    const r = keys(at('hello world', 0, 0), 'v', 'e')
    expect(r.vim.mode).toBe('visual')
    expect(cursor(r)).toBe('0:4')
    expect(vimStatus('visual', paint)).toContain('v')
    expect(vimStatus('visual-line', paint)).toContain('V')
  })

  it('d and x delete the selection, including the character under the cursor', () => {
    expect(keys(at('hello world', 0, 0), 'v', 'e', 'd').text).toBe(' world')
    expect(keys(at('hello world', 0, 6), 'v', '$', 'x').text).toBe('hello ')
  })

  it('selects backwards from the anchor', () => {
    const r = keys(at('hello world', 0, 4), 'v', '0', 'd')
    expect(r.text).toBe(' world')
    expect(r.vim.mode).toBe('normal')
  })

  it('y yanks the selection and puts the cursor at its start', () => {
    const r = keys(at('abc def', 0, 6), 'v', 'b', 'y')
    expect(r.vim.register).toBe('def')
    expect(cursor(r)).toBe('0:4')
    expect(r.text).toBe('abc def')
  })

  it('c replaces the selection with what you type', () => {
    const r = keys(at('one two three', 0, 4), 'v', 'e', 'c', '2')
    expect(r.text).toBe('one 2 three')
    expect(r.vim.mode).toBe('insert')
  })

  it('a selection runs across lines', () => {
    expect(keys(at('ab\ncd', 0, 1), 'v', 'j', 'd').text).toBe('a')
  })

  it('o swaps the ends of the selection', () => {
    const r = keys(at('abcdef', 0, 1), 'v', 'l', 'l', 'o')
    expect(cursor(r)).toBe('0:1')
    expect(keys(r, 'h', 'd').text).toBe('ef')
  })

  it('Esc and v leave visual mode without touching the text', () => {
    const a = keys(at('abc', 0, 0), 'v', 'l', { type: 'escape' })
    expect(a.vim.mode).toBe('normal')
    expect(a.vim.anchor).toBeNull()
    expect(keys(at('abc', 0, 0), 'v', 'l', 'v').vim.mode).toBe('normal')
  })

  it('viw selects a word, and an object switches V to charwise', () => {
    const r = keys(at('say hello there', 0, 6), 'v', 'i', 'w')
    expect(cursor(r)).toBe('0:8')
    expect(r.vim.anchor).toEqual({ row: 0, col: 4 })
    expect(keys(r, 'd').text).toBe('say  there')
    expect(keys(at('a (b) c', 0, 3), 'V', 'a', '(', 'd').text).toBe('a  c')
  })

  it('arrows stretch the selection too', () => {
    expect(keys(at('abc', 0, 0), 'v', { type: 'right' }, 'd').text).toBe('c')
  })

  it('f inside visual mode moves the end', () => {
    expect(keys(at('a,b,c', 0, 0), 'v', 'f', ',', ';', 'd').text).toBe('c')
  })

  it('> and < shift every line the selection touches', () => {
    expect(keys(at('a\nb\nc', 0, 0), 'v', 'j', '>').text).toBe('  a\n  b\nc')
    expect(keys(at('    a\n    b', 0, 0), 'V', 'j', '2', '<').text).toBe('a\nb')
  })

  it('u takes back a visual change', () => {
    expect(keys(at('abc', 0, 0), 'v', 'l', 'd', 'u').text).toBe('abc')
  })
})

describe('visual-line mode', () => {
  it('V selects whole lines, and d takes them', () => {
    const r = keys(at('a\nb\nc', 0, 0), 'V', 'j', 'd')
    expect(r.text).toBe('c')
    expect(r.vim.registerLinewise).toBe(true)
  })

  it('y then p puts the lines back as lines', () => {
    expect(keys(at('a\nb', 0, 0), 'V', 'y', 'j', 'p').text).toBe('a\nb\na')
  })

  it('c keeps one empty line to type on', () => {
    const r = keys(at('a\nb\nc', 1, 0), 'V', 'c', 'x')
    expect(r.text).toBe('a\nx\nc')
  })

  it('v and V switch between the two visual modes', () => {
    const r = keys(at('ab\ncd', 0, 0), 'v', 'V')
    expect(r.vim.mode).toBe('visual-line')
    expect(keys(r, 'v').vim.mode).toBe('visual')
    expect(keys(r, 'V').vim.mode).toBe('normal')
  })
})

describe('vimSelection', () => {
  it('is null outside visual modes', () => {
    const r = at('abc')
    expect(vimSelection(r.vim, r.state)).toBeNull()
  })

  it('covers the characters from the anchor to the cursor, inclusive', () => {
    const r = keys(at('hello world', 0, 2), 'v', 'l', 'l')
    expect(vimSelection(r.vim, r.state)).toEqual([[{ start: 2, end: 5 }]])
  })

  it('runs to the end of each line between the ends', () => {
    const r = keys(at('ab\ncd\nef', 0, 1), 'v', 'j', 'j')
    expect(vimSelection(r.vim, r.state)).toEqual([[{ start: 1, end: 2 }], [{ start: 0, end: 2 }], [{ start: 0, end: 2 }]])
  })

  it('covers whole lines in visual-line mode', () => {
    const r = keys(at('ab\ncd\nef', 1, 1), 'V', 'k')
    expect(vimSelection(r.vim, r.state)).toEqual([[{ start: 0, end: 2 }], [{ start: 0, end: 2 }], []])
  })

  it('counts in string offsets, so an emoji is two units wide', () => {
    const r = keys(at('😀ab', 0, 0), 'v', 'l')
    expect(vimSelection(r.vim, r.state)).toEqual([[{ start: 0, end: 3 }]])
  })
})

describe('. repeat', () => {
  it('repeats a delete', () => {
    expect(keys(at('a b c d', 0, 0), 'd', 'w', '.').text).toBe('c d')
    expect(keys(at('abcd', 0, 0), 'x', '.', '.').text).toBe('d')
  })

  it('repeats a change with the text typed after it', () => {
    const r = keys(at('one two three', 0, 0), 'c', 'e', 'X', { type: 'escape' }, 'w', '.')
    expect(r.text).toBe('X X three')
    expect(r.vim.mode).toBe('normal')
  })

  it('repeats an insert', () => {
    const r = keys(at('a\nb', 0, 0), 'A', '!', { type: 'escape' }, 'j', '.')
    expect(r.text).toBe('a!\nb!')
  })

  it('repeats a text-object change', () => {
    const r = keys(at('(a) (b)', 0, 1), 'c', 'i', '(', 'z', { type: 'escape' }, 'f', '(', '.')
    expect(r.text).toBe('(z) (z)')
  })

  it('takes a new count in place of the old one', () => {
    expect(keys(at('abcdefg', 0, 0), 'x', '3', '.').text).toBe('efg')
    expect(keys(at('a b c d e', 0, 0), '2', 'd', 'w', '.').text).toBe('e')
  })

  it('repeats dd, p and r', () => {
    expect(keys(at('a\nb\nc', 0, 0), 'd', 'd', '.').text).toBe('c')
    expect(keys(at('abc', 0, 0), 'r', 'x', 'l', '.').text).toBe('xxc')
  })

  it('repeats a visual delete over the same amount of text', () => {
    expect(keys(at('abcdef', 0, 0), 'v', 'l', 'd', '.').text).toBe('ef')
    expect(keys(at('a\nb\nc\nd\ne', 0, 0), 'V', 'j', 'd', '.').text).toBe('e')
  })

  it('repeats a visual change and a visual shift', () => {
    // Esc leaves the cursor after the X, on the `c`: the repeat changes two from there.
    expect(keys(at('abcd', 0, 0), 'v', 'l', 'c', 'X', { type: 'escape' }, '.').text).toBe('XX')
    expect(keys(at('a\nb', 0, 0), 'V', '>', 'j', '.').text).toBe('  a\n  b')
  })

  it('is not itself a change, and motions or yanks do not replace the last one', () => {
    const r = keys(at('a b c d e', 0, 0), 'd', 'w', 'w', 'y', 'w', '.')
    expect(r.text).toBe('b d e')
    expect(r.vim.lastChange).toEqual({ kind: 'keys', keys: 'dw', text: null })
  })

  it('does nothing before any change', () => {
    expect(keys(at('abc', 0, 1), '.').text).toBe('abc')
  })

  it('an insert where the cursor moved is not repeatable', () => {
    const r = keys(at('ab', 0, 0), 'x', 'i', 'q', { type: 'left' }, 'z', { type: 'escape' }, '.')
    // `.` repeats the `x` from before (taking the q), not the insert it can't put
    // back faithfully.
    expect(r.text).toBe('zb')
  })

  it('is undone by one u', () => {
    expect(keys(at('a b c', 0, 0), 'd', 'w', '.', 'u').text).toBe('b c')
  })
})
