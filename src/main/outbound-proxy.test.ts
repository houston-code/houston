import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'
import { createServer, request, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('./logger', () => ({ log: { warn: vi.fn(), info: vi.fn() } }))

import {
  configureOutboundProxy,
  isValidProxyUrl,
  outboundDispatcher,
  outboundFetch,
  redactProxyUrl,
  resolveOutboundProxy
} from './outbound-proxy'

const LOOPBACK = 'localhost,127.0.0.1,[::1]'

describe('resolveOutboundProxy', () => {
  it('is off with no setting and no proxy variables', () => {
    expect(resolveOutboundProxy(undefined, {})).toBeNull()
    expect(resolveOutboundProxy('  ', { PATH: '/bin' })).toBeNull()
  })

  it('reads HTTPS_PROXY and HTTP_PROXY in either case', () => {
    expect(resolveOutboundProxy(undefined, { HTTPS_PROXY: 'http://p:1' })).toEqual({
      httpProxy: '',
      httpsProxy: 'http://p:1',
      noProxy: LOOPBACK,
      source: 'environment'
    })
    expect(resolveOutboundProxy(undefined, { http_proxy: 'http://h:2', https_proxy: 'http://s:3' })).toMatchObject({
      httpProxy: 'http://h:2',
      httpsProxy: 'http://s:3'
    })
  })

  it('prefers the lowercase variable when both cases are set', () => {
    expect(resolveOutboundProxy(undefined, { https_proxy: 'http://lower:1', HTTPS_PROXY: 'http://upper:1' })?.httpsProxy).toBe(
      'http://lower:1'
    )
  })

  it('falls back to HTTP_PROXY for https targets', () => {
    expect(resolveOutboundProxy(undefined, { HTTP_PROXY: 'http://h:2' })).toMatchObject({
      httpProxy: 'http://h:2',
      httpsProxy: 'http://h:2'
    })
  })

  it('lets the setting win over the environment for both schemes', () => {
    expect(resolveOutboundProxy('https://set:9', { HTTPS_PROXY: 'http://env:1', HTTP_PROXY: 'http://env:2' })).toEqual({
      httpProxy: 'https://set:9',
      httpsProxy: 'https://set:9',
      noProxy: LOOPBACK,
      source: 'setting'
    })
  })

  it('keeps NO_PROXY entries and always adds loopback', () => {
    expect(resolveOutboundProxy('http://p:1', { NO_PROXY: 'corp.example, .internal  10.0.0.5' })?.noProxy).toBe(
      `corp.example,.internal,10.0.0.5,${LOOPBACK}`
    )
  })

  it('turns the proxy off for NO_PROXY=*', () => {
    expect(resolveOutboundProxy('http://p:1', { no_proxy: '*' })).toBeNull()
    expect(resolveOutboundProxy(undefined, { HTTPS_PROXY: 'http://p:1', NO_PROXY: '*' })).toBeNull()
  })

  it('ignores an unusable setting and falls back to the environment', () => {
    expect(resolveOutboundProxy('socks5://p:1080', { HTTPS_PROXY: 'http://env:1' })).toMatchObject({
      httpsProxy: 'http://env:1',
      source: 'environment'
    })
    expect(resolveOutboundProxy('not a url', {})).toBeNull()
  })

  it('ignores an unusable environment proxy', () => {
    expect(resolveOutboundProxy(undefined, { HTTPS_PROXY: 'socks5://p:1080' })).toBeNull()
  })
})

describe('what stays direct', () => {
  it('web_fetch and the sandbox egress proxy never route through the outbound proxy', () => {
    // web_fetch's SSRF guard pins the address it vetted; a proxy would resolve the name
    // again on its side. The egress proxy is the sandbox's own exit and must not chain.
    for (const file of ['agent/webfetch.ts', 'sandbox/egress-proxy.ts']) {
      const src = readFileSync(join(__dirname, file), 'utf8')
      expect(src, file).not.toMatch(/outbound-proxy|outboundFetch|undici/)
    }
  })
})

describe('isValidProxyUrl / redactProxyUrl', () => {
  it('accepts only http and https proxy URLs', () => {
    expect(isValidProxyUrl('http://p:8080')).toBe(true)
    expect(isValidProxyUrl('https://user:pw@p')).toBe(true)
    expect(isValidProxyUrl('socks5://p:1080')).toBe(false)
    expect(isValidProxyUrl('p:8080')).toBe(false)
    expect(isValidProxyUrl('')).toBe(false)
  })

  it('hides credentials', () => {
    expect(redactProxyUrl('http://alice:s3cret@proxy:8080')).toBe('http://***@proxy:8080')
    expect(redactProxyUrl('http://proxy:8080/')).toBe('http://proxy:8080')
    expect(redactProxyUrl('::')).toBe('(invalid proxy URL)')
  })
})

describe('outboundDispatcher', () => {
  afterEach(() => configureOutboundProxy(() => undefined))

  it('is null with no proxy, so fetch keeps its default dispatcher', () => {
    expect(outboundDispatcher(null)).toBeNull()
  })

  it('reuses one agent per configuration and replaces it when the configuration changes', () => {
    const a = resolveOutboundProxy('http://p:1', {})
    const b = resolveOutboundProxy('http://q:2', {})
    const first = outboundDispatcher(a)
    expect(first).not.toBeNull()
    expect(outboundDispatcher(a)).toBe(first)
    expect(outboundDispatcher(b)).not.toBe(first)
    expect(outboundDispatcher(null)).toBeNull()
  })
})

/**
 * A real request through a real proxy on loopback. Loopback always bypasses the proxy,
 * so the target is named by a host that never resolves (`.invalid`): the request can
 * only succeed if it went through the proxy, which forwards it to the local target.
 */
describe('outboundFetch through a proxy', () => {
  let target: Server
  let proxy: Server
  let seen: string[]
  let targetPort: number
  let proxyUrl: string
  const env = { ...process.env }

  beforeAll(async () => {
    target = createServer((req, res) => res.end(`hello ${req.method} ${req.url}`))
    proxy = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`)
      const u = new URL(req.url ?? '')
      const up = request({ host: '127.0.0.1', port: u.port, path: u.pathname, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers)
        r.pipe(res)
      })
      req.pipe(up)
    })
    // Tunnelled requests: open the tunnel to the local target whatever host was named.
    proxy.on('connect', (req, socket) => {
      seen.push(`CONNECT ${req.url}`)
      const port = Number((req.url ?? '').split(':').pop())
      const up = connect(port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        up.pipe(socket)
        socket.pipe(up)
      })
      up.on('error', () => socket.destroy())
    })
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r))
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
    targetPort = (target.address() as AddressInfo).port
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    configureOutboundProxy(() => undefined)
    process.env = env
    outboundDispatcher(null)
    await new Promise((r) => proxy.close(r))
    await new Promise((r) => target.close(r))
  })

  afterEach(() => {
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']) delete process.env[k]
  })

  it('sends a request through the proxy named by the setting', async () => {
    seen = []
    configureOutboundProxy(() => proxyUrl)
    const res = await outboundFetch(`http://model-host.invalid:${targetPort}/v1/chat`, { method: 'POST', body: '{}' })
    expect(await res.text()).toBe('hello POST /v1/chat')
    expect(seen).toEqual([`CONNECT model-host.invalid:${targetPort}`])
  })

  it('sends a request through HTTP_PROXY from the environment', async () => {
    seen = []
    configureOutboundProxy(() => undefined)
    process.env.HTTP_PROXY = proxyUrl
    const res = await outboundFetch(`http://mcp-host.invalid:${targetPort}/mcp`)
    expect(await res.text()).toBe('hello GET /mcp')
    expect(seen).toHaveLength(1)
  })

  it('reads the setting on every request, so a change applies at once', async () => {
    seen = []
    let setting: string | undefined = proxyUrl
    configureOutboundProxy(() => setting)
    await (await outboundFetch(`http://a.invalid:${targetPort}/1`)).text()
    setting = undefined
    // Proxy off: loopback connects directly, and the proxy sees nothing more.
    expect(await (await outboundFetch(`http://127.0.0.1:${targetPort}/2`)).text()).toBe('hello GET /2')
    expect(seen).toHaveLength(1)
  })

  it('connects loopback and NO_PROXY hosts directly', async () => {
    seen = []
    configureOutboundProxy(() => proxyUrl)
    expect(await (await outboundFetch(`http://127.0.0.1:${targetPort}/local`)).text()).toBe('hello GET /local')
    expect(await (await outboundFetch(`http://localhost:${targetPort}/local`)).text()).toBe('hello GET /local')
    expect(seen).toEqual([])
    process.env.NO_PROXY = 'bypass.invalid'
    await expect(outboundFetch(`http://bypass.invalid:${targetPort}/x`)).rejects.toThrow()
    expect(seen).toEqual([])
  })

  it('does not touch process.env, so shell commands keep their own proxy variables', async () => {
    const before = { ...process.env }
    configureOutboundProxy(() => proxyUrl)
    await (await outboundFetch(`http://b.invalid:${targetPort}/`)).text()
    expect(process.env).toEqual(before)
  })
})
