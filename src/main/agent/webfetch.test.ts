import { describe, expect, it } from 'vitest'
import { fetchUrlAsText, htmlToText, isPrivateHost, validateFetchUrl } from './webfetch'

describe('isPrivateHost', () => {
  it('blocks loopback and localhost', () => {
    expect(isPrivateHost('localhost')).toBe(true)
    expect(isPrivateHost('app.localhost')).toBe(true)
    expect(isPrivateHost('127.0.0.1')).toBe(true)
    expect(isPrivateHost('::1')).toBe(true)
  })

  it('blocks private and link-local ranges incl. cloud metadata', () => {
    expect(isPrivateHost('10.0.0.5')).toBe(true)
    expect(isPrivateHost('172.16.4.4')).toBe(true)
    expect(isPrivateHost('172.32.0.1')).toBe(false) // outside 16-31
    expect(isPrivateHost('192.168.1.1')).toBe(true)
    expect(isPrivateHost('169.254.169.254')).toBe(true) // AWS metadata
    expect(isPrivateHost('100.64.0.1')).toBe(true) // CGNAT
  })

  it('blocks the IETF protocol block (192.0.0.0/24) incl. Oracle legacy metadata', () => {
    expect(isPrivateHost('192.0.0.192')).toBe(true) // Oracle legacy metadata
    expect(isPrivateHost('192.0.0.1')).toBe(true)
    expect(isPrivateHost('192.0.2.1')).toBe(false) // TEST-NET-1, a different /24
  })

  it('allows public hosts', () => {
    expect(isPrivateHost('example.com')).toBe(false)
    expect(isPrivateHost('8.8.8.8')).toBe(false)
  })

  it('blocks IPv4-mapped IPv6 forms of loopback/metadata/private hosts', () => {
    // The WHATWG URL parser normalizes the dotted tail to hex, so the production
    // guard actually receives the hex-compressed form — cover both.
    expect(isPrivateHost('[::ffff:127.0.0.1]')).toBe(true)
    expect(isPrivateHost('::ffff:7f00:1')).toBe(true) // hex form of 127.0.0.1
    expect(isPrivateHost('[::ffff:169.254.169.254]')).toBe(true)
    expect(isPrivateHost('::ffff:a9fe:a9fe')).toBe(true) // hex form of 169.254.169.254
    expect(isPrivateHost('::ffff:192.168.1.1')).toBe(true)
    expect(isPrivateHost('::ffff:c0a8:101')).toBe(true) // hex form of 192.168.1.1
    expect(isPrivateHost('64:ff9b::7f00:1')).toBe(true) // NAT64 loopback
    // A mapped PUBLIC address is still allowed (CDNs reachable over mapped v6).
    expect(isPrivateHost('::ffff:8.8.8.8')).toBe(false)
    expect(isPrivateHost('::ffff:808:808')).toBe(false)
  })

  it('blocks trailing-dot localhost and deprecated IPv6 site/link-local', () => {
    expect(isPrivateHost('localhost.')).toBe(true)
    expect(isPrivateHost('fe80::1')).toBe(true) // link-local
    expect(isPrivateHost('fe90::1')).toBe(true) // link-local (fe80::/10, missed before)
    expect(isPrivateHost('fec0::1')).toBe(true) // deprecated site-local
  })
})

describe('validateFetchUrl', () => {
  it('accepts http and https', () => {
    expect(validateFetchUrl('https://example.com/x').hostname).toBe('example.com')
  })

  it('rejects non-http schemes', () => {
    expect(() => validateFetchUrl('file:///etc/passwd')).toThrow(/http and https/)
    expect(() => validateFetchUrl('ftp://example.com')).toThrow(/http and https/)
  })

  it('rejects private hosts', () => {
    expect(() => validateFetchUrl('http://169.254.169.254/latest/meta-data')).toThrow(/private or loopback/)
    expect(() => validateFetchUrl('http://localhost:3000')).toThrow(/private or loopback/)
  })

  it('rejects malformed URLs', () => {
    expect(() => validateFetchUrl('not a url')).toThrow(/Invalid URL/)
  })
})

