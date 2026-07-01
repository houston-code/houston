import { describe, it, expect } from 'vitest'
import {
  normalizeLicense,
  homepageOf,
  readLicenseText,
  renderEntry,
  VENDORED_BINARIES
} from './generate-notices.mjs'

describe('normalizeLicense', () => {
  it('returns a plain SPDX string as-is', () => {
    expect(normalizeLicense({ license: 'MIT' })).toBe('MIT')
    expect(normalizeLicense({ license: 'Apache-2.0' })).toBe('Apache-2.0')
  })

  it('reads the legacy { type } object form', () => {
    expect(normalizeLicense({ license: { type: 'ISC', url: 'x' } })).toBe('ISC')
  })

  it('joins the deprecated licenses[] array with OR', () => {
    expect(normalizeLicense({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('MIT OR Apache-2.0')
    expect(normalizeLicense({ licenses: ['MIT', 'Unlicense'] })).toBe('MIT OR Unlicense')
  })

  it('falls back to UNKNOWN when there is no license metadata', () => {
    expect(normalizeLicense({})).toBe('UNKNOWN')
    expect(normalizeLicense(null)).toBe('UNKNOWN')
  })
})

describe('homepageOf', () => {
  it('prefers an explicit homepage', () => {
    expect(homepageOf({ homepage: 'https://ex.com', repository: { url: 'git+https://y' } })).toBe('https://ex.com')
  })

  it('normalizes a git repository url', () => {
    expect(homepageOf({ repository: { url: 'git+https://github.com/a/b.git' } })).toBe('https://github.com/a/b')
  })

  it('accepts a string repository', () => {
    expect(homepageOf({ repository: 'github:a/b' })).toBe('github:a/b')
  })

  it('returns empty string when nothing is present', () => {
    expect(homepageOf({})).toBe('')
    expect(homepageOf(null)).toBe('')
  })
})

describe('readLicenseText', () => {
  const dir = '/pkg'
  it('returns the first non-empty license file found', () => {
    const exists = (p) => p === '/pkg/LICENSE'
    const read = () => '  MIT License\n(c) X  '
    expect(readLicenseText(dir, { exists, read })).toBe('MIT License\n(c) X')
  })

  it('skips an empty file and keeps looking', () => {
    const seen = []
    const exists = (p) => p === '/pkg/LICENSE' || p === '/pkg/COPYING'
    const read = (p) => {
      seen.push(p)
      return p.endsWith('COPYING') ? 'real text' : '   '
    }
    expect(readLicenseText(dir, { exists, read })).toBe('real text')
    expect(seen).toContain('/pkg/LICENSE')
  })

  it('returns null when no license file exists', () => {
    expect(readLicenseText(dir, { exists: () => false, read: () => '' })).toBeNull()
  })
})

describe('renderEntry', () => {
  it('includes name, version, license and homepage', () => {
    const md = renderEntry({ name: 'foo', version: '1.2.3', license: 'MIT', homepage: 'https://f' })
    expect(md).toContain('### foo — 1.2.3')
    expect(md).toContain('- License: MIT')
    expect(md).toContain('- Homepage: https://f')
  })

  it('fences license text when present and omits the block otherwise', () => {
    expect(renderEntry({ name: 'a', license: 'MIT', text: 'copyright line' })).toContain('```text\ncopyright line\n```')
    expect(renderEntry({ name: 'a', license: 'MIT' })).not.toContain('```text')
  })

  it('renders a note before the license text', () => {
    const md = renderEntry({ name: 'a', license: 'MIT', note: 'see below', text: 't' })
    expect(md.indexOf('see below')).toBeLessThan(md.indexOf('```text'))
  })
})

describe('VENDORED_BINARIES', () => {
  it('attributes the redistributed ripgrep and ast-grep binaries', () => {
    const names = VENDORED_BINARIES.map((b) => b.name)
    expect(names).toEqual(['ripgrep', 'ast-grep'])
    const rg = VENDORED_BINARIES.find((b) => b.name === 'ripgrep')
    expect(rg.license).toBe('MIT OR Unlicense')
    expect(VENDORED_BINARIES.every((b) => b.homepage && b.note)).toBe(true)
  })
})
