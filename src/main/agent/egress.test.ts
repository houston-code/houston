import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkEgressHost, egressEndpointsForRun, resetEgressProxyForTests } from './egress'
import type { StartEgressProxyOptions } from '../sandbox'

afterEach(async () => {
  await resetEgressProxyForTests()
})

describe('checkEgressHost', () => {
  it('never proxies private, loopback, or metadata literals — even when allowlisted', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '10.0.0.8', '192.168.1.1', '169.254.169.254']) {
      const check = checkEgressHost(host, { sandboxEgress: { allow: [host] } })
      expect(check.allowed).toBe(false)
      expect(check.reason).toContain('never proxied')
    }
  })

  it('allows the built-in dev hosts and user entries, denies the rest with a reason', () => {
    const settings = { sandboxEgress: { allow: ['corp.example'], deny: ['gitlab.com'] } }
    expect(checkEgressHost('registry.npmjs.org', settings).allowed).toBe(true)
    expect(checkEgressHost('api.corp.example', settings).allowed).toBe(true)
    expect(checkEgressHost('attacker.example', settings)).toEqual({
      allowed: false,
      reason: 'not on the allowlist'
    })
    expect(checkEgressHost('gitlab.com', settings)).toEqual({
      allowed: false,
      reason: 'the domain is on the deny list'
    })
  })
})

describe('egressEndpointsForRun', () => {
  it("returns undefined in mode 'all' (legacy unrestricted network, no proxy)", async () => {
    const start = vi.fn()
    const endpoints = await egressEndpointsForRun({
      settings: () => ({ sandboxEgress: { mode: 'all' } }),
      start
    })
    expect(endpoints).toBeUndefined()
    expect(start).not.toHaveBeenCalled()
  })

  it('starts the proxy once and shares it across runs (allowlist mode)', async () => {
    let started = 0
    const start = vi.fn(async (_opts: StartEgressProxyOptions) => {
      started++
      return { endpoints: { tcpPort: 9137 }, close: async () => {} }
    })
    const deps = { settings: () => ({}), start }
    expect(await egressEndpointsForRun(deps)).toEqual({ tcpPort: 9137 })
    expect(await egressEndpointsForRun(deps)).toEqual({ tcpPort: 9137 })
    expect(started).toBe(1)
  })

  it('requests the unix transport only on Linux', async () => {
    const seen: boolean[] = []
    const start = vi.fn(async (opts: StartEgressProxyOptions) => {
      seen.push(opts.listenUnix === true)
      return { endpoints: { tcpPort: 1 }, close: async () => {} }
    })
    await egressEndpointsForRun({ settings: () => ({}), start, platform: 'linux' })
    await resetEgressProxyForTests()
    await egressEndpointsForRun({ settings: () => ({}), start, platform: 'darwin' })
    expect(seen).toEqual([true, false])
  })

  it('the proxy policy reads settings fresh on every request (mid-run edits apply)', async () => {
    let captured: StartEgressProxyOptions | undefined
    const start = vi.fn(async (opts: StartEgressProxyOptions) => {
      captured = opts
      return { endpoints: { tcpPort: 1 }, close: async () => {} }
    })
    let allow: string[] = []
    await egressEndpointsForRun({ settings: () => ({ sandboxEgress: { allow } }), start })
    expect(captured!.checkHost('corp.example').allowed).toBe(false)
    allow = ['corp.example'] // the user adds the domain in Settings, mid-run
    expect(captured!.checkHost('corp.example').allowed).toBe(true)
  })

  it('fails CLOSED: a start failure propagates, and the next call retries', async () => {
    const start = vi
      .fn()
      .mockRejectedValueOnce(new Error('bind failed'))
      .mockResolvedValueOnce({ endpoints: { tcpPort: 2 }, close: async () => {} })
    const deps = { settings: () => ({}), start }
    await expect(egressEndpointsForRun(deps)).rejects.toThrow('bind failed')
    expect(await egressEndpointsForRun(deps)).toEqual({ tcpPort: 2 })
  })

  it('integration: starts the real proxy and serves the policy through it', async () => {
    const endpoints = await egressEndpointsForRun({
      settings: () => ({ sandboxEgress: { deny: ['github.com'] } }),
      platform: 'darwin'
    })
    expect(endpoints?.tcpPort).toBeGreaterThan(0)
    // A real CONNECT to the running proxy: denied host answers 403 with the marker.
    const { connect } = await import('node:net')
    const head = await new Promise<string>((resolve, reject) => {
      const sock = connect(endpoints!.tcpPort, '127.0.0.1', () => {
        sock.write('CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n')
      })
      sock.once('data', (c) => resolve(c.toString('utf8')))
      sock.on('error', reject)
    })
    expect(head).toContain('403')
    expect(head).toContain('EGRESS_BLOCKED')
  })
})
