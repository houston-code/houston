import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Transport, TransportRequest } from './webfetch'
import { htmlToMarkdown } from './htmlToMarkdown'
import {
  capText,
  decodeBody,
  fetchUrlAsDocument,
  fetchUrlAsText,
  isPrivateHost,
  nonTextNotice,
  pinnedTransport,
  resolveAndPin,
  sanitizeHeaderText,
  validateFetchUrl
} from './webfetch'

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

describe('htmlToMarkdown (as web_fetch uses it)', () => {
  it('strips tags, scripts, and styles', () => {
    const html = '<html><head><style>.a{color:red}</style><script>evil()</script></head><body><h1>Title</h1><p>Hello &amp; welcome</p></body></html>'
    const text = htmlToMarkdown(html)
    expect(text).toContain('Title')
    expect(text).toContain('Hello & welcome')
    expect(text).not.toContain('evil()')
    expect(text).not.toContain('color:red')
  })
})

describe('nonTextNotice', () => {
  it('names a PDF by its content type or its magic bytes', () => {
    expect(nonTextNotice(Buffer.from('%PDF-1.7 ...'), 'application/pdf')).toMatch(/^\[PDF document .*pdftotext/)
    expect(nonTextNotice(Buffer.from('%PDF-1.4\n%âã'), 'application/octet-stream')).toMatch(/^\[PDF document/)
  })

  it('refuses binary bodies and binary media types, but not text ones', () => {
    expect(nonTextNotice(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]), 'image/png')).toMatch(/^\[binary content \(image\/png/)
    expect(nonTextNotice(Buffer.from('GIF89a'), 'image/gif')).toMatch(/^\[binary content/)
    expect(nonTextNotice(Buffer.from('a\u0000b'), 'text/plain')).toMatch(/^\[binary content/)
    expect(nonTextNotice(Buffer.from('<svg/>'), 'image/svg+xml')).toBeNull()
    expect(nonTextNotice(Buffer.from('{"a":1}'), 'application/json')).toBeNull()
    expect(nonTextNotice(Buffer.from('plain'), '')).toBeNull()
  })
})

describe('decodeBody', () => {
  it('honors the charset the Content-Type names', () => {
    expect(decodeBody(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'text/html; charset=ISO-8859-1')).toBe('café')
    expect(decodeBody(Buffer.from('café', 'utf8'), 'text/html; charset=utf-8')).toBe('café')
  })

  it('falls back to UTF-8 for a missing or unknown charset', () => {
    expect(decodeBody(Buffer.from('café', 'utf8'), 'text/html')).toBe('café')
    expect(decodeBody(Buffer.from('café', 'utf8'), 'text/html; charset=no-such-charset')).toBe('café')
  })
})

describe('capText', () => {
  it('leaves short text alone and cuts long text at a nearby line break', () => {
    expect(capText('short', 10)).toEqual({ text: 'short', truncated: false })
    const text = `${'a'.repeat(95)}\n${'b'.repeat(50)}`
    expect(capText(text, 100)).toEqual({ text: 'a'.repeat(95), truncated: true })
  })

  it('never splits a surrogate pair', () => {
    const { text } = capText(`${'a'.repeat(9)}\u{1F600}tail`, 10)
    expect(text).toBe('a'.repeat(9))
  })
})

/** Minimal fake transport returning canned responses, recording the requests it got. */
function fakeTransport(
  map: Record<string, { status: number; headers: Record<string, string>; body: string | Buffer }>,
  calls: TransportRequest[] = []
): Transport {
  return async (req) => {
    const url = req.url.toString()
    const r = map[url]
    if (!r) throw new Error(`unexpected fetch: ${url}`)
    calls.push(req)
    return {
      status: r.status,
      statusText: '',
      headers: { get: (k: string) => r.headers[k.toLowerCase()] ?? null },
      body: typeof r.body === 'string' ? Buffer.from(r.body, 'utf8') : r.body
    }
  }
}

describe('fetchUrlAsText', () => {
  // Tests that aren't about DNS behavior must stub the resolver: the default
  // does a REAL dns.lookup on the fake hostnames, and a slow resolver (typical
  // for the reserved .example TLD on CI runners) hangs past the test timeout.
  const publicHost = async (): Promise<string[]> => ['93.184.216.34']

  it('returns converted text for an HTML body', async () => {
    const transport = fakeTransport({
      'https://example.com/': {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<p>Hello world</p>'
      }
    })
    const out = await fetchUrlAsText('https://example.com/', { transport, resolveHost: publicHost })
    expect(out).toContain('HTTP 200')
    expect(out).toContain('Hello world')
  })

  it('follows redirects but re-validates each hop', async () => {
    const transport = fakeTransport({
      'https://a.example/': { status: 302, headers: { location: 'https://b.example/final' }, body: '' },
      'https://b.example/final': { status: 200, headers: { 'content-type': 'text/plain' }, body: 'arrived' }
    })
    const out = await fetchUrlAsText('https://a.example/', { transport, resolveHost: publicHost })
    expect(out).toContain('arrived')
  })

  it('refuses a redirect to a private address', async () => {
    const transport = fakeTransport({
      'https://a.example/': { status: 302, headers: { location: 'http://169.254.169.254/' }, body: '' }
    })
    await expect(
      fetchUrlAsText('https://a.example/', { transport, resolveHost: publicHost })
    ).rejects.toThrow(/private or loopback/)
  })

  it('rejects a blocked URL before fetching', async () => {
    await expect(fetchUrlAsText('http://localhost/secret')).rejects.toThrow(/private or loopback/)
  })

  it('truncates oversized bodies', async () => {
    const transport = fakeTransport({
      'https://big.example/': {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: 'x'.repeat(50)
      }
    })
    const out = await fetchUrlAsText('https://big.example/', {
      transport,
      resolveHost: publicHost,
      maxBytes: 10
    })
    expect(out).toContain('[truncated at 10 bytes]')
  })

  it('caps the extracted text, not the markup: a script-heavy page keeps its content', async () => {
    const script = `<script>${'var x = 1;'.repeat(20_000)}</script>`
    const style = `<style>${'.a{color:red}'.repeat(10_000)}</style>`
    const transport = fakeTransport({
      'https://heavy.example/': {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: `<html><head>${style}</head><body>${script}<main><p>The answer is 42.</p></main></body></html>`
      }
    })
    const doc = await fetchUrlAsDocument('https://heavy.example/', {
      transport,
      resolveHost: publicHost,
      maxChars: 1_000
    })
    expect(doc.text).toContain('The answer is 42.')
    expect(doc.text).not.toContain('var x')
    expect(doc.truncated).toBe(false)
  })

  it('reports a character cap when the extracted text is cut', async () => {
    const transport = fakeTransport({
      'https://long.example/': {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: `<p>${'word '.repeat(1000)}</p>`
      }
    })
    const out = await fetchUrlAsText('https://long.example/', {
      transport,
      resolveHost: publicHost,
      maxChars: 100
    })
    expect(out).toContain('[truncated at 100 characters]')
  })

  it('converts HTML with links resolved against the final URL after a redirect', async () => {
    const transport = fakeTransport({
      'https://a.example/': { status: 301, headers: { location: 'https://b.example/docs/' }, body: '' },
      'https://b.example/docs/': {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<p>See <a href="install">the install guide</a>.</p>'
      }
    })
    const out = await fetchUrlAsText('https://a.example/', { transport, resolveHost: publicHost })
    expect(out).toContain('See [the install guide](https://b.example/docs/install).')
  })

  it('returns a clear notice for a PDF instead of decoding it as UTF-8', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0, 1, 2, 3])])
    const transport = fakeTransport({
      'https://docs.example/spec.pdf': { status: 200, headers: { 'content-type': 'application/pdf' }, body: pdf }
    })
    const doc = await fetchUrlAsDocument('https://docs.example/spec.pdf', { transport, resolveHost: publicHost })
    expect(doc.text).toMatch(/^\[PDF document \(17 B\): web_fetch cannot extract text from PDFs/)
    expect(doc.text).not.toContain('%PDF')
    expect(doc.contentType).toBe('application/pdf')
  })

  it('returns a notice for other binary bodies', async () => {
    const transport = fakeTransport({
      'https://img.example/a.png': {
        status: 200,
        headers: { 'content-type': 'image/png' },
        body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])
      }
    })
    const out = await fetchUrlAsText('https://img.example/a.png', { transport, resolveHost: publicHost })
    expect(out).toContain('[binary content (image/png, 12 B): not text, so there is nothing to show.]')
  })

  it('refuses a host that resolves to a private/metadata address (DNS-name SSRF)', async () => {
    // A public-looking wildcard-DNS host that resolves to the AWS metadata IP.
    const url = 'http://169.254.169.254.nip.io/latest/meta-data/'
    const transport = fakeTransport({ [url]: { status: 200, headers: {}, body: 'creds' } })
    const resolveHost = async (): Promise<string[]> => ['169.254.169.254']
    await expect(fetchUrlAsText(url, { transport, resolveHost })).rejects.toThrow(
      /resolves to a private/
    )
  })

  it('allows a host that resolves to a public address', async () => {
    const transport = fakeTransport({
      'https://example.com/': { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' }
    })
    const resolveHost = async (): Promise<string[]> => ['93.184.216.34']
    const out = await fetchUrlAsText('https://example.com/', { transport, resolveHost })
    expect(out).toContain('ok')
  })

  it('refuses a redirect whose host resolves to a private address', async () => {
    const transport = fakeTransport({
      'https://a.example/': {
        status: 302,
        headers: { location: 'http://metadata.evil.example/' },
        body: ''
      }
    })
    const resolveHost = async (host: string): Promise<string[]> =>
      host === 'metadata.evil.example' ? ['169.254.169.254'] : ['93.184.216.34']
    await expect(fetchUrlAsText('https://a.example/', { transport, resolveHost })).rejects.toThrow(
      /resolves to a private/
    )
  })

  it('hands the transport the vetted address to pin, rather than the hostname', async () => {
    const calls: TransportRequest[] = []
    const transport = fakeTransport(
      { 'https://example.com/': { status: 200, headers: {}, body: 'ok' } },
      calls
    )
    const resolveHost = async (): Promise<string[]> => ['93.184.216.34', '93.184.216.35']
    await fetchUrlAsText('https://example.com/', { transport, resolveHost })
    expect(calls[0].pin).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '93.184.216.35', family: 4 }
    ])
  })

  it('re-pins on every redirect hop instead of reusing the first address', async () => {
    const calls: TransportRequest[] = []
    const transport = fakeTransport(
      {
        'https://a.example/': { status: 302, headers: { location: 'https://b.example/' }, body: '' },
        'https://b.example/': { status: 200, headers: {}, body: 'arrived' }
      },
      calls
    )
    const resolveHost = async (host: string): Promise<string[]> =>
      host === 'a.example' ? ['93.184.216.34'] : ['203.0.113.9']
    await fetchUrlAsText('https://a.example/', { transport, resolveHost })
    expect(calls.map((c) => c.pin[0].address)).toEqual(['93.184.216.34', '203.0.113.9'])
  })

  it('fails closed when the host cannot be resolved (no address to pin)', async () => {
    const transport = fakeTransport({ 'https://gone.example/': { status: 200, headers: {}, body: 'x' } })
    const resolveHost = async (): Promise<string[]> => {
      throw new Error('ENOTFOUND')
    }
    await expect(fetchUrlAsText('https://gone.example/', { transport, resolveHost })).rejects.toThrow(
      /could not be resolved/
    )
  })

  it('fails closed when the host resolves to an empty address list', async () => {
    const transport = fakeTransport({ 'https://empty.example/': { status: 200, headers: {}, body: 'x' } })
    await expect(
      fetchUrlAsText('https://empty.example/', { transport, resolveHost: async () => [] })
    ).rejects.toThrow(/resolves to no addresses/)
  })

  it('times out a DNS lookup that never answers, without connecting', async () => {
    const transport = vi.fn()
    const resolveHost = (): Promise<string[]> => new Promise<string[]>(() => {})
    await expect(
      fetchUrlAsText('https://stuck.example/', { transport, resolveHost, timeoutMs: 50 })
    ).rejects.toThrow(/timed out or was cancelled/)
    expect(transport).not.toHaveBeenCalled()
  })

  it('ends a fetch stuck in DNS when the run is stopped, without connecting', async () => {
    const transport = vi.fn()
    const ac = new AbortController()
    const resolveHost = (): Promise<string[]> => {
      setTimeout(() => ac.abort(), 0)
      return new Promise<string[]>(() => {})
    }
    await expect(
      fetchUrlAsText('https://stuck.example/', { transport, resolveHost, signal: ac.signal, timeoutMs: 60_000 })
    ).rejects.toThrow(/timed out or was cancelled/)
    expect(transport).not.toHaveBeenCalled()
  })

  it('still refuses a private address that a slow resolver returns before the timeout', async () => {
    const transport = vi.fn()
    const resolveHost = (): Promise<string[]> => new Promise((r) => setTimeout(() => r(['10.0.0.5']), 10))
    await expect(
      fetchUrlAsText('https://slow.example/', { transport, resolveHost, timeoutMs: 5_000 })
    ).rejects.toThrow(/private or loopback/)
    expect(transport).not.toHaveBeenCalled()
  })
})

