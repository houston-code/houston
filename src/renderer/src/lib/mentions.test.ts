import { describe, expect, it } from 'vitest'
import { applyMention, mentionBeforeCursor } from './mentions'

describe('mentionBeforeCursor', () => {
  it('detects a mention at the start of the input', () => {
    expect(mentionBeforeCursor('@src')).toEqual({ start: 0, query: 'src' })
  })

  it('detects a mention after whitespace', () => {
    expect(mentionBeforeCursor('look at @app.ts')).toEqual({ start: 8, query: 'app.ts' })
  })

  it('detects an empty mention right after typing @', () => {
    expect(mentionBeforeCursor('check @')).toEqual({ start: 6, query: '' })
  })

  it('does not trigger on an email-like token (no preceding space)', () => {
    expect(mentionBeforeCursor('mailto user@host')).toBeNull()
  })

  it('does not trigger when the token is followed by a space', () => {
    expect(mentionBeforeCursor('@app.ts ')).toBeNull()
  })

  it('returns null when there is no mention', () => {
    expect(mentionBeforeCursor('just some text')).toBeNull()
  })
})

describe('applyMention', () => {
  it('replaces the token with @path and a trailing space, reporting the caret', () => {
    const text = 'look at @app'
    const r = applyMention(text, { start: 8, query: 'app' }, 'src/app.ts')
    expect(r.text).toBe('look at @src/app.ts ')
    expect(r.caret).toBe(text.length - 'app'.length + 'src/app.ts'.length + 1) // after "@src/app.ts "
    expect(r.text[r.caret - 1]).toBe(' ')
  })

  it('preserves text after the cursor', () => {
    const r = applyMention('see @a end', { start: 4, query: 'a' }, 'b.ts')
    expect(r.text).toBe('see @b.ts  end')
  })
})
