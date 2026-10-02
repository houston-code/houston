import { describe, it, expect, vi } from 'vitest'

vi.mock('./logger', () => ({ log: { warn: vi.fn() } }))

import { trustSystemCertificates, type CaApi } from './system-ca'

/** A fake `node:tls` slice with the given default and system stores. */
function fakeTls(defaults: string[], system: string[]): CaApi & { set: string[][] } {
  const set: string[][] = []
  return {
    set,
    getCACertificates: (type) => (type === 'system' ? system : defaults),
    setDefaultCACertificates: (certs) => void set.push(certs)
  }
}

describe('trustSystemCertificates', () => {
  it('adds system roots on top of the current defaults, without duplicates', () => {
    const api = fakeTls(['bundled-a', 'extra-b'], ['bundled-a', 'corp-root'])
    expect(trustSystemCertificates(api)).toBe(1)
    expect(api.set).toEqual([['bundled-a', 'extra-b', 'corp-root']])
  })

  it('leaves the defaults alone when the system store adds nothing', () => {
    const api = fakeTls(['bundled-a'], ['bundled-a'])
    expect(trustSystemCertificates(api)).toBe(0)
    expect(api.set).toEqual([])
  })

  it('is a no-op on a runtime without the API (older Node)', () => {
    expect(trustSystemCertificates({})).toBe(0)
    expect(trustSystemCertificates({ getCACertificates: () => ['x'] })).toBe(0)
  })

  it('never throws when the system store cannot be read', () => {
    const api: CaApi = {
      getCACertificates: (type) => {
        if (type === 'system') throw new Error('keychain locked')
        return ['bundled-a']
      },
      setDefaultCACertificates: vi.fn()
    }
    expect(trustSystemCertificates(api)).toBe(0)
    expect(api.setDefaultCACertificates).not.toHaveBeenCalled()
  })

  it('works against the real runtime', () => {
    // Additive, so whatever this machine's store holds, the defaults only grow.
    expect(trustSystemCertificates()).toBeGreaterThanOrEqual(0)
  })
})