describe('htmlToText', () => {
  it('strips tags, scripts, and styles', () => {
    const html = '<html><head><style>.a{color:red}</style><script>evil()</script></head><body><h1>Title</h1><p>Hello &amp; welcome</p></body></html>'
    const text = htmlToText(html)
    expect(text).toContain('Title')
    expect(text).toContain('Hello & welcome')
    expect(text).not.toContain('evil()')
    expect(text).not.toContain('color:red')
  })
})

/** Minimal fake `fetch` returning a canned Response-like object. */
function fakeFetch(map: Record<string, { status: number; headers: Record<string, string>; body: string }>): typeof fetch {
  return (async (input: string | URL) => {
    const url = input.toString()
    const r = map[url]
    if (!r) throw new Error(`unexpected fetch: ${url}`)
    return {
      status: r.status,
      statusText: '',
      url,
      headers: { get: (k: string) => r.headers[k.toLowerCase()] ?? null },
      arrayBuffer: async () => new TextEncoder().encode(r.body).buffer
    }
  }) as unknown as typeof fetch
}

describe('fetchUrlAsText', () => {
  it('returns converted text for an HTML body', async () => {
    const fetchImpl = fakeFetch({
      'https://example.com/': {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<p>Hello world</p>'
      }
    })
    const out = await fetchUrlAsText('https://example.com/', { fetchImpl })
    expect(out).toContain('HTTP 200')
    expect(out).toContain('Hello world')
  })

  it('follows redirects but re-validates each hop', async () => {
    const fetchImpl = fakeFetch({
      'https://a.example/': { status: 302, headers: { location: 'https://b.example/final' }, body: '' },
      'https://b.example/final': { status: 200, headers: { 'content-type': 'text/plain' }, body: 'arrived' }
    })
    const out = await fetchUrlAsText('https://a.example/', { fetchImpl })
    expect(out).toContain('arrived')
  })

  it('refuses a redirect to a private address', async () => {
    const fetchImpl = fakeFetch({
      'https://a.example/': { status: 302, headers: { location: 'http://169.254.169.254/' }, body: '' }
    })
    await expect(fetchUrlAsText('https://a.example/', { fetchImpl })).rejects.toThrow(/private or loopback/)
  })

  it('rejects a blocked URL before fetching', async () => {
    await expect(fetchUrlAsText('http://localhost/secret')).rejects.toThrow(/private or loopback/)
  })

  it('truncates oversized bodies', async () => {
    const fetchImpl = fakeFetch({
      'https://big.example/': {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: 'x'.repeat(50)
      }
    })
    const out = await fetchUrlAsText('https://big.example/', { fetchImpl, maxBytes: 10 })
    expect(out).toContain('[truncated at 10 bytes]')
  })

  it('refuses a host that resolves to a private/metadata address (DNS-name SSRF)', async () => {
    // A public-looking wildcard-DNS host that resolves to the AWS metadata IP.
    const url = 'http://169.254.169.254.nip.io/latest/meta-data/'
    const fetchImpl = fakeFetch({ [url]: { status: 200, headers: {}, body: 'creds' } })
    const resolveHost = async (): Promise<string[]> => ['169.254.169.254']
    await expect(fetchUrlAsText(url, { fetchImpl, resolveHost })).rejects.toThrow(
      /resolves to a private/
    )
  })

  it('allows a host that resolves to a public address', async () => {
    const fetchImpl = fakeFetch({
      'https://example.com/': { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' }
    })
    const resolveHost = async (): Promise<string[]> => ['93.184.216.34']
    const out = await fetchUrlAsText('https://example.com/', { fetchImpl, resolveHost })
    expect(out).toContain('ok')
  })

  it('refuses a redirect whose host resolves to a private address', async () => {
    const fetchImpl = fakeFetch({
      'https://a.example/': {
        status: 302,
        headers: { location: 'http://metadata.evil.example/' },
        body: ''
      }
    })
    const resolveHost = async (host: string): Promise<string[]> =>
      host === 'metadata.evil.example' ? ['169.254.169.254'] : ['93.184.216.34']
    await expect(fetchUrlAsText('https://a.example/', { fetchImpl, resolveHost })).rejects.toThrow(
      /resolves to a private/
    )
  })
})
