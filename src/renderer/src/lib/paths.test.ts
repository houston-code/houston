import { describe, expect, it } from 'vitest'
import { baseName, shortenPath } from './paths'

describe('baseName', () => {
  it('takes the last segment of a POSIX path', () => {
    expect(baseName('/Users/me/code/houston')).toBe('houston')
    expect(baseName('/Users/me/code/houston/')).toBe('houston')
    expect(baseName('src/app.ts')).toBe('app.ts')
  })

  it('takes the last segment of a Windows path', () => {
    expect(baseName('C:\\Users\\me\\code\\houston')).toBe('houston')
    expect(baseName('C:\\Users\\me\\code\\houston\\')).toBe('houston')
    expect(baseName('D:/work/proj')).toBe('proj')
  })

  it('returns a bare name, or the input when there is nothing to take', () => {
    expect(baseName('houston')).toBe('houston')
    expect(baseName('/')).toBe('/')
  })
})

describe('shortenPath', () => {
  it('keeps the last two segments of a long POSIX path', () => {
    expect(shortenPath('/Users/me/code/houston/src/app.ts')).toBe('…/src/app.ts')
  })

  it('keeps the last two segments of a long Windows path, with its separator', () => {
    expect(shortenPath('C:\\Users\\me\\code\\houston\\src\\app.ts')).toBe('…\\src\\app.ts')
  })

  it('leaves a short path alone', () => {
    expect(shortenPath('src/app.ts')).toBe('src/app.ts')
    expect(shortenPath('app.ts')).toBe('app.ts')
  })
})
