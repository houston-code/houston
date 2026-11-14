import { describe, it, expect } from 'vitest'
import {
  initialEditorState,
  reduceEditor,
  renderEditor,
  editorText,
  setEditorText,
  blobToken,
  findHistoryMatch,
  parseImagePaths,
  PASTE_COLLAPSE_LINES,
  type EditorState,
  type EditorOutcome
} from './tui-editor'
import type { EditorKey } from './tui-keys'
import { makePainter } from './tui'

const paint = makePainter(false)

/** Drive a series of keys through the editor, returning the final state + outcome. */
function run(keys: EditorKey[], init?: EditorState): { state: EditorState; outcome?: EditorOutcome } {
  let state = init ?? initialEditorState()
  let outcome: EditorOutcome | undefined
  for (const k of keys) {
    const r = reduceEditor(state, k)
    state = r.state
    if (r.outcome) outcome = r.outcome
  }
  return { state, outcome }
}

const type = (s: string): EditorKey => ({ type: 'char', value: s })

describe('reduceEditor — typing and submitting', () => {
  it('inserts text and submits the whole buffer on Enter', () => {
    const { outcome } = run([type('hello world'), { type: 'enter' }])
    expect(outcome).toEqual({ kind: 'submit', text: 'hello world' })
  })

  it('inserts a literal newline without submitting', () => {
    const { state, outcome } = run([type('one'), { type: 'newline' }, type('two')])
    expect(outcome).toBeUndefined()
    expect(state.lines).toEqual(['one', 'two'])
    expect(editorText(state)).toBe('one\ntwo')
  })

  it('inserts at the cursor, not just at the end', () => {
    const { state } = run([type('ac'), { type: 'left' }, type('b')])
    expect(state.lines).toEqual(['abc'])
    expect(state.col).toBe(2)
  })
})

describe('reduceEditor — paste', () => {
  // The headline fix: a pasted block lands whole and is NOT submitted.
  it('lands a multi-line paste as one editable block', () => {
    const { state, outcome } = run([{ type: 'paste', value: 'line one\nline two' }])
    expect(outcome).toBeUndefined()
    expect(state.lines).toEqual(['line one', 'line two'])
    expect(editorText(state)).toBe('line one\nline two')
  })

  it('pastes into the middle of an existing draft', () => {
    const { state } = run([type('start end'), { type: 'left' }, { type: 'left' }, { type: 'left' }, { type: 'paste', value: 'X\nY' }])
    expect(state.lines).toEqual(['start X', 'Yend'])
  })

  it('collapses a big paste to a placeholder, expanding it on submit', () => {
    const body = Array.from({ length: PASTE_COLLAPSE_LINES + 3 }, (_, i) => `line ${i}`).join('\n')
    const { state, outcome } = run([{ type: 'paste', value: body }, { type: 'enter' }])
    expect(state.blobs).toHaveLength(1)
    // The user sees a short placeholder, not 8 lines of buffer…
    expect(state.blobs[0].token).toMatch(/pasted 8 lines/)
    // …but the submitted text is the real thing.
    expect(outcome).toEqual({ kind: 'submit', text: body })
  })

  it('keeps surrounding text when a collapsed paste is submitted', () => {
    const body = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
    const { outcome } = run([type('review this: '), { type: 'paste', value: body }, type(' thanks'), { type: 'enter' }])
    expect(outcome).toEqual({ kind: 'submit', text: `review this: ${body} thanks` })
  })

  it('leaves a small paste inline', () => {
    const { state } = run([{ type: 'paste', value: 'a\nb' }])
    expect(state.blobs).toHaveLength(0)
  })

  it('ignores an empty paste', () => {
    const { state } = run([{ type: 'paste', value: '' }])
    expect(state.lines).toEqual([''])
  })
})

