import { describe, expect, it } from 'vitest'
import { approvalAskReasonShort, approvalAskReasons } from './approvalReasons'

describe('approvalAskReasons', () => {
  it('is empty for an ordinary prompt', () => {
    expect(approvalAskReasons({})).toEqual([])
    expect(approvalAskReasonShort({})).toBeNull()
  })

  it('names each check that holds in every mode', () => {
    expect(approvalAskReasons({ discardsWork: true })).toEqual([expect.stringContaining('throw away work')])
    expect(approvalAskReasons({ escapesWorkspace: true })).toEqual([expect.stringContaining('outside the project folder')])
    expect(approvalAskReasons({ discardsWork: true, escapesWorkspace: true })).toHaveLength(2)
    expect(approvalAskReasonShort({ discardsWork: true, escapesWorkspace: true })).toBe(
      'can throw away work, reaches outside the project folder'
    )
  })

  it('has no em dashes in what the user reads', () => {
    for (const line of approvalAskReasons({ discardsWork: true, escapesWorkspace: true })) {
      expect(line).not.toContain('—')
    }
  })
})
