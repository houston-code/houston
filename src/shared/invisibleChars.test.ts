import { describe, it, expect } from 'vitest'
import { stripInvisible, invisibleNote } from './invisibleChars'

describe('stripInvisible', () => {
  it('leaves ordinary text alone', () => {
    expect(stripInvisible('fix the bug in main.ts')).toEqual({ text: 'fix the bug in main.ts', removed: 0 })
    expect(stripInvisible('')).toEqual({ text: '', removed: 0 })
  })

  it('removes zero-width spaces, word joiners and BOMs', () => {
    expect(stripInvisible('a\u200bb\u2060c\ufeffd')).toEqual({ text: 'abcd', removed: 3 })
  })

  it('removes bidi embedding, override and isolate controls', () => {
    const s = 'ok\u202ePWNED\u202c and \u2066x\u2069'
    expect(stripInvisible(s)).toEqual({ text: 'okPWNED and x', removed: 4 })
  })

  it('removes tag characters that smuggle hidden ASCII', () => {
    // "hi" written in tag characters after visible text.
    const hidden = String.fromCodePoint(0xe0068, 0xe0069)
    expect(stripInvisible(`hello${hidden}`)).toEqual({ text: 'hello', removed: 2 })
  })

  it('keeps emoji ZWJ sequences whole', () => {
    const family = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}'
    const technologist = '\u{1f469}\u{1f3fd}\u200d\u{1f4bb}'
    const rainbowFlag = '\u{1f3f3}\ufe0f\u200d\u{1f308}'
    for (const e of [family, technologist, rainbowFlag]) {
      expect(stripInvisible(`look ${e}`)).toEqual({ text: `look ${e}`, removed: 0 })
    }
  })

  it('keeps a subdivision flag tag sequence', () => {
    const england = String.fromCodePoint(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f)
    expect(stripInvisible(`go ${england}!`)).toEqual({ text: `go ${england}!`, removed: 0 })
  })

  it('removes tags after a black flag that do not form a flag', () => {
    const notAFlag = String.fromCodePoint(0x1f3f4, 0xe0041, 0xe0042) // uppercase tags, no cancel
    expect(stripInvisible(notAFlag)).toEqual({ text: '\u{1f3f4}', removed: 2 })
  })

  it('keeps joiners between letters (Persian, Devanagari) but not stray ones', () => {
    const persian = 'می\u200cخواهم'
    expect(stripInvisible(persian)).toEqual({ text: persian, removed: 0 })
    const devanagari = 'क्\u200dष'
    expect(stripInvisible(devanagari)).toEqual({ text: devanagari, removed: 0 })
    // A joiner at the edge of a word, or between non-letters, carries nothing.
    expect(stripInvisible('a \u200d b\u200c')).toEqual({ text: 'a  b', removed: 2 })
  })

  it('words the note', () => {
    expect(invisibleNote(1)).toBe('removed 1 invisible character')
    expect(invisibleNote(3)).toBe('removed 3 invisible characters')
  })
})
