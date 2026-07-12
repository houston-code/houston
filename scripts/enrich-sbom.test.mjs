import { describe, it, expect } from 'vitest'
import {
  integrityToHex,
  normalizeAuthor,
  spdxOriginator,
  buildLockIndex,
  enrichCycloneDx,
  enrichSpdx
} from './enrich-sbom.mjs'

const sha512 = (hex) => 'sha512-' + Buffer.from(hex, 'hex').toString('base64')

describe('integrityToHex', () => {
  it('round-trips an npm sha512 integrity to lowercase hex', () => {
    const hex = 'ab'.repeat(64) // 64 bytes = a sha512 digest
    expect(integrityToHex(sha512(hex))).toBe(hex)
  })

  it('returns null for non-sha512 or missing integrity', () => {
    expect(integrityToHex('sha1-abcd')).toBeNull()
    expect(integrityToHex('')).toBeNull()
    expect(integrityToHex(null)).toBeNull()
  })
})

describe('normalizeAuthor', () => {
  it('accepts a plain string', () => {
    expect(normalizeAuthor('Jane Doe')).toBe('Jane Doe')
  })

  it('formats the { name, email } object form', () => {
    expect(normalizeAuthor({ name: 'Jane', email: 'j@x.com' })).toBe('Jane <j@x.com>')
    expect(normalizeAuthor({ name: 'Jane' })).toBe('Jane')
  })

  it('returns null when there is no usable author', () => {
    expect(normalizeAuthor(null)).toBeNull()
    expect(normalizeAuthor({})).toBeNull()
    expect(normalizeAuthor('   ')).toBeNull()
  })
})

describe('spdxOriginator', () => {
  it('maps "Name <email>" to an SPDX Person originator', () => {
    expect(spdxOriginator('Jane <j@x.com>')).toBe('Person: Jane (j@x.com)')
  })

  it('handles a bare name and null', () => {
    expect(spdxOriginator('Jane')).toBe('Person: Jane')
    expect(spdxOriginator(null)).toBeNull()
  })
})

describe('buildLockIndex', () => {
  it('indexes name@version -> integrity + path, deriving scoped names from the path', () => {
    const idx = buildLockIndex({
      packages: {
        '': { name: 'root' },
        'node_modules/foo': { version: '1.0.0', integrity: 'sha512-AAA' },
        'node_modules/@s/bar': { version: '2.0.0', integrity: 'sha512-BBB' },
        'node_modules/foo/node_modules/baz': { version: '3.0.0' }
      }
    })
    expect(idx.get('foo@1.0.0')).toEqual({ integrity: 'sha512-AAA', path: 'node_modules/foo' })
    expect(idx.get('@s/bar@2.0.0').integrity).toBe('sha512-BBB')
    expect(idx.get('baz@3.0.0').integrity).toBeNull() // nested, no integrity in this fixture
    expect(idx.size).toBe(3) // the root ('') entry is skipped
  })
})

describe('enrichCycloneDx', () => {
  it('adds a SHA-512 hash and author only for indexed components', () => {
    const hex = 'ab'.repeat(64)
    const idx = new Map([['foo@1.0.0', { integrity: sha512(hex), path: 'node_modules/foo' }]])
    const doc = {
      bomFormat: 'CycloneDX',
      components: [
        { name: 'foo', version: '1.0.0' },
        { name: 'bar', version: '9.9.9' } // not in the index
      ]
    }
    const res = enrichCycloneDx(doc, idx, (p) => (p === 'node_modules/foo' ? 'Jane <j@x.com>' : null))
    expect(res).toEqual({ hashes: 1, authors: 1 })
    expect(doc.components[0].hashes).toEqual([{ alg: 'SHA-512', content: hex }])
    expect(doc.components[0].author).toBe('Jane <j@x.com>')
    expect(doc.components[1].hashes).toBeUndefined()
  })

  it('never clobbers an existing hash or author', () => {
    const idx = new Map([['foo@1.0.0', { integrity: sha512('cd'.repeat(64)), path: 'node_modules/foo' }]])
    const doc = { components: [{ name: 'foo', version: '1.0.0', hashes: [{ alg: 'MD5', content: 'x' }], author: 'Existing' }] }
    const res = enrichCycloneDx(doc, idx, () => 'Jane')
    expect(res).toEqual({ hashes: 0, authors: 0 })
    expect(doc.components[0].author).toBe('Existing')
  })
})

describe('enrichSpdx', () => {
  it('adds a SHA512 checksum and Person originator', () => {
    const hex = 'cd'.repeat(64)
    const idx = new Map([['foo@1.0.0', { integrity: sha512(hex), path: 'node_modules/foo' }]])
    const doc = {
      spdxVersion: 'SPDX-2.3',
      packages: [{ name: 'foo', versionInfo: '1.0.0', originator: 'NOASSERTION' }]
    }
    const res = enrichSpdx(doc, idx, () => 'Jane <j@x.com>')
    expect(res).toEqual({ hashes: 1, authors: 1 })
    expect(doc.packages[0].checksums).toEqual([{ algorithm: 'SHA512', checksumValue: hex }])
    expect(doc.packages[0].originator).toBe('Person: Jane (j@x.com)')
  })
})
