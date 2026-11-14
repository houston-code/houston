import { afterEach, describe, it, expect, vi } from 'vitest'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

vi.mock('./logger', () => ({ log: { warn: vi.fn() } }))

import { deferTrustSystemCertificates, trustSystemCertificates, type CaApi, type DeferredCaApi } from './system-ca'

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

describe('deferTrustSystemCertificates', () => {
  /** A fake `node:tls` whose calls land in `events`, in order. */
  function fakeTlsWithConnect(events: string[]): DeferredCaApi {
    return {
      getCACertificates: (type) => {
        events.push(`read:${type}`)
        return type === 'system' ? ['corp-root'] : ['bundled']
      },
      setDefaultCACertificates: (certs) => void events.push(`set:${certs.join(',')}`),
      connect: function (this: unknown, ...args: unknown[]) {
        events.push(`connect:${args.join(',')}`)
        return 'socket'
      } as DeferredCaApi['connect']
    }
  }
  const connectOn = (api: DeferredCaApi, ...args: unknown[]): unknown =>
    (api.connect as (...a: unknown[]) => unknown)(...args)

  it('reads nothing until something needs it', () => {
    const events: string[] = []
    deferTrustSystemCertificates(fakeTlsWithConnect(events))
    expect(events).toEqual([])
  })

  it('trusts the system roots before the first TLS connection, then gets out of the way', () => {
    const events: string[] = []
    const api = fakeTlsWithConnect(events)
    const original = api.connect
    deferTrustSystemCertificates(api)
    expect(connectOn(api, 'host', 443)).toBe('socket')
    expect(events).toEqual(['read:default', 'read:system', 'set:bundled,corp-root', 'connect:host,443'])
    expect(api.connect).toBe(original)
    connectOn(api, 'other', 443)
    expect(events.slice(4)).toEqual(['connect:other,443'])
  })

  it('trusts them once when the client asks first, and leaves connect alone after', () => {
    const events: string[] = []
    const api = fakeTlsWithConnect(events)
    const original = api.connect
    const trustNow = deferTrustSystemCertificates(api)
    trustNow()
    trustNow()
    expect(api.connect).toBe(original)
    connectOn(api, 'host', 443)
    expect(events).toEqual(['read:default', 'read:system', 'set:bundled,corp-root', 'connect:host,443'])
  })

  it('leaves a connect someone else wrapped later in place', () => {
    const events: string[] = []
    const api = fakeTlsWithConnect(events)
    const trustNow = deferTrustSystemCertificates(api)
    const theirs = api.connect
    const wrapper = ((...args: never[]) => (theirs as (...a: never[]) => unknown)(...args)) as DeferredCaApi['connect']
    api.connect = wrapper
    trustNow()
    expect(api.connect).toBe(wrapper)
  })

  // The real runtime: fetch and node:https both open their sockets through tls.connect,
  // so neither can reach a server before the system roots are in.
  describe('on the real node:tls', () => {
    const realConnect = tls.connect
    afterEach(() => {
      tls.connect = realConnect
      vi.restoreAllMocks()
    })

    it('runs before the first connection from fetch, and not again for https', async () => {
      const events: string[] = []
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type: string) => {
        events.push(`read:${type}`)
        return type === 'system' ? ['corp-root'] : ['bundled']
      }) as typeof tls.getCACertificates)
      vi.spyOn(tls, 'setDefaultCACertificates').mockImplementation(() => void events.push('set'))
      tls.connect = ((...args: Parameters<typeof tls.connect>) => {
        events.push('connect')
        return (realConnect as (...a: unknown[]) => tls.TLSSocket)(...args)
      }) as typeof tls.connect
      // A server that hangs up at once: the handshake fails, which is all this needs.
      const server = net.createServer((s) => s.destroy())
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const { port } = server.address() as net.AddressInfo
      try {
        deferTrustSystemCertificates()
        await fetch(`https://127.0.0.1:${port}/`).catch(() => {})
        expect(events).toEqual(['read:default', 'read:system', 'set', 'connect'])
        await new Promise<void>((done) => {
          https.get(`https://127.0.0.1:${port}/`).on('error', () => done())
        })
        expect(events).toEqual(['read:default', 'read:system', 'set', 'connect', 'connect'])
      } finally {
        await new Promise<void>((r) => server.close(() => r()))
      }
    })
  })
})
