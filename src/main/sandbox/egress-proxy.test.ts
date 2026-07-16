import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer as createHttpServer } from 'node:http'
import type { Server } from 'node:http'
import { connect as netConnect } from 'node:net'
import type { Socket } from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EGRESS_BLOCKED_MARKER,
  EGRESS_PROXY_INNER_PORT,
  FORWARDER_SOURCE,
  egressProxyEnv,
  parseConnectTarget,
  startEgressProxy
} from './egress-proxy'
import type { EgressLogEvent, EgressProxyHandle } from './egress-proxy'

/** A tiny local HTTP target the proxy forwards to. */
function startTarget(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`target saw ${req.method} ${req.url}`)
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as { port: number }).port })
    })
  })
}

/** Raw proxy request (absolute-form), returning the full response text. */
function rawProxyHttp(proxyPort: number, absoluteUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(proxyPort, '127.0.0.1', () => {
      sock.write(`GET ${absoluteUrl} HTTP/1.1\r\nHost: placeholder\r\nConnection: close\r\n\r\n`)
    })
    const chunks: Buffer[] = []
    sock.on('data', (c: Buffer) => chunks.push(c))
    sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    sock.on('error', reject)
  })
}

/** Issue a CONNECT and resolve with the proxy's response line (+ body if any). */
function rawConnect(
  proxyPort: number,
  target: string
): Promise<{ head: string; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(proxyPort, '127.0.0.1', () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
    })
    sock.once('data', (c) => resolve({ head: c.toString('utf8'), socket: sock }))
    sock.on('error', reject)
  })
}

describe('parseConnectTarget', () => {
  it('parses host:port and bracketed IPv6, rejects garbage', () => {
    expect(parseConnectTarget('example.com:443')).toEqual({ host: 'example.com', port: 443 })
    expect(parseConnectTarget('EXAMPLE.com:443')).toEqual({ host: 'example.com', port: 443 })
    expect(parseConnectTarget('[::1]:8080')).toEqual({ host: '::1', port: 8080 })
    expect(parseConnectTarget('no-port')).toBeNull()
    expect(parseConnectTarget('host:0')).toBeNull()
    expect(parseConnectTarget('host:70000')).toBeNull()
    expect(parseConnectTarget('')).toBeNull()
  })
})

describe('egressProxyEnv', () => {
  it('sets both cases of the proxy vars and keeps loopback direct', () => {
    const env = egressProxyEnv('http://127.0.0.1:9999')
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:9999')
    expect(env.https_proxy).toBe('http://127.0.0.1:9999')
    expect(env.ALL_PROXY).toBe('http://127.0.0.1:9999')
    expect(env.NO_PROXY).toContain('localhost')
    expect(env.no_proxy).toContain('127.0.0.1')
  })
})

describe('startEgressProxy (TCP)', () => {
  let target: { server: Server; port: number }
  let proxy: EgressProxyHandle
  const log: EgressLogEvent[] = []

  beforeAll(async () => {
    target = await startTarget()
    proxy = await startEgressProxy({
      // Policy for the tests: only the loopback target host is allowed.
      checkHost: (host) =>
        host === '127.0.0.1' ? { allowed: true } : { allowed: false, reason: 'not on the allowlist' },
      log: (ev) => log.push(ev)
    })
  })

  afterAll(async () => {
    await proxy.close()
    await new Promise<void>((done) => target.server.close(() => done()))
  })

  it('forwards plain HTTP to an allowed host', async () => {
    const res = await rawProxyHttp(
      proxy.endpoints.tcpPort,
      `http://127.0.0.1:${target.port}/hello?q=1`
    )
    expect(res).toContain('200')
    expect(res).toContain('target saw GET /hello?q=1')
  })

  it('denies plain HTTP to a disallowed host with the marker and reason', async () => {
    const res = await rawProxyHttp(proxy.endpoints.tcpPort, 'http://attacker.example/steal')
    expect(res).toContain('403')
    expect(res).toContain(EGRESS_BLOCKED_MARKER)
    expect(res).toContain('attacker.example')
    expect(res).toContain('not on the allowlist')
    // Denied without ever dialing the target: no DNS lookup, no connection.
    expect(log.at(-1)).toEqual({
      allowed: false,
      host: 'attacker.example',
      port: 80,
      via: 'http'
    })
  })

  it('tunnels CONNECT to an allowed host', async () => {
    const { head, socket } = await rawConnect(
      proxy.endpoints.tcpPort,
      `127.0.0.1:${target.port}`
    )
    expect(head).toContain('200 Connection Established')
    // The tunnel is a raw TCP pipe: speak HTTP through it to the target.
    const body = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = []
      socket.on('data', (c: Buffer) => chunks.push(c))
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      socket.write(`GET /via-tunnel HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n`)
    })
    expect(body).toContain('target saw GET /via-tunnel')
  })

  it('denies CONNECT to a disallowed host with a 403 and the marker', async () => {
    const { head } = await rawConnect(proxy.endpoints.tcpPort, 'evil.example:443')
    expect(head).toContain('403 Forbidden')
    expect(head).toContain(EGRESS_BLOCKED_MARKER)
    expect(log.at(-1)).toMatchObject({ allowed: false, host: 'evil.example', via: 'connect' })
  })

  it('rejects a malformed CONNECT target', async () => {
    const { head } = await rawConnect(proxy.endpoints.tcpPort, 'malformed')
    expect(head).toContain('400')
  })

  it('rejects origin-form requests (not a web server)', async () => {
    const res = await rawProxyHttp(proxy.endpoints.tcpPort, '/not-absolute')
    expect(res).toContain('400')
  })

  it('answers 502 when the allowed upstream is unreachable', async () => {
    // Port 1 on loopback: allowed by the test policy, but nothing listens there.
    const { head } = await rawConnect(proxy.endpoints.tcpPort, '127.0.0.1:1')
    expect(head).toContain('502')
  })
})

