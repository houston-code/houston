import { describe, expect, it } from 'vitest'
import { parseToolArguments } from './tool-args'

describe('parseToolArguments', () => {
  it('reads a call with no arguments as an empty object', () => {
    expect(parseToolArguments('')).toEqual({})
    expect(parseToolArguments(undefined)).toEqual({})
  })

  it('parses a whole JSON object', () => {
    expect(parseToolArguments('{"path":"a.ts","n":2}')).toEqual({ path: 'a.ts', n: 2 })
  })

  it('returns null for JSON cut off mid-call', () => {
    expect(parseToolArguments('{"path":"a.ts","content":"export')).toBeNull()
  })

  it('returns null for JSON that is not an object', () => {
    for (const text of ['null', '[1,2]', '"text"', '42']) expect(parseToolArguments(text), text).toBeNull()
  })
})
