import { describe, expect, it } from 'vitest'
import { isPlanDecision } from './agent'

describe('isPlanDecision', () => {
  it('accepts a valid accept decision with a known mode', () => {
    expect(isPlanDecision({ kind: 'accept', mode: 'auto-edit' })).toBe(true)
    expect(isPlanDecision({ kind: 'accept', mode: 'ask' })).toBe(true)
  })

  it('accepts an accept decision carrying a hand-edited plan body', () => {
    expect(isPlanDecision({ kind: 'accept', mode: 'auto-edit', editedBody: '## Edited' })).toBe(true)
  })

  it('rejects an accept whose editedBody is not a string', () => {
    expect(isPlanDecision({ kind: 'accept', mode: 'auto-edit', editedBody: 42 })).toBe(false)
  })

  it('accepts a suggest decision with a string note, and a bare reject', () => {
    expect(isPlanDecision({ kind: 'suggest', note: 'change this' })).toBe(true)
    expect(isPlanDecision({ kind: 'reject' })).toBe(true)
  })

  it('rejects an accept with an unknown mode', () => {
    // A non-'ask'/'auto-edit' mode must not slip through — it would silently leave
    // Plan mode into an unintended policy at the loop boundary.
    expect(isPlanDecision({ kind: 'accept', mode: 'full-auto' })).toBe(false)
    expect(isPlanDecision({ kind: 'accept' })).toBe(false)
  })

  it('rejects a suggest without a string note', () => {
    expect(isPlanDecision({ kind: 'suggest' })).toBe(false)
    expect(isPlanDecision({ kind: 'suggest', note: 42 })).toBe(false)
  })

  it('rejects unknown kinds and non-objects', () => {
    expect(isPlanDecision({ kind: 'nope' })).toBe(false)
    expect(isPlanDecision('accept')).toBe(false)
    expect(isPlanDecision(null)).toBe(false)
    expect(isPlanDecision(undefined)).toBe(false)
  })
})