describe('reduceEditor — editing keys', () => {
  it('backspace joins a line into the previous one', () => {
    const { state } = run([type('ab'), { type: 'newline' }, type('cd'), { type: 'home' }, { type: 'backspace' }])
    expect(state.lines).toEqual(['abcd'])
    expect(state.row).toBe(0)
    expect(state.col).toBe(2)
  })

  it('delete pulls the next line up', () => {
    const { state } = run([type('ab'), { type: 'newline' }, type('cd'), { type: 'up' }, { type: 'end' }, { type: 'delete' }])
    expect(state.lines).toEqual(['abcd'])
  })

  it('kill-line, kill-to-start, kill-word and yank', () => {
    const killLine = run([type('keep drop'), { type: 'left' }, { type: 'left' }, { type: 'left' }, { type: 'left' }, { type: 'kill-line' }])
    expect(killLine.state.lines).toEqual(['keep '])
    expect(killLine.state.kill).toBe('drop')

    const killStart = run([type('drop keep'), { type: 'home' }, { type: 'word-right' }, { type: 'right' }, { type: 'kill-to-start' }])
    expect(killStart.state.lines).toEqual(['keep'])

    const killWord = run([type('one two'), { type: 'kill-word' }])
    expect(killWord.state.lines).toEqual(['one '])
    expect(killWord.state.kill).toBe('two')

    const yank = run([type('one two'), { type: 'kill-word' }, { type: 'yank' }])
    expect(yank.state.lines).toEqual(['one two'])
  })

  it('word motions move by word', () => {
    const { state } = run([type('alpha beta'), { type: 'word-left' }])
    expect(state.col).toBe(6)
    const back = run([type('alpha beta'), { type: 'home' }, { type: 'word-right' }])
    expect(back.state.col).toBe(5)
  })

  it('counts by code point so astral characters are not split', () => {
    const { state } = run([type('🚀🚀'), { type: 'backspace' }])
    expect(state.lines).toEqual(['🚀'])
  })

  it('Ctrl-D on an empty buffer is EOF, but deletes forward otherwise', () => {
    expect(run([{ type: 'eof' }]).outcome).toEqual({ kind: 'eof' })
    const { state, outcome } = run([type('ab'), { type: 'home' }, { type: 'eof' }])
    expect(outcome).toBeUndefined()
    expect(state.lines).toEqual(['b'])
  })

  it('reports interrupt, completion and the editor hand-off to the adapter', () => {
    expect(run([{ type: 'interrupt' }]).outcome).toEqual({ kind: 'interrupt' })
    expect(run([{ type: 'tab' }]).outcome).toEqual({ kind: 'complete' })
    expect(run([type('draft'), { type: 'external-edit' }]).outcome).toEqual({
      kind: 'external-edit',
      text: 'draft'
    })
  })

  it('hands Ctrl-O and Alt-T to the adapter with the draft untouched, and ignores paging keys', () => {
    for (const [key, kind] of [
      ['transcript', 'transcript'],
      ['cycle-thoughts', 'cycle-thoughts']
    ] as const) {
      const r = run([type('draft'), { type: key }])
      expect(r.outcome).toEqual({ kind })
      expect(editorText(r.state)).toBe('draft')
    }
    const paged = run([type('draft'), { type: 'page-up' }, { type: 'page-down' }])
    expect(paged.outcome).toBeUndefined()
    expect(editorText(paged.state)).toBe('draft')
  })
})

describe('reduceEditor — history', () => {
  const hist = ['first message', 'second message']

  it('recalls previous entries with Up and returns with Down', () => {
    const up1 = run([{ type: 'up' }], initialEditorState(hist))
    expect(up1.state.lines).toEqual(['second message'])
    const up2 = run([{ type: 'up' }, { type: 'up' }], initialEditorState(hist))
    expect(up2.state.lines).toEqual(['first message'])
    const down = run([{ type: 'up' }, { type: 'up' }, { type: 'down' }], initialEditorState(hist))
    expect(down.state.lines).toEqual(['second message'])
  })

  it('restores the draft when Down walks past the newest entry', () => {
    const { state } = run([type('my draft'), { type: 'up' }, { type: 'down' }], initialEditorState(hist))
    expect(state.lines).toEqual(['my draft'])
    expect(state.histIndex).toBeNull()
  })

  it('moves between lines before reaching for history in a multi-line draft', () => {
    const { state } = run([type('a'), { type: 'newline' }, type('b'), { type: 'up' }], initialEditorState(hist))
    expect(state.lines).toEqual(['a', 'b']) // still the draft, cursor moved up a line
    expect(state.row).toBe(0)
  })

  it('recalls a multi-line entry whole', () => {
    const { state } = run([{ type: 'up' }], initialEditorState(['a\nb\nc']))
    expect(state.lines).toEqual(['a', 'b', 'c'])
  })
})

