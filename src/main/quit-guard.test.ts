import { describe, expect, it } from 'vitest'
import { shouldConfirmQuit, quitConfirmDetail } from './quit-guard'

describe('shouldConfirmQuit', () => {
  it('does not confirm when nothing is running', () => {
    expect(shouldConfirmQuit(0)).toBe(false)
  })

  it('confirms when one or more runs are live', () => {
    expect(shouldConfirmQuit(1)).toBe(true)
    expect(shouldConfirmQuit(5)).toBe(true)
  })
})

describe('quitConfirmDetail', () => {
  it('uses the singular for a single live run', () => {
    const detail = quitConfirmDetail(1)
    expect(detail).toContain('A chat is still running')
    // Singular object pronoun — "stop it", not "stop them".
    expect(detail).toContain('stop it')
    expect(detail).not.toContain('chats')
  })

  it('uses the plural and the count for multiple live runs', () => {
    const detail = quitConfirmDetail(3)
    expect(detail).toContain('3 chats are still running')
    expect(detail).toContain('stop them')
  })
})
