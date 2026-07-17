import { describe, it, expect } from 'vitest'
import { parseMemoryCapture } from './memory'

describe('parseMemoryCapture', () => {
  it('reads a #-prefixed line as a standing instruction', () => {
    expect(parseMemoryCapture('# always run the linter')).toBe('always run the linter')
    expect(parseMemoryCapture('#no space')).toBe('no space')
    expect(parseMemoryCapture('## use tabs')).toBe('use tabs') // extra # (a heading) is fine
  })

  it('is not a capture for a line that does not start with #', () => {
    expect(parseMemoryCapture('always run the linter')).toBeNull()
    expect(parseMemoryCapture('the # is mid-line')).toBeNull()
  })

  it('treats a bare # (or only #s/space) as not a note', () => {
    expect(parseMemoryCapture('#')).toBeNull()
    expect(parseMemoryCapture('###')).toBeNull()
    expect(parseMemoryCapture('#   ')).toBeNull()
  })
})