describe('reduceEditor — reverse search (Ctrl-R)', () => {
  const hist = ['git status', 'run the tests', 'git commit -m wip']

  it('finds the most recent match as the query is typed', () => {
    const { state } = run([{ type: 'search' }, type('git')], initialEditorState(hist))
    expect(state.search?.index).toBe(2)
  })

  it('steps to older matches on repeated Ctrl-R', () => {
    const { state } = run([{ type: 'search' }, type('git'), { type: 'search' }], initialEditorState(hist))
    expect(state.search?.index).toBe(0)
  })

  it('accepts the match on Enter and leaves search mode', () => {
    const { state } = run([{ type: 'search' }, type('tests'), { type: 'enter' }], initialEditorState(hist))
    expect(state.search).toBeNull()
    expect(state.lines).toEqual(['run the tests'])
  })

  it('backspace widens the search again', () => {
    const { state } = run([{ type: 'search' }, type('gitx'), { type: 'backspace' }], initialEditorState(hist))
    expect(state.search?.index).toBe(2)
  })

  it('Escape abandons the search and keeps the draft', () => {
    const { state } = run([type('draft'), { type: 'search' }, type('git'), { type: 'escape' }], initialEditorState(hist))
    expect(state.search).toBeNull()
    expect(state.lines).toEqual(['draft'])
  })

  it('reports no match for an unknown query', () => {
    const { state } = run([{ type: 'search' }, type('nothing')], initialEditorState(hist))
    expect(state.search?.index).toBeNull()
  })

  it('findHistoryMatch searches backwards from a bound', () => {
    expect(findHistoryMatch(hist, 'git', hist.length - 1)).toBe(2)
    expect(findHistoryMatch(hist, 'git', 1)).toBe(0)
    expect(findHistoryMatch(hist, 'zzz', 2)).toBeNull()
    expect(findHistoryMatch(hist, '', 2)).toBeNull()
  })
})

describe('setEditorText', () => {
  it('replaces the draft and puts the cursor at the end', () => {
    const s = setEditorText(initialEditorState(), 'from\nthe editor')
    expect(s.lines).toEqual(['from', 'the editor'])
    expect(s.row).toBe(1)
    expect(s.col).toBe('the editor'.length)
  })
})

