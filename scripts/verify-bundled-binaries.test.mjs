import { describe, it, expect } from 'vitest'
import { targetKeys, expectedSources, sourceIsPresent, parseArgs } from './verify-bundled-binaries.mjs'

describe('targetKeys', () => {
  it('maps process.platform + arch to electron-builder target keys', () => {
    expect(targetKeys({ platform: 'win32', archs: ['x64'] })).toEqual(['win32-x64'])
    expect(targetKeys({ platform: 'linux', archs: ['x64', 'arm64'] })).toEqual([
      'linux-x64',
      'linux-arm64'
    ])
    expect(targetKeys({ platform: 'darwin', archs: ['arm64'] })).toEqual(['darwin-arm64'])
  })

  it('throws for an unsupported platform', () => {
    expect(() => targetKeys({ platform: 'sunos', archs: ['x64'] })).toThrow(/unsupported platform/)
  })
})

describe('expectedSources', () => {
  it('derives the right sub-package sources, with the -msvc suffix + .exe on Windows', () => {
    const sources = expectedSources(['win32-x64'])
    expect(sources).toContainEqual({
      key: 'win32-x64',
      pkg: '@vscode/ripgrep-win32-x64',
      from: 'node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe'
    })
    expect(sources).toContainEqual({
      key: 'win32-x64',
      pkg: '@ast-grep/cli-win32-x64-msvc',
      from: 'node_modules/@ast-grep/cli-win32-x64-msvc/ast-grep.exe'
    })
  })

  it('uses the -gnu suffix for ast-grep on Linux', () => {
    expect(expectedSources(['linux-arm64']).map((s) => s.pkg)).toContain('@ast-grep/cli-linux-arm64-gnu')
  })

  it('throws for an unknown target key', () => {
    expect(() => expectedSources(['win32-ia32'])).toThrow(/no binary map/)
  })
})

describe('parseArgs', () => {
  it('collects repeatable --arch and an optional --platform', () => {
    expect(parseArgs(['--platform', 'win32', '--arch', 'x64', '--arch', 'arm64'])).toEqual({
      platform: 'win32',
      archs: ['x64', 'arm64']
    })
  })

  it('returns undefined archs/platform when not provided (→ host defaults)', () => {
    expect(parseArgs([])).toEqual({ platform: undefined, archs: undefined })
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
