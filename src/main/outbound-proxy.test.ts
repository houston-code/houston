import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'
import { createServer, request, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('./logger', () => ({ log: { warn: vi.fn(), info: vi.fn() } }))

import { Agent } from 'undici'
import {
  bypassesProxy,
  configureOutboundProxy,
  isValidProxyUrl,
  KEEP_ALIVE_TIMEOUT_MS,
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

describe('bypassesProxy', () => {
  const config = resolveOutboundProxy('http://proxy.corp:3128', { NO_PROXY: '10.0.0.0/8, 192.168.0.0/16,.corp.example,fd00::/8,bad/99' })!

  it("sends the user's own machine and private network direct", () => {
    for (const url of ['http://0.0.0.0:11434/v1', 'http://[::]:1234', 'http://172.20.1.2:8000', 'http://nas.local:11434', 'http://127.0.0.1:1'])
      expect(bypassesProxy(url, config), url).toBe(true)
  })

  it('honours CIDR ranges in NO_PROXY for IP literals', () => {
    const wide = resolveOutboundProxy('http://proxy.corp:3128', { NO_PROXY: '100.64.0.0/10,2001:db8::/32' })!
    expect(bypassesProxy('http://100.100.1.2:8080', wide)).toBe(true)
    expect(bypassesProxy('http://[2001:db8::5]:8080', wide)).toBe(true)
    expect(bypassesProxy('http://100.128.0.1:8080', wide)).toBe(false)
  })

  it('leaves public hosts and names to the proxy agent', () => {
    expect(bypassesProxy('https://api.anthropic.com/v1/messages', config)).toBe(false)
    expect(bypassesProxy('https://8.8.8.8/', config)).toBe(false)
    expect(bypassesProxy('not a url', config)).toBe(false)
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

  it('uses one shared direct agent with no proxy', () => {
    const direct = outboundDispatcher(null)
    expect(direct).toBeInstanceOf(Agent)
    expect(outboundDispatcher(null)).toBe(direct)
  })

  it('reuses one agent per configuration and replaces it when the configuration changes', () => {
    const a = resolveOutboundProxy('http://p:1', {})
    const b = resolveOutboundProxy('http://q:2', {})
    const direct = outboundDispatcher(null)
    const first = outboundDispatcher(a)
    expect(first).not.toBe(direct)
    expect(outboundDispatcher(a)).toBe(first)
    expect(outboundDispatcher(b)).not.toBe(first)
    expect(outboundDispatcher(null)).toBe(direct)
  })
})

/**
 * fetch's default agent drops a connection idle for 4 s, and a model API sends no
 * Keep-Alive hint to stretch that, so every request after a slow tool paid a new TCP and
 * TLS handshake. The server here, like the APIs, sends no hint.
 */
describe('outboundFetch keeps an idle connection open', () => {
  let server: Server
  let base: string
  const ports: number[] = []
  const hints: string[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      ports.push(req.socket.remotePort ?? -1)
      hints.push(String(res.getHeader('keep-alive') ?? ''))
      res.end('ok')
    })
    // 0: never time out an idle connection, and so send no `Keep-Alive: timeout=` hint
    // (the APIs send none either; a hint would set the client's idle limit instead).
    server.keepAliveTimeout = 0
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  })

  it(
    'reuses the connection after an idle gap longer than fetch’s 4 s default',
    async () => {
      expect(KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000)
      await (await outboundFetch(`${base}/a`, { method: 'POST', body: '{}' })).text()
      await new Promise((r) => setTimeout(r, 4_500))
      await (await outboundFetch(`${base}/b`, { method: 'POST', body: '{}' })).text()
      expect(ports).toHaveLength(2)
      expect(ports[1]).toBe(ports[0])
      expect(hints).toEqual(['', ''])
    },
    15_000
  )
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
    // A plain-http target is forwarded, not tunnelled: proxies commonly refuse CONNECT
    // to a port other than 443.
    expect(seen).toEqual([`POST http://model-host.invalid:${targetPort}/v1/chat`])
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

  it('connects the unspecified address and NO_PROXY CIDR ranges directly', async () => {
    seen = []
    configureOutboundProxy(() => proxyUrl)
    process.env.NO_PROXY = '203.0.113.0/24,2001:db8::/32'
    // Unroutable documentation addresses: a direct attempt fails or times out, while one
    // sent to the proxy would be seen (and answered) by it.
    for (const url of [`http://203.0.113.7:${targetPort}/x`, `http://[2001:db8::7]:${targetPort}/x`, `http://0.0.0.0:${targetPort}/x`]) {
      await outboundFetch(url, { signal: AbortSignal.timeout(300) })
        .then((r) => r.text())
        .catch(() => undefined)
    }
    expect(seen).toEqual([])
    // An address outside the ranges still goes through the proxy.
    await (await outboundFetch(`http://198.51.100.7:${targetPort}/y`)).text()
    expect(seen).toEqual([`GET http://198.51.100.7:${targetPort}/y`])
  })

  it('does not touch process.env, so shell commands keep their own proxy variables', async () => {
    const before = { ...process.env }
    configureOutboundProxy(() => proxyUrl)
    await (await outboundFetch(`http://b.invalid:${targetPort}/`)).text()
    expect(process.env).toEqual(before)
  })
})
