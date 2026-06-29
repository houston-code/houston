import { describe, expect, it } from 'vitest'
import { LEGAL_VERSION, needsLegalAcceptance } from './legal'

describe('needsLegalAcceptance', () => {
  it('requires acceptance when nothing has been accepted yet', () => {
    expect(needsLegalAcceptance(undefined)).toBe(true)
    expect(needsLegalAcceptance(0)).toBe(true)
  })

  it('requires re-acceptance when the accepted version is older than current', () => {
    expect(needsLegalAcceptance(LEGAL_VERSION - 1)).toBe(true)
  })

  it('does not require acceptance once the current version is accepted', () => {
    expect(needsLegalAcceptance(LEGAL_VERSION)).toBe(false)
    expect(needsLegalAcceptance(LEGAL_VERSION + 1)).toBe(false)
  })
})
