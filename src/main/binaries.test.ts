import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { resolveBundledBinary, bundledRipgrep, bundledAstGrep } from './binaries'

describe('resolveBundledBinary', () => {
  it('returns the Resources/bin path when the binary exists', () => {
    const resourcesPath = '/Applications/Houston.app/Contents/Resources'
    const expected = join(resourcesPath, 'bin', 'rg')
    expect(resolveBundledBinary('rg', { resourcesPath, exists: (p) => p === expected })).toBe(expected)
  })

  it('returns null when the bundled binary is missing', () => {
    expect(resolveBundledBinary('rg', { resourcesPath: '/res', exists: () => false })).toBeNull()
  })

  it('returns null when there is no resources path (e.g. development/tests)', () => {
    expect(resolveBundledBinary('rg', { resourcesPath: undefined, exists: () => true })).toBeNull()
  })

  it('bundledRipgrep resolves the "rg" binary under Resources/bin', () => {
    const resourcesPath = '/res'
    const expected = join(resourcesPath, 'bin', 'rg')
    expect(bundledRipgrep({ resourcesPath, exists: (p) => p === expected })).toBe(expected)
  })

  it('bundledAstGrep resolves the "ast-grep" binary under Resources/bin', () => {
    const resourcesPath = '/res'
    const expected = join(resourcesPath, 'bin', 'ast-grep')
    expect(bundledAstGrep({ resourcesPath, exists: (p) => p === expected })).toBe(expected)
  })
})
