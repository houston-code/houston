import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { connect as netConnect } from 'node:net'
import type { Socket } from 'node:net'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EgressProxyEndpoints } from './contract'

/**
 * The egress proxy: a loopback HTTP proxy owned by the (trusted) main process
 * that enforces the per-domain egress policy for network-granted sandbox
 * commands.
 *
 * How enforcement composes per platform:
 *  - The OS sandbox blocks DIRECT egress in proxied mode (Seatbelt allows
 *    outbound only to loopback; bubblewrap keeps its empty network namespace),
 *    so the proxy is the only road out.
 *  - The command's environment carries HTTP_PROXY/HTTPS_PROXY/ALL_PROXY pointing
 *    here, which the dev toolchain (curl, git-over-https, npm, pip, cargo, go,
 *    gradle, …) honors.
 *  - The proxy sees the target HOSTNAME without any TLS interception: HTTPS
 *    arrives as `CONNECT host:port`, plain HTTP as an absolute-form URI. That is
 *    exactly the granularity a per-domain allow/deny needs, so no masking
 *    (MITM) proxy or trust-store surgery is involved.
 *
 * The policy itself is injected (`checkHost`), so this file stays free of
 * settings/agent imports and is testable with any policy.
 */

/**
 * Marker prefixed to every deny response body. run_shell scans its output for
 * this (and the proxy-403 shapes curl prints) to append the "egress blocked"
 * hint, so keep it stable.
 */
export const EGRESS_BLOCKED_MARKER = 'EGRESS_BLOCKED'

/**
 * The fixed loopback port the in-namespace forwarder listens on inside a
 * bubblewrap sandbox. The network namespace is freshly created per command, so
 * the port cannot collide with anything but the command's own listeners; it is
 * deliberately an uncommon number to keep out of the way of dev-server defaults.
 */
export const EGRESS_PROXY_INNER_PORT = 24127

/** Loopback names a proxied command must reach directly (not via the proxy). */
const NO_PROXY_HOSTS = 'localhost,127.0.0.1,::1'

/**
 * Proxy environment for a proxied launch. Both cases so every tool sees it
 * (curl reads lowercase; many CLIs read uppercase; ALL_PROXY catches the rest).
 * NO_PROXY keeps loopback traffic direct — dev servers must not detour through
 * (and be refused by) the egress proxy.
 */
export function egressProxyEnv(proxyUrl: string): NodeJS.ProcessEnv {
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: NO_PROXY_HOSTS,
    no_proxy: NO_PROXY_HOSTS
  }
}

/** One egress decision from the injected policy. `reason` is appended to deny bodies. */
export interface EgressCheck {
  allowed: boolean
  reason?: string
}

export interface EgressLogEvent {
  allowed: boolean
  host: string
  port: number
  via: 'connect' | 'http'
}

export interface StartEgressProxyOptions {
  /** The policy: may the sandbox reach `host`? Called per request with the normalized hostname. */
  checkHost: (host: string) => EgressCheck
  /**
   * Also listen on a unix socket and write the in-namespace forwarder script
   * (the bubblewrap transport — see {@link FORWARDER_SOURCE}). POSIX only.
   */
  listenUnix?: boolean
  /** Observability callback for every allow/deny decision. */
  log?: (ev: EgressLogEvent) => void
  /** Base directory for the unix-socket dir (default `os.tmpdir()`); injectable for tests. */
  baseTmpDir?: string
}

export interface EgressProxyHandle {
  endpoints: EgressProxyEndpoints
  close(): Promise<void>
}

/**
 * The forwarder that runs INSIDE a bubblewrap network namespace. The namespace
 * has only its own loopback — the host's loopback (and thus the proxy's TCP
 * port) is unreachable — but a unix socket crosses the boundary via the
 * filesystem bind of the temp dir. The forwarder listens on
 * 127.0.0.1:EGRESS_PROXY_INNER_PORT inside the namespace, pipes each connection
 * into the proxy's unix socket, and only then starts the real command (as its
 * child, argv passed verbatim after `--`), so the proxy port is listening
 * before the command can race to use it and the forwarder's lifetime is exactly
 * the command's.
 *
 * It runs under the Electron binary with ELECTRON_RUN_AS_NODE=1 (plain Node
 * semantics, no app code); that variable is scrubbed from the command's own
 * environment so a command that itself launches an Electron app is unaffected.
 */