describe('renderEditor', () => {
  const colour = makePainter(true)
  const marked = (s: string): string => colour(s, 'bold', 'magenta')

  it('draws marked ranges emphasized without moving the text or the cursor', () => {
    const { state } = run([type('fix it, ultrathink now')])
    const plain = renderEditor(state, { prompt: '> ', width: 40, paint: colour })
    const v = renderEditor(state, { prompt: '> ', width: 40, paint: colour, marks: [[{ start: 8, end: 18 }]] })
    expect(v.rows).toEqual([`> fix it, ${marked('ultrathink')} now`])
    expect(v.cursorRow).toBe(plain.cursorRow)
    expect(v.cursorCol).toBe(plain.cursorCol)
  })

  it('paints both halves of a mark the wrap splits', () => {
    const { state } = run([type('ab ultrathink')])
    // Width 10 with a 2-column prompt: 8 text columns per row.
    const v = renderEditor(state, { prompt: '> ', width: 10, paint: colour, marks: [[{ start: 3, end: 13 }]] })
    expect(v.rows).toEqual([`> ab ${marked('ultra')}`, `  ${marked('think')}`])
  })

  it('leaves unmarked lines and a colourless terminal as they were', () => {
    const { state } = run([type('ultrathink')])
    expect(renderEditor(state, { prompt: '> ', width: 40, paint, marks: [[{ start: 0, end: 10 }]] }).rows).toEqual([
      '> ultrathink'
    ])
    expect(renderEditor(state, { prompt: '> ', width: 40, paint: colour, marks: [[]] }).rows).toEqual(['> ultrathink'])
  })

  it('puts the prompt on the first row and the cursor after the text', () => {
    const { state } = run([type('hi')])
    const v = renderEditor(state, { prompt: '> ', width: 40, paint })
    expect(v.rows).toEqual(['> hi'])
    expect(v.cursorRow).toBe(0)
    expect(v.cursorCol).toBe(4)
  })

  it('renders each logical line as its own row with a continuation marker', () => {
    const { state } = run([type('one'), { type: 'newline' }, type('two')])
    const v = renderEditor(state, { prompt: '> ', width: 40, paint, continuation: '… ' })
    expect(v.rows).toEqual(['> one', '… two'])
    expect(v.cursorRow).toBe(1)
  })

  it('hard-wraps a long line and tracks the cursor onto the wrapped row', () => {
    const { state } = run([type('a'.repeat(25))])
    const v = renderEditor(state, { prompt: '> ', width: 10, paint })
    // 8 columns of content on row 0 (prompt takes 2), then 10 per row after.
    expect(v.rows[0]).toBe(`> ${'a'.repeat(8)}`)
    expect(v.rows.length).toBeGreaterThan(1)
    expect(v.cursorRow).toBe(v.rows.length - 1)
  })

  it('accounts for wide characters when placing the cursor', () => {
    const { state } = run([type('日本')])
    const v = renderEditor(state, { prompt: '> ', width: 40, paint })
    expect(v.cursorCol).toBe(6) // 2 (prompt) + 2 wide chars × 2 columns
  })

  it('places the cursor after an emoji sequence by the columns it is drawn in', () => {
    const { state } = run([type('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}x')]) // 👨‍👩‍👧x
    const v = renderEditor(state, { prompt: '> ', width: 40, paint })
    expect(v.cursorCol).toBe(5) // 2 (prompt) + 2 (the family) + 1
  })

  it('wraps before an emoji sequence rather than through it', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
    const { state } = run([type(`abcdefg${family}`)])
    const v = renderEditor(state, { prompt: '> ', width: 10, paint })
    expect(v.rows[0]).toBe('> abcdefg')
    expect(v.rows[1]).toBe(`  ${family}`) // continuation rows are indented under the prompt
  })

  it('renders the reverse-search prompt while searching', () => {
    const { state } = run([{ type: 'search' }, type('git')], initialEditorState(['git status']))
    const v = renderEditor(state, { prompt: '> ', width: 40, paint })
    expect(v.rows[0]).toContain("(reverse-i-search)`git'")
    expect(v.rows[0]).toContain('git status')
  })

  it('shows the placeholder for a collapsed paste rather than the body', () => {
    const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    const { state } = run([{ type: 'paste', value: body }])
    const v = renderEditor(state, { prompt: '> ', width: 40, paint })
    expect(v.rows).toHaveLength(1)
    expect(v.rows[0]).toContain('pasted 30 lines')
    expect(v.rows[0]).not.toContain('line 7')
  })
})

// A paste placeholder is substituted back on submit, so text that happens to spell
// a token must not be able to hijack that substitution — what the user reviewed has
// to be what gets sent.
describe('paste placeholders cannot be forged', () => {
  const big = (n: number): string => Array.from({ length: n }, (_, i) => `l${i}`).join('\n')

  it('picks a token that does not collide with text already in the draft', () => {
    const body = big(12)
    const decoy = blobToken(1, body) // exactly what the next token would be
    const { state, outcome } = run([type(decoy), { type: 'paste', value: body }, { type: 'enter' }])
    expect(state.blobs[0].token).not.toBe(decoy)
    // The decoy survives as literal text; only the real placeholder expands.
    const text = (outcome as { kind: 'submit'; text: string }).text
    expect(text.startsWith(decoy)).toBe(true)
    expect(text).toContain(body)
  })

  it('expands each placeholder only once', () => {
    const body = big(12)
    const start = run([{ type: 'paste', value: body }])
    const token = start.state.blobs[0].token
    // The user duplicates the placeholder by hand: the copy stays literal.
    const { outcome } = run([type(token), { type: 'enter' }], start.state)
    const text = (outcome as { kind: 'submit'; text: string }).text
    expect(text).toContain(body)
    expect(text).toContain(token)
  })
})

