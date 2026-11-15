import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '@shared/agent'
import { COMPACTION_SUMMARY_PREFIX, SYSTEM_NOTE_PREFIX } from '@shared/agent'
import { makePainter } from './tui'
import type { EditorKey } from './tui-keys'
import { stripAnsi, visibleWidth } from './tui-wrap'
import {
  formatStamp,
  initialPagerState,
  maxTop,
  reducePager,
  renderPagerScreen,
  renderTranscript,
  rewrapTop,
  searchMatches,
  transcriptPlain,
  type PagerState,
  type TranscriptDoc
} from './tui-pager'

const plain = makePainter(false)

const chat: ChatMessage[] = [
  { role: 'user', content: 'fix the loader', at: '2026-11-14T09:05:00.000Z' },
  {
    role: 'assistant',
    content: 'Reading it.',
    at: '2026-11-14T09:05:30.000Z',
    model: 'claude-x',
    reasoning: [{ text: 'The loader reads the config twice.' }],
    toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'src/loader.ts' } }]
  },
  {
    role: 'tool',
    toolName: 'read_file',
    toolCallId: 'c1',
    content: Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n')
  },
  { role: 'user', content: `${COMPACTION_SUMMARY_PREFIX}\nEarlier we fixed the parser.` },
  { role: 'user', content: `${SYSTEM_NOTE_PREFIX} the user switched models` },
  {
    role: 'user',
    content: 'Review the changes adversarially...',
    invokedAs: { kind: 'command', label: 'Review', typed: '/review' }
  } as ChatMessage,
  {
    role: 'assistant',
    content: '',
    runEnds: [{ reason: 'aborted', at: '2026-11-14T09:07:00.000Z' }]
  }
]

const text = (doc: TranscriptDoc): string => doc.lines.map(stripAnsi).join('\n')

describe('renderTranscript', () => {
  it('shows every message, reasoning, full tool arguments and full output', () => {
    const out = text(renderTranscript(chat, plain, { width: 80 }))
    expect(out).toContain('fix the loader')
    expect(out).toContain('The loader reads the config twice.')
    expect(out).toContain('"path": "src/loader.ts"')
    // All of it, not the 40 lines an export keeps.
    expect(out).toContain('line 79')
    expect(out).toContain('summary of earlier messages (compacted)')
    expect(out).toContain('Earlier we fixed the parser.')
    expect(out).toContain('the user switched models')
    expect(out).toContain('/review')
    expect(out).toContain('Review the changes adversarially')
    expect(out).toContain('run ended: Stopped.')
    expect(out).toContain('claude-x')
  })

  it('stamps messages with the time they were written', () => {
    const out = text(renderTranscript(chat, plain, { width: 80 }))
    expect(out).toContain(`you · ${formatStamp('2026-11-14T09:05:00.000Z')}`)
    expect(formatStamp(undefined)).toBe('')
    expect(formatStamp('not a date')).toBe('')
    expect(formatStamp('2026-11-14T09:05:00.000Z')).toMatch(/^2026-11-1[345] \d\d:\d\d$/)
  })

  it('marks where each of your messages starts', () => {
    const doc = renderTranscript(chat, plain, { width: 80 })
    expect(doc.prompts).toHaveLength(2)
    expect(stripAnsi(doc.lines[doc.prompts[0]])).toMatch(/^you/)
    expect(stripAnsi(doc.lines[doc.prompts[1]])).toMatch(/^you/)
  })

  it('wraps to the width, keeping indentation, and never paints across a wrap', () => {
    const long: ChatMessage[] = [{ role: 'assistant', content: 'word '.repeat(60) }]
    const doc = renderTranscript(long, makePainter(true), { width: 30 })
    for (const l of doc.lines) {
      expect(visibleWidth(l)).toBeLessThanOrEqual(30)
      // Every colored line closes its own color.
      if (l.includes('\x1b[')) expect(l.endsWith('\x1b[0m')).toBe(true)
    }
    expect(doc.lines.filter((l) => stripAnsi(l).startsWith('  word')).length).toBeGreaterThan(5)
  })

  it('strips terminal controls a model, tool or file wrote', () => {
    const hostile: ChatMessage[] = [
      { role: 'tool', toolName: 'run_shell', content: 'ok\x1b]52;c;aGk=\x07\x1b[2J\tdone' },
      { role: 'assistant', content: 'hi\x9b31m', reasoning: [{ text: 'thought\x1b[1A' }] }
    ]
    const doc = renderTranscript(hostile, plain, { width: 80 })
    const raw = doc.lines.join('\n')
    // eslint-disable-next-line no-control-regex -- no control may survive but the newline
    expect(raw).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/)
    expect(raw).toContain('ok]52;c;aGk=[2J    done')
  })

  it('says so for an empty chat', () => {
    expect(text(renderTranscript([], plain, { width: 80 }))).toContain('nothing in this chat yet')
  })

  it('writes plain, unwrapped text for an editor', () => {
    const out = transcriptPlain(chat, 'Loader\x1b[2J fix')
    expect(out.startsWith('Loader[2J fix\n')).toBe(true)
    expect(out).toContain('line 79')
    expect(out).not.toContain('\x1b')
  })
})