export const FORWARDER_SOURCE = `'use strict'
// Houston sandbox egress forwarder. See src/main/sandbox/egress-proxy.ts.
const net = require('net')
const { spawn } = require('child_process')
const args = process.argv.slice(2)
const sock = args[0]
const port = Number(args[1])
const sep = args.indexOf('--')
const cmd = sep >= 0 ? args.slice(sep + 1) : []
if (!sock || !Number.isFinite(port) || cmd.length === 0) {
  console.error('usage: forwarder <unix-socket> <port> -- <command...>')
  process.exit(96)
}
const server = net.createServer((client) => {
  const upstream = net.connect(sock)
  const drop = () => { client.destroy(); upstream.destroy() }
  client.on('error', drop)
  upstream.on('error', drop)
  client.pipe(upstream)
  upstream.pipe(client)
})
server.on('error', (e) => {
  console.error('egress forwarder failed: ' + e.message)
  process.exit(97)
})
server.listen(port, '127.0.0.1', () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env })
  child.on('error', (e) => {
    console.error('egress forwarder could not start the command: ' + e.message)
    process.exit(95)
  })
  child.on('exit', (code, signal) => {
    server.close()
    if (code !== null) process.exit(code)
    process.exit(signal === 'SIGKILL' ? 137 : 143)
  })
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(s, () => { try { child.kill(s) } catch {} })
  }
})
`

/**
 * Parse a CONNECT target (`host:port`, `[v6]:port`) into host + port. Returns
 * null for anything malformed — the caller denies those.
 */
export function parseConnectTarget(target: string): { host: string; port: number } | null {
  if (!target) return null
  const bracketed = target.match(/^\[([^\]]+)\]:(\d{1,5})$/)
  const plain = bracketed ? null : target.match(/^([^:]+):(\d{1,5})$/)
  const m = bracketed ?? plain
  if (!m) return null
  const port = Number(m[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host: m[1].toLowerCase(), port }
}

/** Hop-by-hop headers a proxy must not forward (plus the proxy-* request headers). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

function forwardableHeaders(headers: IncomingMessage['headers']): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue
    out[k] = v
  }
  return out
}

/** Grace for the upstream TCP connect before the attempt is reported as unreachable. */
const UPSTREAM_CONNECT_TIMEOUT_MS = 15_000

function denyBody(host: string, reason: string | undefined): string {
  const detail = reason ? ` (${reason})` : ''
  return (
    `${EGRESS_BLOCKED_MARKER}: the sandbox egress policy does not allow network access to "${host}"${detail}. ` +
    'Granted network is restricted to the built-in dev-infrastructure allowlist plus the domains configured in ' +
    'Settings under "Sandbox egress". If this host is legitimately needed, the user can add it there.\n'
  )
}

/**
 * Start the egress proxy on 127.0.0.1 (ephemeral port), and optionally on a
 * unix socket for the bubblewrap transport. The returned handle's `close()`
 * tears down listeners, live tunnels, and the socket's temp dir.
 */
