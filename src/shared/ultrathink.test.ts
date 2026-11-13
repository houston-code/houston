import { describe, expect, it } from 'vitest'
import { systemNoteMessage } from './agent'
import { providerSendsXhigh } from './model-facts'
import {
  findUltrathink,
  hasUltrathink,
  splitByRanges,
  ultrathinkAtTail,
  ultrathinkEffect,
  ultrathinkHint,
  ULTRATHINK_HINT,
  ULTRATHINK_HINT_ALREADY,
  ULTRATHINK_HINT_NONE,
  ULTRATHINK_NOTE
} from './ultrathink'

describe('findUltrathink', () => {
  it('finds the keyword as a word of its own, anywhere in the message', () => {
    expect(findUltrathink('ultrathink')).toEqual([{ start: 0, end: 10 }])
    expect(findUltrathink('fix the flaky test, ultrathink')).toEqual([{ start: 20, end: 30 }])
    expect(hasUltrathink('please ultrathink about the migration order')).toBe(true)
  })

  it('ignores case', () => {
    expect(hasUltrathink('Ultrathink: why does this deadlock?')).toBe(true)
    expect(hasUltrathink('ULTRATHINK')).toBe(true)
  })

  it('accepts sentence punctuation around the word', () => {
    expect(hasUltrathink('Plan the refactor. Ultrathink.')).toBe(true)
    expect(hasUltrathink('(ultrathink) plan the refactor')).toBe(true)
    expect(hasUltrathink('ultrathink, then answer')).toBe(true)
    expect(hasUltrathink('can you ultrathink?')).toBe(true)
    expect(hasUltrathink('line one\nultrathink\nline three')).toBe(true)
  })

  it('reports every use', () => {
    expect(findUltrathink('ultrathink and ultrathink')).toEqual([
      { start: 0, end: 10 },
      { start: 15, end: 25 }
    ])
  })

  it('skips the word inside a longer name', () => {
    expect(hasUltrathink('ultrathinking about it')).toBe(false)
    expect(hasUltrathink('the ultrathink_mode flag')).toBe(false)
    expect(hasUltrathink('megaultrathink')).toBe(false)
    expect(hasUltrathink('ultrathink2')).toBe(false)
  })

  it('skips file names, paths and flags', () => {
    expect(hasUltrathink('open src/shared/ultrathink.ts')).toBe(false)
    expect(hasUltrathink('read ultrathink.ts')).toBe(false)
    expect(hasUltrathink('look in src/ultrathink')).toBe(false)
    expect(hasUltrathink('C:\\repo\\ultrathink')).toBe(false)
    expect(hasUltrathink('run it with --ultrathink')).toBe(false)
    expect(hasUltrathink('the branch is piyush/ultrathink-mode')).toBe(false)
    expect(hasUltrathink('config.ultrathink')).toBe(false)
  })

  it('skips a quoted mention', () => {
    expect(hasUltrathink('what does "ultrathink" do?')).toBe(false)
    expect(hasUltrathink("what does 'ultrathink' do?")).toBe(false)
    expect(hasUltrathink('what does \u201Cultrathink\u201D do?')).toBe(false)
  })

  it('skips code spans and fenced blocks', () => {
    expect(hasUltrathink('what does `ultrathink` do?')).toBe(false)
    expect(hasUltrathink('see `if (ultrathink ) boost()` here')).toBe(false)
    expect(hasUltrathink('```\nultrathink\n```')).toBe(false)
    expect(hasUltrathink('```ts\nconst a = 1\nultrathink here')).toBe(false)
  })

  it('still finds a use outside the code in the same message', () => {
    expect(findUltrathink('`ultrathink` is the word. ultrathink')).toEqual([{ start: 26, end: 36 }])
  })

  it('stays fast on a large paste full of the word and of code', () => {
    const big = '`x` ultrathink.ts "ultrathink" '.repeat(50_000)
    const started = Date.now()
    expect(findUltrathink(big)).toEqual([])
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('finds nothing in text without the word', () => {
    expect(findUltrathink('')).toEqual([])
    expect(findUltrathink('think hard about this')).toEqual([])
  })

  it('gives the same answer on repeated calls', () => {
    expect(hasUltrathink('ultrathink')).toBe(true)
    expect(hasUltrathink('ultrathink')).toBe(true)
  })
})

describe('ultrathinkAtTail', () => {
  const note = systemNoteMessage(ULTRATHINK_NOTE)

  it('reads the user message a run starts from', () => {
    expect(ultrathinkAtTail([{ role: 'user', content: 'ultrathink' }])).toEqual({ on: true, noted: false })
    expect(ultrathinkAtTail([{ role: 'user', content: 'hello' }])).toEqual({ on: false, noted: false })
  })

  it('looks past the notes after it, and reports the one already given', () => {
    const other = systemNoteMessage('The user switched to Plan mode.')
    expect(ultrathinkAtTail([{ role: 'user', content: 'ultrathink' }, other])).toEqual({ on: true, noted: false })
    expect(ultrathinkAtTail([{ role: 'user', content: 'ultrathink' }, note, other])).toEqual({ on: true, noted: true })
  })

  it('reads only the newest user message', () => {
    expect(
      ultrathinkAtTail([
        { role: 'user', content: 'ultrathink' },
        note,
        { role: 'assistant', content: 'done' },
        { role: 'user', content: 'now rename it' }
      ])
    ).toEqual({ on: false, noted: false })
  })

  it('finds nothing on a continued turn or an empty log', () => {
    expect(ultrathinkAtTail([])).toEqual({ on: false, noted: false })
    expect(
      ultrathinkAtTail([
        { role: 'user', content: 'ultrathink' },
        { role: 'assistant', content: 'working' }
      ])
    ).toEqual({ on: false, noted: false })
  })

  it('reads what the user typed, not a prompt Houston wrote for them', () => {
    const brief = 'Review the diff. ultrathink'
    expect(
      ultrathinkAtTail([{ role: 'user', content: brief, invokedAs: { kind: 'command', label: '/review' } }])
    ).toEqual({ on: false, noted: false })
    expect(
      ultrathinkAtTail([
        {
          role: 'user',
          content: 'Review the diff.',
          invokedAs: { kind: 'command', label: '/review', typed: '/review ultrathink' }
        }
      ])
    ).toEqual({ on: true, noted: false })
  })

  it('never reads the keyword out of a note Houston wrote', () => {
    expect(ultrathinkAtTail([{ role: 'user', content: 'hello' }, note])).toEqual({ on: false, noted: true })
  })
})

describe('ultrathinkEffect', () => {
  it('raises any level below the top on a model that reasons', () => {
    for (const effort of ['off', 'low', 'medium', 'high'] as const) {
      expect(ultrathinkEffect(effort, true, true)).toBe('raises')
    }
    expect(ultrathinkEffect(undefined, true, true)).toBe('raises')
  })

  it('has nothing to raise in a chat already at the top', () => {
    expect(ultrathinkEffect('xhigh', true, true)).toBe('already')
    expect(ultrathinkEffect('xhigh', true, false)).toBe('already')
  })

  it('counts high as the top where the provider clamps xhigh to it', () => {
    expect(ultrathinkEffect('high', true, false)).toBe('already')
    expect(ultrathinkEffect('medium', true, false)).toBe('raises')
    expect(ultrathinkEffect('off', true, false)).toBe('raises')
  })

  it('does nothing on a model that cannot reason, whatever the chat is set to', () => {
    expect(ultrathinkEffect('high', false, true)).toBe('none')
    expect(ultrathinkEffect('xhigh', false, false)).toBe('none')
  })

  it('has a hint for each effect that promises only what the turn gets', () => {
    expect(ultrathinkHint('raises')).toBe(ULTRATHINK_HINT)
    expect(ultrathinkHint('already')).toBe(ULTRATHINK_HINT_ALREADY)
    expect(ultrathinkHint('none')).toBe(ULTRATHINK_HINT_NONE)
  })
})

describe('providerSendsXhigh', () => {
  it('follows the model on the Claude hosts', () => {
    for (const kind of ['anthropic', 'bedrock', 'vertex', 'foundry'] as const) {
      expect(providerSendsXhigh(kind, 'claude-opus-4-8', false)).toBe(true)
      expect(providerSendsXhigh(kind, 'claude-opus-4-6', false)).toBe(false)
    }
  })

  it('is true for hosted OpenAI and false once a base URL routes it to Chat Completions', () => {
    expect(providerSendsXhigh('openai', 'gpt-5.5', false)).toBe(true)
    expect(providerSendsXhigh('openai', 'gpt-5.5', true)).toBe(false)
  })

  it('is false wherever the request builder clamps to high', () => {
    expect(providerSendsXhigh('openai-compatible', 'deepseek/deepseek-r1', true)).toBe(false)
    expect(providerSendsXhigh('azure-openai', 'gpt-5.5', false)).toBe(false)
    expect(providerSendsXhigh('gemini', 'gemini-3-pro', false)).toBe(false)
  })
})

describe('splitByRanges', () => {
  it('cuts the text into keyword and plain runs that join back to the text', () => {
    const text = 'ultrathink, then ultrathink again'
    const parts = splitByRanges(text, findUltrathink(text))!
    expect(parts).toEqual([
      { text: 'ultrathink', keyword: true },
      { text: ', then ', keyword: false },
      { text: 'ultrathink', keyword: true },
      { text: ' again', keyword: false }
    ])
    expect(parts.map((p) => p.text).join('')).toBe(text)
  })

  it('is null when nothing is marked', () => {
    expect(splitByRanges('hello', [])).toBeNull()
  })
})
