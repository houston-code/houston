import { describe, it, expect } from 'vitest'
import { checksummedAssets, missingRequired } from './release-checksums.mjs'

// A complete release, as the build legs upload it.
const DOWNLOADS = [
  'Houston-1.2.0-arm64.dmg',
  'Houston-1.2.0-arm64-mac.zip',
  'Houston-1.2.0-x64.dmg',
  'Houston-1.2.0-x64-mac.zip',
  'Houston-1.2.0-x64-setup.exe',
  'Houston-1.2.0-x64-win.zip',
  'Houston-1.2.0-x86_64.AppImage',
  'Houston-1.2.0-amd64.deb',
  'houston-cli.cjs',
  'THIRD-PARTY-NOTICES.md',
  'houston.openvex.json',
  'sbom.cyclonedx.json',
  'sbom.spdx.json',
  'sbom.spdx3.json',
  'sbom.binary.darwin-arm64.cyclonedx.json',
  'sbom.binary.darwin-arm64.spdx.json',
  'sbom.binary.darwin-x64.cyclonedx.json',
  'sbom.binary.darwin-x64.spdx.json',
  'sbom.binary.win32-x64.cyclonedx.json',
  'sbom.binary.win32-x64.spdx.json',
  'sbom.binary.linux-x64.cyclonedx.json',
  'sbom.binary.linux-x64.spdx.json',
]
const SIDECARS = [
  'Houston-1.2.0-arm64.dmg.blockmap',
  'Houston-1.2.0-arm64.dmg.cosign.bundle',
  'Houston-1.2.0-arm64.dmg.slsa.bundle',
  'Houston-1.2.0-x86_64.AppImage.asc',
  'houston-signing-key.asc',
  'latest-mac.yml',
  'latest.yml',
  'latest-linux.yml',
  'SHA256SUMS',
]

describe('checksummedAssets', () => {
  it('lists every download from every platform, sorted', () => {
    expect(checksummedAssets([...SIDECARS, ...DOWNLOADS])).toEqual([...DOWNLOADS].sort())
  })

  it('covers the mac and Windows installers (the gap it replaces)', () => {
    const listed = checksummedAssets(DOWNLOADS)
    for (const n of ['Houston-1.2.0-arm64.dmg', 'Houston-1.2.0-x64.dmg', 'Houston-1.2.0-x64-setup.exe']) {
      expect(listed).toContain(n)
    }
  })

  it('leaves out signatures, provenance, updater feeds and the manifest itself', () => {
    expect(checksummedAssets(SIDECARS)).toEqual([])
  })
})

describe('missingRequired', () => {
  it('is empty for a complete release', () => {
    expect(missingRequired(DOWNLOADS)).toEqual([])
  })

  it('names each platform download that never got uploaded', () => {
    const withoutIntel = DOWNLOADS.filter((n) => !n.includes('x64-mac') && !n.includes('x64.dmg') && !n.includes('darwin-x64'))
    expect(missingRequired(withoutIntel)).toEqual(['macOS x64 dmg', 'macOS x64 zip', 'darwin-x64 binary SBOM'])
  })

  it('does not count the arm64 zip as the Intel one', () => {
    const armOnly = DOWNLOADS.filter((n) => n !== 'Houston-1.2.0-x64-mac.zip')
    expect(missingRequired(armOnly)).toEqual(['macOS x64 zip'])
  })

  it('accepts the older arch-less Intel zip name', () => {
    const legacy = DOWNLOADS.map((n) => (n === 'Houston-1.2.0-x64-mac.zip' ? 'Houston-1.2.0-mac.zip' : n))
    expect(missingRequired(legacy)).toEqual([])
  })

  it('reports everything for an empty draft', () => {
    expect(missingRequired([])).toHaveLength(13)
  })
})
