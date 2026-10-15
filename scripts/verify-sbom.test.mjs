import { describe, it, expect } from 'vitest'
import { checkFlat, checkSpdx3, verify, MIN_PACKAGES } from './verify-sbom.mjs'

const n = (count, f) => Array.from({ length: count }, (_, i) => f(i))

describe('checkFlat', () => {
  it('passes a full, hashed CycloneDX closure', () => {
    const doc = { components: n(MIN_PACKAGES, () => ({ hashes: [{ alg: 'SHA-512' }] })) }
    expect(checkFlat('cdx', doc).ok).toBe(true)
  })

  it('passes a full, hashed SPDX 2.3 closure', () => {
    const doc = { packages: n(73, () => ({ checksums: [{ algorithm: 'SHA512' }] })) }
    expect(checkFlat('spdx', doc)).toEqual({ ok: true, message: 'spdx OK (73 entries, 73 hashed)' })
  })

  it('fails a truncated closure even when every entry is well-formed', () => {
    const doc = { components: n(56, () => ({ hashes: [{}] })) }
    const r = checkFlat('cdx', doc)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('closure looks truncated')
  })

  it('fails when enrichment left the entries without hashes', () => {
    const doc = { components: n(73, (i) => (i < 10 ? { hashes: [{}] } : {})) }
    expect(checkFlat('cdx', doc).message).toContain('enrichment did not run')
  })

  it('treats a document with no entries as truncated', () => {
    expect(checkFlat('cdx', {}).ok).toBe(false)
  })
})

describe('checkSpdx3', () => {
  const pkg = (supplied) => ({ type: 'software_Package', ...(supplied ? { suppliedBy: ['x'] } : {}) })

  it('passes when every package has a supplier', () => {
    const doc = { '@graph': [{ type: 'SpdxDocument' }, ...n(MIN_PACKAGES, () => pkg(true))] }
    expect(checkSpdx3('spdx3', doc).ok).toBe(true)
  })

  it('fails when any package is missing suppliedBy', () => {
    const doc = { '@graph': [...n(70, () => pkg(true)), pkg(false)] }
    expect(checkSpdx3('spdx3', doc).message).toBe('spdx3: 1 packages missing suppliedBy')
  })

  it('fails a truncated graph', () => {
    expect(checkSpdx3('spdx3', { '@graph': n(5, () => pkg(true)) }).ok).toBe(false)
  })
})

describe('verify', () => {
  it('checks the three documents in order', () => {
    const docs = {
      a: { components: n(73, () => ({ hashes: [{}] })) },
      b: { packages: n(10, () => ({})) },
      c: { '@graph': n(73, () => ({ type: 'software_Package', suppliedBy: ['x'] })) }
    }
    const results = verify(['a', 'b', 'c'], (p) => docs[p])
    expect(results.map((r) => r.ok)).toEqual([true, false, true])
  })
})