describe.skipIf(process.platform === 'win32')('startEgressProxy (unix socket + forwarder)', () => {
  let target: { server: Server; port: number }
  let proxy: EgressProxyHandle

  beforeAll(async () => {
    target = await startTarget()
    proxy = await startEgressProxy({
      checkHost: (host) => ({ allowed: host === '127.0.0.1' }),
      listenUnix: true
    })
  })

  afterAll(async () => {
    await proxy.close()
    await new Promise<void>((done) => target.server.close(() => done()))
  })

  it('exposes unix-socket endpoints alongside the TCP port', () => {
    expect(proxy.endpoints.tcpPort).toBeGreaterThan(0)
    expect(proxy.endpoints.unixSocketPath).toMatch(/houston-egress-.*proxy\.sock$/)
    expect(proxy.endpoints.forwarderPath).toMatch(/forwarder\.cjs$/)
  })

  it('serves proxy requests over the unix socket', async () => {
    const res = await new Promise<string>((resolve, reject) => {
      const sock = netConnect(proxy.endpoints.unixSocketPath as string, () => {
        sock.write(
          `GET http://127.0.0.1:${target.port}/unix HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n`
        )
      })
      const chunks: Buffer[] = []
      sock.on('data', (c: Buffer) => chunks.push(c))
      sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      sock.on('error', reject)
    })
    expect(res).toContain('target saw GET /unix')
  })

  it('forwarder bridges an inner TCP port to the unix socket, runs the command, and propagates its exit code', async () => {
    // Run the forwarder under plain Node the way bubblewrap runs it under
    // ELECTRON_RUN_AS_NODE — same script, same argv contract. The wrapped
    // command curls THROUGH the forwarded port to prove the bridge works.
    const dir = mkdtempSync(join(tmpdir(), 'houston-fwd-test-'))
    const script = join(dir, 'forwarder.cjs')
    writeFileSync(script, FORWARDER_SOURCE)
    const innerPort = EGRESS_PROXY_INNER_PORT
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn(
          process.execPath,
          [
            script,
            proxy.endpoints.unixSocketPath as string,
            String(innerPort),
            '--',
            '/bin/bash',
            '-c',
            `curl -s -x http://127.0.0.1:${innerPort} http://127.0.0.1:${target.port}/bridged; exit 42`
          ],
          { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
        )
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
        child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
        child.on('exit', (code) => resolve({ code, stdout, stderr }))
      }
    )
    await rm(dir, { recursive: true, force: true })
    expect(out.stderr).toBe('')
    expect(out.stdout).toContain('target saw GET /bridged')
    expect(out.code).toBe(42) // the command's exit code survives the forwarder
  })

  it('forwarder exits with a usage error when misinvoked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'houston-fwd-usage-'))
    const script = join(dir, 'forwarder.cjs')
    writeFileSync(script, FORWARDER_SOURCE)
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [script, 'only-a-socket'])
      child.on('exit', (c) => resolve(c))
    })
    await rm(dir, { recursive: true, force: true })
    expect(code).toBe(96)
  })
})
