import { describe, expect, it } from 'vitest'
import { checkpointNotice } from './checkpointNotice'

describe('checkpointNotice', () => {
  it('says nothing when every file was put back (the bar shows it)', () => {
    expect(checkpointNotice('revert', 3, 3)).toBeNull()
    expect(checkpointNotice('redo', 1, 1)).toBeNull()
  })

  it('reports a revert or redo that restored nothing', () => {
    expect(checkpointNotice('revert', 0, 2)).toMatch(/^Couldn't revert this turn's changes/)
    expect(checkpointNotice('redo', 0, 2)).toMatch(/^Couldn't redo this turn's changes/)
  })

  it('reports a partial restore with both counts', () => {
    expect(checkpointNotice('revert', 1, 3)).toBe("Reverted 1 of 3 files; the rest couldn't be restored.")
    expect(checkpointNotice('redo', 2, 3)).toBe("Re-applied 2 of 3 files; the rest couldn't be restored.")
  })
})
