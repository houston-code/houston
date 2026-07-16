import { describe, it, expect } from 'vitest'
import {
  initialEditorState,
  reduceEditor,
  renderEditor,
  editorText,
  setEditorText,
  blobToken,
  findHistoryMatch,
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
