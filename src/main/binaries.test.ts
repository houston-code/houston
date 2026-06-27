import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { resolveBundledBinary, bundledRipgrep, bundledAstGrep, withExeSuffix } from './binaries'

describe('withExeSuffix', () => {
  it('appends .exe only on win32', () => {
    expect(withExeSuffix('rg', 'win32')).toBe('rg.exe')
    expect(withExeSuffix('rg', 'darwin')).toBe('rg')
    expect(withExeSuffix('ast-grep', 'linux')).toBe('ast-grep')
  })
})

describe('resolveBundledBinary', () => {
  it('returns the Resources/bin path when the binary exists (POSIX)', () => {
    const resourcesPath = '/Applications/Houston.app/Contents/Resources'
    const expected = join(resourcesPath, 'bin', 'rg')
    expect(
      resolveBundledBinary('rg', { resourcesPath, exists: (p) => p === expected, platform: 'darwin' })
    ).toBe(expected)
  })

  it('resolves the .exe-suffixed binary on Windows', () => {
    const resourcesPath = 'C:\\Program Files\\Houston\\resources'
    const expected = join(resourcesPath, 'bin', 'rg.exe')
    expect(
      resolveBundledBinary('rg', { resourcesPath, exists: (p) => p === expected, platform: 'win32' })
    ).toBe(expected)
    // The un-suffixed name must NOT resolve on Windows.
    const unsuffixed = join(resourcesPath, 'bin', 'rg')
    expect(
      resolveBundledBinary('rg', { resourcesPath, exists: (p) => p === unsuffixed, platform: 'win32' })
    ).toBeNull()
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
    expect(bundledRipgrep({ resourcesPath, exists: (p) => p === expected, platform: 'darwin' })).toBe(
      expected
    )
  })

  it('bundledAstGrep resolves the "ast-grep" binary under Resources/bin', () => {
    const resourcesPath = '/res'
    const expected = join(resourcesPath, 'bin', 'ast-grep')
    expect(bundledAstGrep({ resourcesPath, exists: (p) => p === expected, platform: 'darwin' })).toBe(
      expected
    )
  })
})
