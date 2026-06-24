import { describe, it, expect } from 'vitest'
import { extractExtraResources, sourceIsPresent, packageFromResourcePath } from './verify-bundled-binaries.mjs'

describe('extractExtraResources', () => {
  it('normalizes object and string entries to { from, to }', () => {
    const config = {
      extraResources: [
        { from: 'node_modules/@vscode/ripgrep-darwin-arm64/bin/rg', to: 'bin/rg' },
        'build/extra.txt'
      ]
    }
    expect(extractExtraResources(config)).toEqual([
      { from: 'node_modules/@vscode/ripgrep-darwin-arm64/bin/rg', to: 'bin/rg' },
      { from: 'build/extra.txt', to: 'build/extra.txt' }
    ])
  })

  it('drops malformed entries and tolerates a missing/blank list', () => {
    expect(extractExtraResources({ extraResources: [null, {}, { to: 'bin/x' }] })).toEqual([])
    expect(extractExtraResources({})).toEqual([])
    expect(extractExtraResources(null)).toEqual([])
  })
})

describe('sourceIsPresent', () => {
  const stat = (size, isDir = false) => () => ({ size, isDirectory: () => isDir })

  it('is false when the path does not exist', () => {
    expect(sourceIsPresent('/x', { exists: () => false, stat: stat(100) })).toBe(false)
  })

  it('is false for a 0-byte file (a truncated/broken binary)', () => {
    expect(sourceIsPresent('/x', { exists: () => true, stat: stat(0) })).toBe(false)
  })

  it('is true for a non-empty file', () => {
    expect(sourceIsPresent('/x', { exists: () => true, stat: stat(4_528_512) })).toBe(true)
  })

  it('accepts directories regardless of reported size', () => {
    expect(sourceIsPresent('/x', { exists: () => true, stat: stat(0, true) })).toBe(true)
  })

  it('is false when stat throws', () => {
    const throwingStat = () => {
      throw new Error('EACCES')
    }
    expect(sourceIsPresent('/x', { exists: () => true, stat: throwingStat })).toBe(false)
  })
})

describe('packageFromResourcePath', () => {
  it('extracts a scoped package name', () => {
    expect(packageFromResourcePath('node_modules/@ast-grep/cli-darwin-arm64/ast-grep')).toBe(
      '@ast-grep/cli-darwin-arm64'
    )
    expect(packageFromResourcePath('node_modules/@vscode/ripgrep-darwin-arm64/bin/rg')).toBe(
      '@vscode/ripgrep-darwin-arm64'
    )
  })

  it('extracts an unscoped package name', () => {
    expect(packageFromResourcePath('node_modules/some-pkg/bin/tool')).toBe('some-pkg')
  })

  it('uses the last node_modules segment for nested installs', () => {
    expect(packageFromResourcePath('node_modules/a/node_modules/@scope/b/bin')).toBe('@scope/b')
  })

  it('returns null for paths outside node_modules', () => {
    expect(packageFromResourcePath('build/icon.icns')).toBeNull()
  })
})
