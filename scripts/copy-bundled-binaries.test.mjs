import { describe, it, expect } from 'vitest'
import { BINARY_MAP, ARCH_NAMES, planCopies, resourcesDirFor } from './copy-bundled-binaries.mjs'

describe('BINARY_MAP', () => {
  it('covers the six shipped (os, arch) targets', () => {
    expect(Object.keys(BINARY_MAP).sort()).toEqual(
      ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'].sort()
    )
  })

  it('uses the -gnu toolchain suffix for ast-grep on Linux', () => {
    expect(BINARY_MAP['linux-x64'].astGrep.pkg).toBe('@ast-grep/cli-linux-x64-gnu')
    expect(BINARY_MAP['linux-arm64'].astGrep.pkg).toBe('@ast-grep/cli-linux-arm64-gnu')
  })

  it('uses the -msvc toolchain suffix + .exe for Windows', () => {
    expect(BINARY_MAP['win32-x64'].astGrep.pkg).toBe('@ast-grep/cli-win32-x64-msvc')
    expect(BINARY_MAP['win32-x64'].astGrep.dest).toBe('ast-grep.exe')
    expect(BINARY_MAP['win32-x64'].rg.dest).toBe('rg.exe')
    expect(BINARY_MAP['win32-x64'].rg.file).toBe('bin/rg.exe')
  })

  it('has no toolchain suffix on macOS and the ast-grep binary at the package root', () => {
    expect(BINARY_MAP['darwin-arm64'].astGrep.pkg).toBe('@ast-grep/cli-darwin-arm64')
    expect(BINARY_MAP['darwin-arm64'].astGrep.file).toBe('ast-grep')
    expect(BINARY_MAP['darwin-arm64'].rg.file).toBe('bin/rg')
  })
})

describe('ARCH_NAMES', () => {
  it('maps electron-builder Arch enum indices to arch strings', () => {
    expect(ARCH_NAMES[1]).toBe('x64')
    expect(ARCH_NAMES[3]).toBe('arm64')
  })
})

describe('planCopies', () => {
  it('resolves the right sub-package paths for a Linux x64 build', () => {
    const plan = planCopies('linux', 'x64', { root: '/repo', resourcesDir: '/out/resources' })
    expect(plan).toEqual([
      { from: '/repo/node_modules/@vscode/ripgrep-linux-x64/bin/rg', to: '/out/resources/bin/rg' },
      { from: '/repo/node_modules/@ast-grep/cli-linux-x64-gnu/ast-grep', to: '/out/resources/bin/ast-grep' }
    ])
  })

  it('resolves .exe binaries for a Windows x64 build', () => {
    const plan = planCopies('win32', 'x64', { root: '/repo', resourcesDir: '/out/resources' })
    expect(plan.map((p) => p.to)).toEqual(['/out/resources/bin/rg.exe', '/out/resources/bin/ast-grep.exe'])
    expect(plan[1].from).toBe('/repo/node_modules/@ast-grep/cli-win32-x64-msvc/ast-grep.exe')
  })

  it('throws for an unmapped (platform, arch) so a build never ships wrong/missing binaries', () => {
    expect(() => planCopies('linux', 'armv7l', { root: '/r', resourcesDir: '/o' })).toThrow(/no vendored binaries/)
    expect(() => planCopies('darwin', 'universal', { root: '/r', resourcesDir: '/o' })).toThrow()
  })
})

describe('resourcesDirFor', () => {
  it('nests under the .app bundle on macOS (using productFilename)', () => {
    expect(resourcesDirFor('darwin', '/out/mac-arm64', 'Houston')).toBe(
      '/out/mac-arm64/Houston.app/Contents/Resources'
    )
  })

  it('uses <appOutDir>/resources on Windows and Linux', () => {
    expect(resourcesDirFor('win32', '/out/win', 'Houston')).toBe('/out/win/resources')
    expect(resourcesDirFor('linux', '/out/linux', 'Houston')).toBe('/out/linux/resources')
  })
})