export function startEgressProxy(opts: StartEgressProxyOptions): Promise<EgressProxyHandle> {
  const sockets = new Set<Socket>()
  const track = (s: Socket): void => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  }

  const decide = (host: string, port: number, via: 'connect' | 'http'): EgressCheck => {
    const check = opts.checkHost(host)
    opts.log?.({ allowed: check.allowed, host, port, via })
    return check
  }

  // Plain-HTTP proxying (absolute-form request line, e.g. `GET http://host/path`).
  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    let url: URL
    try {
      // Absolute-form only: an origin-form path means someone hit the proxy port
      // directly as if it were a web server, which is not a proxied request.
      if (!/^https?:\/\//i.test(req.url ?? '')) throw new Error('not absolute-form')
      url = new URL(req.url as string)
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('Bad request: this is an HTTP proxy; use absolute-form request URIs.\n')
      return
    }
    const host = url.hostname.toLowerCase()
    const port = url.port ? Number(url.port) : 80
    const check = decide(host, port, 'http')
    if (!check.allowed) {
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end(denyBody(host, check.reason))
      return
    }
    const upstream = httpRequest(
      {
        host: url.hostname,
        port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: forwardableHeaders(req.headers),
        timeout: UPSTREAM_CONNECT_TIMEOUT_MS
      },
      (upRes) => {
        // Strip hop-by-hop headers here too: a forwarded `Connection: keep-alive`
        // would override the client connection's own lifecycle (e.g. its
        // `Connection: close`) and leave the socket dangling.
        res.writeHead(upRes.statusCode ?? 502, forwardableHeaders(upRes.headers))
        upRes.pipe(res)
      }
    )
    upstream.on('timeout', () => upstream.destroy(new Error('upstream connect timed out')))
    upstream.on('error', (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end(`Bad gateway: ${e.message}\n`)
      } else {
        res.destroy()
      }
    })
    req.on('error', () => upstream.destroy())
    req.pipe(upstream)
  }

  // HTTPS (and any TCP) tunneling via CONNECT — the normal path for TLS traffic.
  const onConnect = (req: IncomingMessage, client: Socket, head: Buffer): void => {
    track(client)
    client.on('error', () => client.destroy())
    const target = parseConnectTarget(req.url ?? '')
    if (!target) {
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      return
    }
    const check = decide(target.host, target.port, 'connect')
    if (!check.allowed) {
      const body = denyBody(target.host, check.reason)
      client.end(
        `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
      )
      return
    }
    const upstream = netConnect({ host: target.host, port: target.port })
    track(upstream)
    const abort = (msg: string): void => {
      if (!client.destroyed && client.writable) {
        client.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n${msg}\n`)
      }
      upstream.destroy()
    }
    upstream.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS, () => abort('upstream connect timed out'))
    upstream.on('error', (e) => abort(`Bad gateway: ${e.message}`))
    upstream.on('connect', () => {
      upstream.setTimeout(0)
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      client.pipe(upstream)
      upstream.pipe(client)
      const drop = (): void => {
        client.destroy()
        upstream.destroy()
      }
      client.on('error', drop)
      upstream.on('error', drop)
      client.on('close', drop)
      upstream.on('close', drop)
    })
  }

  const makeServer = (): Server => {
    const server = createServer(onRequest)
    server.on('connect', onConnect)
    server.on('connection', track)
    return server
  }

  return new Promise((resolve, reject) => {
    const tcpServer = makeServer()
    tcpServer.on('error', reject)
    tcpServer.listen(0, '127.0.0.1', () => {
      const address = tcpServer.address()
      if (address === null || typeof address === 'string') {
        tcpServer.close()
        reject(new Error('egress proxy failed to bind a loopback TCP port'))
        return
      }
      const tcpPort = address.port

      const finish = (extra: {
        unixServer?: Server
        unixSocketPath?: string
        forwarderPath?: string
        unixDir?: string
      }): void => {
        const endpoints: EgressProxyEndpoints = {
          tcpPort,
          ...(extra.unixSocketPath ? { unixSocketPath: extra.unixSocketPath } : {}),
          ...(extra.forwarderPath ? { forwarderPath: extra.forwarderPath } : {})
        }
        resolve({
          endpoints,
          close: async () => {
            for (const s of sockets) s.destroy()
            await Promise.all(
              [tcpServer, extra.unixServer]
                .filter((s): s is Server => s !== undefined)
                .map((s) => new Promise<void>((done) => s.close(() => done())))
            )
            if (extra.unixDir) await rm(extra.unixDir, { recursive: true, force: true })
          }
        })
      }

      if (!opts.listenUnix) {
        finish({})
        return
      }

      // The unix-socket listener + forwarder script live in a private (0700)
      // temp dir. It must sit under the OS temp root because that is what the
      // bubblewrap profile bind-mounts into the sandbox — realpath'd so the
      // path we hand the forwarder matches the bind (linux.ts realpaths too).
      let unixDir: string
      let forwarderPath: string
      try {
        // mkdtemp creates the dir 0700 on POSIX — private to the user on a shared host.
        unixDir = mkdtempSync(join(realpathSync(opts.baseTmpDir ?? tmpdir()), 'houston-egress-'))
        forwarderPath = join(unixDir, 'forwarder.cjs')
        writeFileSync(forwarderPath, FORWARDER_SOURCE, { mode: 0o600 })
      } catch (e) {
        tcpServer.close()
        reject(e instanceof Error ? e : new Error(String(e)))
        return
      }
      const unixSocketPath = join(unixDir, 'proxy.sock')
      const unixServer = makeServer()
      unixServer.on('error', (e) => {
        tcpServer.close()
        void rm(unixDir, { recursive: true, force: true })
        reject(e)
      })
      unixServer.listen(unixSocketPath, () => {
        finish({ unixServer, unixSocketPath, forwarderPath, unixDir })
      })
    })
  })
}