describe('reduceEditor: undo and redo', () => {
  const draft = (s: EditorState): string => s.lines.join('\n')
  const undo: EditorKey = { type: 'undo' }
  const redo: EditorKey = { type: 'redo' }

  it('takes back a run of typing as one step', () => {
    const { state } = run([type('h'), type('e'), type('llo'), undo])
    expect(draft(state)).toBe('')
    expect(state.col).toBe(0)
  })

  it('splits typing at a cursor move', () => {
    const { state } = run([type('abc'), { type: 'left' }, type('X'), undo])
    expect(draft(state)).toBe('abc')
    expect(state.col).toBe(2)
    expect(draft(run([undo], state).state)).toBe('')
  })

  it('makes paste, kill and yank steps of their own', () => {
    const start = run([type('one two'), { type: 'paste', value: ' three' }, { type: 'kill-word' }, { type: 'yank' }])
    expect(draft(start.state)).toBe('one two three')
    const afterYank = run([undo], start.state).state
    expect(draft(afterYank)).toBe('one two ')
    const afterKill = run([undo], afterYank).state
    expect(draft(afterKill)).toBe('one two three')
    const afterPaste = run([undo], afterKill).state
    expect(draft(afterPaste)).toBe('one two')
  })

  it('coalesces a run of backspaces', () => {
    const { state } = run([type('hello'), { type: 'left' }, { type: 'backspace' }, { type: 'backspace' }, undo])
    expect(draft(state)).toBe('hello')
  })

  it('redoes what undo took back, and a new edit clears redo', () => {
    const s1 = run([type('abc'), undo, redo]).state
    expect(draft(s1)).toBe('abc')
    const s2 = run([undo, type('x'), redo], s1).state
    expect(draft(s2)).toBe('x')
  })

  it('undoes a collapsed paste, blob and all', () => {
    const body = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
    const pasted = run([{ type: 'paste', value: body }]).state
    expect(pasted.blobs).toHaveLength(1)
    const back = run([undo], pasted).state
    expect(back.blobs).toHaveLength(0)
    const again = run([redo], back).state
    expect(editorText(again)).toBe(body)
  })

  it('treats an $EDITOR round trip as one step', () => {
    const typed = run([type('draft')]).state
    const edited = setEditorText(typed, 'rewritten in the editor')
    expect(draft(run([undo], edited).state)).toBe('draft')
  })

  it('does nothing with nothing to undo or redo', () => {
    const { state } = run([undo, redo])
    expect(draft(state)).toBe('')
  })

  it('does not record history recall or cursor moves as edits', () => {
    const s = initialEditorState(['earlier'])
    const { state } = run([{ type: 'up' }, undo], s)
    expect(draft(state)).toBe('earlier')
  })

  it('bounds the undo history', () => {
    let s = initialEditorState()
    for (let i = 0; i < 150; i++) s = run([{ type: 'paste', value: 'x' }], s).state
    expect(s.undo.length).toBeLessThanOrEqual(100)
  })
})

describe('reduceEditor: Ctrl-S stash', () => {
  const stash: EditorKey = { type: 'stash' }

  it('stashes the draft (text, cursor, blobs) and clears the composer', () => {
    const body = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
    const s = run([type('see '), { type: 'paste', value: body }, { type: 'left' }]).state
    const { state } = run([stash], s)
    expect(state.lines).toEqual([''])
    expect(state.blobs).toEqual([])
    expect(state.stashed?.blobs).toHaveLength(1)
    // Ctrl-S on the empty composer brings it all back, cursor included.
    const back = run([stash], state).state
    expect(back.lines).toEqual(s.lines)
    expect(back.col).toBe(s.col)
    expect(editorText(back)).toBe(`see ${body}`)
    expect(back.stashed).toBeNull()
  })

  it('does nothing on an empty composer with no stash', () => {
    const { state, outcome } = run([stash])
    expect(state.lines).toEqual([''])
    expect(outcome).toBeUndefined()
  })

  it('keeps an older stash in history rather than dropping it', () => {
    const first = run([type('first idea'), stash]).state
    const r = run([type('second idea'), stash], first)
    expect(r.outcome).toEqual({ kind: 'remember', text: 'first idea' })
    expect(r.state.history.at(-1)).toBe('first idea')
    expect(r.state.stashed?.lines).toEqual(['second idea'])
  })

  it('carries a stash into a fresh read', () => {
    const stashed = run([type('later'), stash]).state.stashed
    const next = initialEditorState([], '', stashed)
    expect(run([stash], next).state.lines).toEqual(['later'])
  })

  it('can be undone', () => {
    const { state } = run([type('keep me'), stash, { type: 'undo' }])
    expect(state.lines).toEqual(['keep me'])
  })
})

