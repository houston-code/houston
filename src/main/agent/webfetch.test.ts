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

  it('allows public hosts', () => {
    expect(isPrivateHost('example.com')).toBe(false)
    expect(isPrivateHost('8.8.8.8')).toBe(false)
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
})