describe('sanitizeHeaderText', () => {
  it('keeps an ordinary reason phrase and content type intact', () => {
    expect(sanitizeHeaderText('OK')).toBe('OK')
    expect(sanitizeHeaderText('text/html; charset=utf-8')).toBe('text/html; charset=utf-8')
  })

  it('strips control and non-ASCII characters', () => {
    expect(sanitizeHeaderText('OK\r\nX-Evil: 1')).toBe('OKX-Evil: 1')
    expect(sanitizeHeaderText('OK\u0000\u007f')).toBe('OK')
  })

  it('caps a server that sends prose instead of a reason phrase', () => {
    // Node accepts a multi-KB reason phrase; it renders outside the untrusted fence.
    const out = sanitizeHeaderText('A'.repeat(5000))
    expect(out.length).toBeLessThanOrEqual(121)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('resolveAndPin', () => {
  const unused = async (): Promise<string[]> => {
    throw new Error('resolver should not be called')
  }

  it('returns a public IP literal as its own pin without resolving', async () => {
    expect(await resolveAndPin('93.184.216.34', unused)).toEqual([
      { address: '93.184.216.34', family: 4 }
    ])
  })

  it('rejects a private IP literal', async () => {
    await expect(resolveAndPin('169.254.169.254', unused)).rejects.toThrow(/private or loopback/)
  })

  it('pins IPv6 answers with the right family', async () => {
    expect(await resolveAndPin('v6.example', async () => ['2606:2800:220:1:248:1893:25c8:1946'])).toEqual(
      [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }]
    )
  })

  it('rejects when ANY answer is private, not just the first', async () => {
    // A rebinding-style multi-answer record: one decoy public A, one metadata A.
    await expect(
      resolveAndPin('evil.example', async () => ['93.184.216.34', '169.254.169.254'])
    ).rejects.toThrow(/resolves to a private or loopback address \(169\.254\.169\.254\)/)
  })

  it('rejects a resolver answer that is not an address', async () => {
    await expect(resolveAndPin('bad.example', async () => ['not-an-ip'])).rejects.toThrow(
      /resolved to a non-address/
    )
  })
})

describe('pinnedTransport', () => {
  // A real loopback server. The pin is what decides where the connection lands, so
  // these use a hostname that provably cannot resolve (RFC 2606 reserves `.invalid`):
  // if the request arrives at all, the pin was honored and DNS was never consulted.
  // Pinning to loopback is fine here — vetting is resolveAndPin's job, not the
  // transport's, and it lets the test assert against a real socket.
  let base: { port: number; host: string }
  let lastHostHeader: string | undefined
  const server = createServer((req, res) => {
    lastHostHeader = req.headers.host
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('y'.repeat(100_000))
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'x-multi': 'a' })
    res.end('pinned-hit')
  })

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = { port: (server.address() as AddressInfo).port, host: 'unresolvable.invalid' }
  })
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  const pin = [{ address: '127.0.0.1', family: 4 }]

  it('connects to the pinned address, never re-resolving the hostname', async () => {
    const res = await pinnedTransport({
      url: new URL(`http://${base.host}:${base.port}/`),
      headers: {},
      signal: new AbortController().signal,
      pin,
      readLimit: 1000
    })
    expect(res.status).toBe(200)
    expect(res.body.toString()).toBe('pinned-hit')
  })

  it('keeps the Host header on the approved name, not the pinned IP', async () => {
    await pinnedTransport({
      url: new URL(`http://${base.host}:${base.port}/`),
      headers: {},
      signal: new AbortController().signal,
      pin,
      readLimit: 1000
    })
    expect(lastHostHeader).toBe(`${base.host}:${base.port}`)
  })

  it('stops reading at readLimit instead of buffering the whole body', async () => {
    const res = await pinnedTransport({
      url: new URL(`http://${base.host}:${base.port}/big`),
      headers: {},
      signal: new AbortController().signal,
      pin,
      readLimit: 64
    })
    expect(res.body.length).toBe(64)
  })

  it('rejects when the request is aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      pinnedTransport({
        url: new URL(`http://${base.host}:${base.port}/`),
        headers: {},
        signal: ac.signal,
        pin,
        readLimit: 1000
      })
    ).rejects.toThrow()
  })
})