describe('reducePager', () => {
  const doc: TranscriptDoc = {
    lines: Array.from({ length: 100 }, (_, i) => (i === 42 || i === 77 ? `needle ${i}` : `line ${i}`)),
    prompts: [0, 30, 60]
  }
  const ctx = { doc, height: 20 }
  const run = (keys: EditorKey[], from: PagerState = initialPagerState()) => {
    let s = from
    let outcome
    for (const k of keys) {
      const r = reducePager(s, k, ctx)
      s = r.state
      outcome = r.outcome
      if (outcome) break
    }
    return { s, outcome }
  }
  const ch = (value: string): EditorKey => ({ type: 'char', value })

  it('scrolls by line, page and to either end, never past them', () => {
    expect(run([ch('j'), ch('j'), { type: 'down' }]).s.top).toBe(3)
    expect(run([ch('jjk')]).s.top).toBe(1)
    expect(run([{ type: 'up' }]).s.top).toBe(0)
    expect(run([ch(' ')]).s.top).toBe(20)
    expect(run([{ type: 'page-down' }, { type: 'page-down' }, { type: 'page-up' }]).s.top).toBe(20)
    expect(run([ch('G')]).s.top).toBe(maxTop(doc, 20))
    expect(run([ch('G'), ch('j')]).s.top).toBe(80)
    expect(run([ch('G'), ch('b'), ch('g')]).s.top).toBe(0)
    expect(run([{ type: 'end' }, { type: 'home' }]).s.top).toBe(0)
  })

  it('closes on q, Esc and Ctrl-C, and asks for the editor on v', () => {
    expect(run([ch('q')]).outcome).toEqual({ kind: 'close' })
    expect(run([{ type: 'escape' }]).outcome).toEqual({ kind: 'close' })
    expect(run([{ type: 'interrupt' }]).outcome).toEqual({ kind: 'close' })
    expect(run([ch('v')]).outcome).toEqual({ kind: 'edit' })
    // A batched chunk stops at the key that ends it.
    expect(run([ch('jjq')]).outcome).toEqual({ kind: 'close' })
  })

  it('searches with /, and steps through hits with n and N, wrapping round', () => {
    const found = run([ch('/'), ch('NEEDLE'), { type: 'enter' }])
    expect(found.s.top).toBe(42)
    expect(found.s.query).toBe('NEEDLE')
    expect(found.s.message).toBe('match 1 of 2')
    expect(run([ch('n')], found.s).s.top).toBe(77)
    const wrapped = run([ch('n')], { ...found.s, top: 77 })
    expect(wrapped.s.top).toBe(42)
    expect(wrapped.s.message).toContain('from the top')
    expect(run([ch('N')], found.s).s.message).toContain('from the bottom')
    expect(run([ch('N')], { ...found.s, top: 77 }).s.top).toBe(42)
  })

  // Opened at the bottom, a match in the last screenful sits below `top`: n found it
  // again forever, never reaching the next one or wrapping.
  it('n and N step past matches in the last screenful', () => {
    const tail: TranscriptDoc = {
      lines: Array.from({ length: 100 }, (_, i) => ([10, 85, 95].includes(i) ? `hit ${i}` : `line ${i}`)),
      prompts: []
    }
    const go = (keys: EditorKey[], from: PagerState): PagerState => {
      let s = from
      for (const k of keys) s = reducePager(s, k, { doc: tail, height: 20 }).state
      return s
    }
    const found = go([ch('/'), ch('hit'), { type: 'enter' }], { ...initialPagerState(), top: 80 })
    expect(found.message).toBe('match 2 of 3')
    const third = go([ch('n')], found)
    expect(third.message).toBe('match 3 of 3')
    const wrapped = go([ch('n')], third)
    expect(wrapped.message).toBe('match 1 of 3, from the top')
    expect(wrapped.top).toBe(10)
    expect(go([ch('N')], third).message).toBe('match 2 of 3')
  })

  it('edits and cancels a search being typed', () => {
    const typing = run([ch('/'), ch('nee'), { type: 'backspace' }])
    expect(typing.s.input).toBe('ne')
    expect(run([{ type: 'escape' }], typing.s).s.input).toBeNull()
    // Esc while typing cancels the search; it does not close the viewer.
    expect(run([{ type: 'escape' }], typing.s).outcome).toBeUndefined()
    const missing = run([ch('/'), ch('zzz'), { type: 'enter' }])
    expect(missing.s.message).toBe('no match for "zzz"')
    expect(missing.s.top).toBe(0)
    expect(run([ch('n')]).s.message).toContain('press / to search')
  })

  it('jumps between your messages with { and }', () => {
    expect(run([ch('}')]).s.top).toBe(30)
    expect(run([ch('}}')]).s.top).toBe(60)
    expect(run([ch('}}}')]).s.message).toBe('no later message from you')
    expect(run([ch('{')], { ...initialPagerState(), top: 61 }).s.top).toBe(60)
    expect(run([ch('{')], { ...initialPagerState(), top: 0 }).s.message).toBe('no earlier message from you')
  })

  it('finds hits case-insensitively', () => {
    expect(searchMatches(doc, 'NeEdLe')).toEqual([42, 77])
    expect(searchMatches(doc, '')).toEqual([])
  })
})

