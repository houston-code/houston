import { describe, expect, it } from 'vitest'
import { installHost } from './installHost'

describe('installHost', () => {
  it('finds Homebrew at its fixed install paths on macOS only', () => {
    expect(installHost('darwin', (p) => p === '/usr/local/bin/brew')).toEqual({
      platform: 'darwin',
      hasBrew: true
    })
    expect(installHost('darwin', () => false).hasBrew).toBe(false)
    expect(installHost('linux', () => true).hasBrew).toBe(false)
  })
})
