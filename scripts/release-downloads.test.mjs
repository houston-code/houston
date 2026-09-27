import { describe, it, expect } from 'vitest'
import { downloadsTable } from './release-downloads.mjs'

const REPO = 'houston-code/houston'
const TAG = 'v1.2.0'
const ASSETS = [
  'Houston-1.2.0-arm64.dmg',
  'Houston-1.2.0-arm64-mac.zip',
  'Houston-1.2.0-arm64-mac.zip.blockmap',
  'Houston-1.2.0-x64.dmg',
  'Houston-1.2.0-x64-mac.zip',
  'Houston-1.2.0-x64-setup.exe',
  'Houston-1.2.0-x64-setup.exe.blockmap',
  'Houston-1.2.0-x86_64.AppImage',
  'Houston-1.2.0-x86_64.AppImage.asc',
  'Houston-1.2.0-amd64.deb',
  'Houston-1.2.0-amd64.deb.asc',
  'houston-cli.cjs',
  'houston-cli.cjs.cosign.bundle',
  'SHA256SUMS',
  'latest-mac.yml',
]
const url = (name) => `https://github.com/${REPO}/releases/download/${TAG}/${name}`

describe('downloadsTable', () => {
  const table = downloadsTable(ASSETS, REPO, TAG)

  it('links one installer per platform row', () => {
    expect(table).toContain(`| macOS, Apple Silicon | [Houston-1.2.0-arm64.dmg](${url('Houston-1.2.0-arm64.dmg')}) |`)
    expect(table).toContain(`| macOS, Intel | [Houston-1.2.0-x64.dmg](${url('Houston-1.2.0-x64.dmg')}) |`)
    expect(table).toContain(`| Windows, x64 | [Houston-1.2.0-x64-setup.exe](${url('Houston-1.2.0-x64-setup.exe')}) |`)
    expect(table).toContain(`| Terminal CLI, any OS | [houston-cli.cjs](${url('houston-cli.cjs')}) |`)
  })

  it('puts both Linux packages in one row', () => {
    expect(table).toContain(
      `| Linux, x64 | [Houston-1.2.0-x86_64.AppImage](${url('Houston-1.2.0-x86_64.AppImage')})<br>[Houston-1.2.0-amd64.deb](${url('Houston-1.2.0-amd64.deb')}) |`,
    )
  })

  it('never links a zip, blockmap, signature or feed', () => {
    const linked = [...table.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1])
    expect(linked.filter((u) => /\.(zip|blockmap|asc|bundle|yml)$/.test(u))).toEqual([])
  })

  it('points at the signed checksum manifest when the release has one', () => {
    expect(table).toContain(`[SHA256SUMS](${url('SHA256SUMS')})`)
    expect(downloadsTable(ASSETS.filter((n) => n !== 'SHA256SUMS'), REPO, TAG)).not.toContain('SHA256SUMS')
  })

  it('fails when a platform installer is missing', () => {
    expect(() => downloadsTable(ASSETS.filter((n) => !n.endsWith('-x64.dmg')), REPO, TAG)).toThrow('macOS, Intel')
    expect(() => downloadsTable(ASSETS.filter((n) => !n.endsWith('.deb')), REPO, TAG)).toThrow('Linux, x64')
  })

  it('fails when a matcher is ambiguous', () => {
    expect(() => downloadsTable([...ASSETS, 'Houston-1.2.0-extra-x64.dmg'], REPO, TAG)).toThrow('macOS, Intel')
  })

  it('contains no em dashes (it is customer-facing)', () => {
    expect(table).not.toContain('—')
  })
})
