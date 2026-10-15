import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import {
  normalizeLicense,
  homepageOf,
  readLicenseText,
  renderEntry,
  run,
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
    const exists = (p) => p === join(dir, 'LICENSE')
    const read = () => '  MIT License\n(c) X  '
    expect(readLicenseText(dir, { exists, read })).toBe('MIT License\n(c) X')
  })

  it('skips an empty file and keeps looking', () => {
    const seen = []
    const exists = (p) => p === join(dir, 'LICENSE') || p === join(dir, 'COPYING')
    const read = (p) => {
      seen.push(p)
      return p.endsWith('COPYING') ? 'real text' : '   '
    }
    expect(readLicenseText(dir, { exists, read })).toBe('real text')
    expect(seen).toContain(join(dir, 'LICENSE'))
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

describe('run', () => {
  const io = (current) => {
    const writes = []
    const logs = []
    return {
      writes,
      logs,
      opts: {
        out: 'NOTICES.md',
        exists: () => current !== undefined,
        read: () => current,
        write: (p, t) => writes.push([p, t]),
        log: (m) => logs.push(m)
      }
    }
  }

  it('writes the rendered file by default', () => {
    const { writes, opts } = io('old')
    expect(run([], { rendered: 'new', ...opts })).toBe(0)
    expect(writes).toEqual([['NOTICES.md', 'new']])
  })

  it('--check passes without writing when the committed file is current', () => {
    const { writes, opts } = io('same')
    expect(run(['--check'], { rendered: 'same', ...opts })).toBe(0)
    expect(writes).toEqual([])
  })

  it('--check fails with an annotation when the committed file is stale', () => {
    const { writes, logs, opts } = io('stale')
    expect(run(['--check'], { rendered: 'fresh', ...opts })).toBe(1)
    expect(writes).toEqual([])
    expect(logs.join('')).toContain('::error::THIRD-PARTY-NOTICES.md is out of date')
  })

  it('--check fails when the file is missing', () => {
    const { opts } = io(undefined)
    expect(run(['--check'], { rendered: 'fresh', ...opts })).toBe(1)
  })
})