describe('renderPagerScreen', () => {
  const doc: TranscriptDoc = { lines: ['alpha', 'beta needle', 'gamma'], prompts: [0] }

  it('fills exactly the screen, every row narrower than it', () => {
    const rows = renderPagerScreen(initialPagerState(), doc, { rows: 6, cols: 40, title: 'My chat', paint: plain })
    expect(rows).toHaveLength(6)
    expect(rows.slice(0, 3)).toEqual(['alpha', 'beta needle', 'gamma'])
    expect(rows[3]).toBe('~')
    for (const r of rows) expect(visibleWidth(r)).toBeLessThan(40)
    expect(stripAnsi(rows[5])).toContain('My chat · lines 1-3 of 3 (100%)')
  })

  it('highlights search hits and shows the search being typed', () => {
    const s = { ...initialPagerState(), query: 'needle' }
    const rows = renderPagerScreen(s, doc, { rows: 6, cols: 40, title: 't', paint: plain })
    expect(rows[1]).toBe('beta \x1b[7mneedle\x1b[27m')
    const typing = renderPagerScreen({ ...s, input: 'nee' }, doc, { rows: 6, cols: 40, title: 't', paint: plain })
    expect(typing[5]).toBe('/nee')
  })

  it('cuts a long title or line to the width', () => {
    const wide: TranscriptDoc = { lines: ['x'.repeat(200)], prompts: [] }
    const rows = renderPagerScreen(initialPagerState(), wide, { rows: 3, cols: 30, title: 'T'.repeat(100), paint: plain })
    for (const r of rows) expect(visibleWidth(r)).toBeLessThan(30)
  })
})

describe('rewrapTop', () => {
  it('keeps the same place in a rewrapped document', () => {
    expect(rewrapTop(50, 100, 200)).toBe(100)
    expect(rewrapTop(0, 100, 50)).toBe(0)
    expect(rewrapTop(5, 0, 50)).toBe(0)
  })
})
