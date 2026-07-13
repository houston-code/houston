import { describe, it, expect } from 'vitest'
import { ComposerBuffer } from './tui-composer'

describe('ComposerBuffer', () => {
  it('submits a single line immediately', () => {
    const c = new ComposerBuffer()
    expect(c.push('hello')).toBe('hello')
    expect(c.pending).toBe(false)
  })

  it('continues on a trailing backslash and joins with newlines', () => {
    const c = new ComposerBuffer()
    expect(c.push('line one \\')).toBeNull()
    expect(c.pending).toBe(true)
    expect(c.push('line two')).toBe('line one \nline two')
  })

  it('treats a doubled backslash as a literal, not a continuation', () => {
    const c = new ComposerBuffer()
    expect(c.push('path\\\\')).toBe('path\\\\')
  })

  it('keeps reading inside an open code fence until it closes', () => {
    const c = new ComposerBuffer()
    expect(c.push('```ts')).toBeNull()
    expect(c.push('const x = 1')).toBeNull()
    expect(c.push('```')).toBe('```ts\nconst x = 1\n```')
  })

  it('handles a fence opened after some text', () => {
    const c = new ComposerBuffer()
    expect(c.push('here is code:')).toBe('here is code:') // no fence yet → submits
  })

  it('flush() submits whatever is buffered (e.g. at EOF)', () => {
    const c = new ComposerBuffer()
    c.push('unterminated \\')
    expect(c.flush()).toBe('unterminated ')
    expect(c.pending).toBe(false)
  })

  it('reports inFence so the driver can hint how to close an open fence', () => {
    const c = new ComposerBuffer()
    expect(c.inFence).toBe(false)
    c.push('```ts')
    expect(c.inFence).toBe(true) // pending because of the fence, not a backslash
    c.push('code')
    expect(c.inFence).toBe(true)
    expect(c.push('```')).toBe('```ts\ncode\n```') // typing the close fence submits
    expect(c.inFence).toBe(false)
  })

  it('a trailing backslash is a continuation, not a fence', () => {
    const c = new ComposerBuffer()
    c.push('line one \\')
    expect(c.pending).toBe(true)
    expect(c.inFence).toBe(false)
  })

  it('normalizes a CRLF tail so backslash-continuation survives a \\r\\n stream', () => {
    const c = new ComposerBuffer()
    expect(c.push('continue \\\r')).toBeNull() // \r must not defeat the trailing backslash
    expect(c.push('second')).toBe('continue \nsecond')
  })
})