describe('reduceEditor: Esc Esc', () => {
  const dbl: EditorKey = { type: 'escape', double: true }

  it('clears the draft into history so Up recalls it', () => {
    const { state, outcome } = run([type('half a thought'), dbl])
    expect(outcome).toEqual({ kind: 'remember', text: 'half a thought' })
    expect(state.lines).toEqual([''])
    expect(run([{ type: 'up' }], state).state.lines).toEqual(['half a thought'])
  })

  it('asks for the rewind picker on an empty composer', () => {
    expect(run([dbl]).outcome).toEqual({ kind: 'rewind' })
  })

  it('leaves the draft alone on a single Esc', () => {
    const { state, outcome } = run([type('keep'), { type: 'escape' }])
    expect(state.lines).toEqual(['keep'])
    expect(outcome).toBeUndefined()
  })
})

describe('reduceEditor: image and suspend keys', () => {
  it('report to the adapter and leave the buffer alone', () => {
    const s = run([type('look at this')]).state
    const img = reduceEditor(s, { type: 'paste-image' })
    expect(img.outcome).toEqual({ kind: 'paste-image' })
    expect(img.state.lines).toEqual(['look at this'])
    expect(reduceEditor(s, { type: 'suspend' }).outcome).toEqual({ kind: 'suspend' })
  })
})

describe('parseImagePaths', () => {
  it('reads one plain or several space-separated paths', () => {
    expect(parseImagePaths('/tmp/shot.png')).toEqual(['/tmp/shot.png'])
    expect(parseImagePaths('a.png b.JPG c.jpeg d.gif e.webp')).toEqual(['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp'])
    expect(parseImagePaths('/tmp/a.png\n/tmp/b.png\n')).toEqual(['/tmp/a.png', '/tmp/b.png'])
  })

  it('reads quoted paths and backslash-escaped spaces', () => {
    expect(parseImagePaths("'/home/me/Screen Shot 1.png'")).toEqual(['/home/me/Screen Shot 1.png'])
    expect(parseImagePaths('"/tmp/my pic.webp" /tmp/x.gif')).toEqual(['/tmp/my pic.webp', '/tmp/x.gif'])
    expect(parseImagePaths('/home/me/Screen\\ Shot\\ 1.png')).toEqual(['/home/me/Screen Shot 1.png'])
  })

  it('reads file:// URLs', () => {
    expect(parseImagePaths('file:///tmp/my%20pic.png')).toEqual(['/tmp/my pic.png'])
    expect(parseImagePaths('file:///C:/shots/a.png', { windows: true })).toEqual(['C:/shots/a.png'])
  })

  it('keeps Windows backslashes as separators', () => {
    expect(parseImagePaths('C:\\Users\\me\\a.png', { windows: true })).toEqual(['C:\\Users\\me\\a.png'])
  })

  it('is null for anything that is not only image paths', () => {
    expect(parseImagePaths('')).toBeNull()
    expect(parseImagePaths('look at shot.png please')).toBeNull()
    expect(parseImagePaths('/tmp/notes.txt')).toBeNull()
    expect(parseImagePaths('/tmp/a.png /tmp/b.pdf')).toBeNull()
    expect(parseImagePaths("'/tmp/open quote.png")).toBeNull()
    expect(parseImagePaths('file:///bad%E0%A4.png')).toBeNull()
  })
})
