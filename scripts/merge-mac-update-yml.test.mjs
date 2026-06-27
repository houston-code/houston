import { describe, it, expect } from 'vitest'
import yaml from 'js-yaml'
import { mergeMacUpdateYml, isArm64File } from './merge-mac-update-yml.mjs'

const ARM = `version: 1.4.0
files:
  - url: Houston-1.4.0-arm64-mac.zip
    sha512: AAarm64zipAA==
    size: 100
    blockMapSize: 10
  - url: Houston-1.4.0-arm64.dmg
    sha512: AAarm64dmgAA==
    size: 101
path: Houston-1.4.0-arm64-mac.zip
sha512: AAarm64zipAA==
releaseDate: '2026-06-28T00:00:00.000Z'
`

const X64 = `version: 1.4.0
files:
  - url: Houston-1.4.0-x64-mac.zip
    sha512: BBx64zipBB==
    size: 200
    blockMapSize: 20
  - url: Houston-1.4.0-x64.dmg
    sha512: BBx64dmgBB==
    size: 201
path: Houston-1.4.0-x64-mac.zip
sha512: BBx64zipBB==
releaseDate: '2026-06-28T00:05:00.000Z'
`

/** Replica of electron-updater MacUpdater.filterFilesForArch, to prove end-to-end selection. */
function filterFilesForArch(files, isArm64Mac) {
  if (isArm64Mac && files.some(isArm64File)) return files.filter((f) => isArm64File(f))
  return files.filter((f) => !isArm64File(f))
}

describe('mergeMacUpdateYml', () => {
  it('lists both arches in one feed and preserves the arm64 base fields', () => {
    const merged = yaml.load(mergeMacUpdateYml(ARM, X64))
    expect(merged.version).toBe('1.4.0')
    expect(merged.path).toBe('Houston-1.4.0-arm64-mac.zip') // arm64 base wins
    expect(merged.releaseDate).toBe('2026-06-28T00:00:00.000Z') // arm64 base wins
    expect(merged.files.map((f) => f.url)).toEqual([
      'Houston-1.4.0-arm64-mac.zip',
      'Houston-1.4.0-arm64.dmg',
      'Houston-1.4.0-x64-mac.zip',
      'Houston-1.4.0-x64.dmg'
    ])
  })

  it('lets each arch self-select its zip the way electron-updater does', () => {
    const merged = yaml.load(mergeMacUpdateYml(ARM, X64))
    const armPick = filterFilesForArch(merged.files, true).filter((f) => f.url.endsWith('.zip'))
    const x64Pick = filterFilesForArch(merged.files, false).filter((f) => f.url.endsWith('.zip'))
    expect(armPick).toHaveLength(1)
    expect(armPick[0].url).toBe('Houston-1.4.0-arm64-mac.zip')
    expect(x64Pick).toHaveLength(1)
    expect(x64Pick[0].url).toBe('Houston-1.4.0-x64-mac.zip')
  })

  it('keeps the per-file checksums and sizes intact', () => {
    const merged = yaml.load(mergeMacUpdateYml(ARM, X64))
    const x64Zip = merged.files.find((f) => f.url === 'Houston-1.4.0-x64-mac.zip')
    expect(x64Zip.sha512).toBe('BBx64zipBB==')
    expect(x64Zip.size).toBe(200)
    expect(x64Zip.blockMapSize).toBe(20)
  })

  it('dedupes by url (idempotent if the same feed is merged twice)', () => {
    const merged1 = mergeMacUpdateYml(ARM, X64)
    const merged2 = mergeMacUpdateYml(merged1, X64)
    expect(yaml.load(merged2).files.map((f) => f.url)).toEqual(yaml.load(merged1).files.map((f) => f.url))
  })

  it('throws on a version mismatch (different releases must not be merged)', () => {
    const x64Other = X64.replace('version: 1.4.0', 'version: 1.4.1')
    expect(() => mergeMacUpdateYml(ARM, x64Other)).toThrow(/version mismatch/)
  })

  it('throws when the x64 feed contains no x64 files (e.g. the wrong feed was passed)', () => {
    // An x64 feed that only lists arm64 files leaves Intel with nothing to update to.
    expect(() => mergeMacUpdateYml(ARM, ARM)).toThrow(/no x64 files/)
  })

  it('throws when a feed is missing its files array', () => {
    expect(() => mergeMacUpdateYml('version: 1.4.0\n', X64)).toThrow(/no .files. array/)
  })
})

describe('isArm64File', () => {
  it('matches by "arm64" anywhere in the url, like MacUpdater', () => {
    expect(isArm64File({ url: 'Houston-1.4.0-arm64-mac.zip' })).toBe(true)
    expect(isArm64File({ url: 'Houston-1.4.0-x64-mac.zip' })).toBe(false)
    expect(isArm64File({})).toBe(false)
  })
})
