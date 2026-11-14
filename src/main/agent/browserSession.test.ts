import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImageAttachment } from '@shared/images'
import {
  BLOCKED_BY_GUARD,
  BROWSER_UNAVAILABLE,
  BrowserSession,
  MAX_SNAPSHOT_CHARS,
  formatNetworkEntry,
  formatSnapshot,
  logLimit,
  parseSessionSteps,
  type BrowserBackend,
  type BrowserPage,
  type NetworkEntry
} from './browserSession'
import { browserSessionDestination, describeNetworkDestination, networkDestination } from './permissions'
import { builtinToolset, getTool, BROWSER_SESSION_NAME, type ToolContext } from './tools'
import { DEFERRED_TOOL_CATALOG } from './deferred-tools'
import { REDACTED_PASSWORD, refSelector, type CaptureStep } from './viewlocalhost'
import type { EvidenceDraft } from './evidence'

/** A fake page that records what it was asked to do. */
function fakePage(log: string[], over: Partial<BrowserPage> = {}): BrowserPage & { closed: boolean } {
  let url = ''
  const page = {
    closed: false,
    load: async (u: string) => {
      log.push(`load ${u}`)
      url = u
      return {}
    },
    title: () => 'Todos',
    url: () => url,
    rectForSelector: async () => null,
    screenshot: async () => Buffer.from('PNG'),
    screenshotFullPage: async () => ({ png: Buffer.from('PNG'), height: 800, truncated: false }),
    consoleEntries: () => [
      { level: 'log', text: 'one' },
      { level: 'error', text: 'boom' }
    ],
    runStep: async (step: CaptureStep) => {
      log.push(`step ${step.action} ${'selector' in step ? (step.selector ?? '') : ''}`)
      return { ok: true as const }
    },
    pageText: async () => 'Hello\nWorld',
    typedSecrets: () => [] as string[],
    snapshot: async () => '- heading "Todos" [level=1] [ref=e1]\n- textbox "New" [ref=e2]',
    networkEntries: (): NetworkEntry[] => [],
    isClosed(): boolean {
      return page.closed
    },
    close(): void {
      log.push('close')
      page.closed = true
    },
    ...over
  }
  return page
}

function backendWith(log: string[], over: Partial<BrowserPage> = {}): BrowserBackend & { opened: number } {
  const b = {
    opened: 0,
    open: async () => {
      b.opened++
      log.push('open window')
      return fakePage(log, over)
    }
  }
  return b
}

describe('BrowserSession', () => {
  it('refuses every non-loopback URL before opening a window', async () => {
    const log: string[] = []
    const backend = backendWith(log)
    const s = new BrowserSession(backend)
    for (const url of [
      'http://example.com',
      'http://10.0.0.1:3000',
      'http://192.168.1.2',
      'http://169.254.169.254/latest/meta-data',
      'file:///etc/passwd',
      'javascript:alert(1)'
    ]) {
      await expect(s.open(url)).rejects.toThrow()
    }
    expect(backend.opened).toBe(0)
    expect(s.isOpen()).toBe(false)
  })

  it('keeps one page across calls: a second open navigates it instead of opening another', async () => {
    const log: string[] = []
    const backend = backendWith(log)
    const s = new BrowserSession(backend)
    const first = await s.open('http://localhost:3000')
    const second = await s.open('http://127.0.0.1:3000/login')
    expect(first.reused).toBe(false)
    expect(second.reused).toBe(true)
    expect(backend.opened).toBe(1)
    expect(log).toEqual(['open window', 'load http://localhost:3000/', 'load http://127.0.0.1:3000/login'])
    expect(s.currentUrl()).toBe('http://127.0.0.1:3000/login')
    expect(second.pageText).toBe('Hello\nWorld')
  })

  it('needs an open page for every action but close', async () => {
    const s = new BrowserSession(backendWith([]))
    await expect(s.act([{ action: 'click', selector: '#a' }])).rejects.toThrow(/No browser session is open/)
    await expect(s.snapshot()).rejects.toThrow(/No browser session is open/)
    expect(() => s.console(10)).toThrow(/No browser session is open/)
    expect(() => s.network(10)).toThrow(/No browser session is open/)
    expect(s.close()).toBe(false)
    expect(s.currentUrl()).toBeNull()
  })

  it('acts on the open page and explains a stale ref', async () => {
    const log: string[] = []
    const s = new BrowserSession(
      backendWith(log, {
        runStep: async (step) =>
          'selector' in step && step.selector === refSelector('e9')
            ? { ok: false, error: 'no element matches the selector' }
            : { ok: true }
      })
    )
    await s.open('http://localhost:3000')
    const res = await s.act(parseSessionSteps([{ action: 'click', ref: 'e2' }, { action: 'click', ref: 'e9' }]))
    expect(res.steps).toEqual([
      { step: 'click ref e2', ok: true },
      { step: 'click ref e9', ok: false, error: 'no element has this ref any more; take a new snapshot' }
    ])
  })

  it('closes a page that stopped answering, so the next call starts clean', async () => {
    vi.useFakeTimers()
    try {
      const log: string[] = []
      const s = new BrowserSession(backendWith(log, { snapshot: () => new Promise<never>(() => {}) }))
      await s.open('http://localhost:3000')
      const p = s.snapshot()
      const caught = p.catch((e: Error) => e)
      await vi.runAllTimersAsync()
      expect(String(await caught)).toMatch(/stopped responding.*browser session was closed/)
      expect(log).toContain('close')
      expect(s.isOpen()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens a fresh page when the old one went away (a crashed renderer)', async () => {
    const log: string[] = []
    const backend = backendWith(log)
    const s = new BrowserSession(backend)
    await s.open('http://localhost:3000')
    s.close()
    expect(s.close()).toBe(false)
    const again = await s.open('http://localhost:3000')
    expect(again.reused).toBe(false)
    expect(backend.opened).toBe(2)
  })

  it('scrubs typed passwords from the snapshot, page text, console, and network log', async () => {
    const secret = 'hunter2-test'
    const s = new BrowserSession(
      backendWith([], {
        typedSecrets: () => [secret],
        snapshot: async () => `- text "you typed ${secret}" [ref=e1]`,
        pageText: async () => `echo ${secret}`,
        consoleEntries: () => [{ level: 'log', text: `pw=${secret}` }],
        networkEntries: () => [{ method: 'GET', url: `http://localhost:3000/login?pw=${secret}`, status: 200 }]
      })
    )
    const opened = await s.open('http://localhost:3000')
    expect(opened.pageText).toBe(`echo ${REDACTED_PASSWORD}`)
    const snap = await s.snapshot()
    expect(snap.tree).not.toContain(secret)
    expect(s.console(10).lines.join('\n')).not.toContain(secret)
    expect(s.network(10).lines.join('\n')).not.toContain(secret)
  })

  it('returns only the most recent log entries, with the total', async () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ method: 'GET', url: `http://localhost/${i}`, status: 200 }))
    const s = new BrowserSession(backendWith([], { networkEntries: () => entries }))
    await s.open('http://localhost:3000')
    const net = s.network(5)
    expect(net.total).toBe(30)
    expect(net.lines).toHaveLength(5)
    expect(net.lines[4]).toContain('http://localhost/29')
    expect(s.console(1).lines).toEqual(['ERROR: boom'])
  })
})

describe('browser_session parsing and formatting', () => {
  it('turns a ref into the selector for the element the snapshot marked', () => {
    expect(parseSessionSteps([{ action: 'fill', ref: 'e12', value: 'x' }])).toEqual([
      { action: 'fill', selector: '[data-houston-ref="e12"]', value: 'x' }
    ])
  })

  it('refuses a malformed ref, or a ref together with a selector', () => {
    expect(() => parseSessionSteps([{ action: 'click', ref: 'e1"] , body' }])).toThrow(/ref must be a ref/)
    expect(() => parseSessionSteps([{ action: 'click', ref: 'e0' }])).toThrow(/ref must be a ref/)
    expect(() => parseSessionSteps([{ action: 'click', ref: 'e1', selector: '#a' }])).toThrow(/not both/)
  })

  it('clamps a log limit', () => {
    expect(logLimit(undefined)).toBe(50)
    expect(logLimit(0)).toBe(1)
    expect(logLimit(10_000)).toBe(200)
  })

  it('cuts a long snapshot on a line boundary', () => {
    const raw = Array.from({ length: 2000 }, (_, i) => `- text "line ${i}"`).join('\n')
    const out = formatSnapshot(raw, [])
    expect(out.truncated).toBe(true)
    expect(out.text.length).toBeLessThanOrEqual(MAX_SNAPSHOT_CHARS)
    expect(out.text.endsWith('"')).toBe(true)
  })

  it('formats requests, naming the ones the network guard blocked', () => {
    expect(formatNetworkEntry({ method: 'GET', url: 'http://localhost/a', status: 200, durationMs: 12.4, resourceType: 'fetch' })).toBe(
      'GET 200 http://localhost/a (12ms, fetch)'
    )
    expect(formatNetworkEntry({ method: 'GET', url: 'http://10.0.0.1/', error: BLOCKED_BY_GUARD })).toContain(
      'GET BLOCKED http://10.0.0.1/'
    )
    expect(formatNetworkEntry({ method: 'POST', url: 'http://localhost/x', error: 'net::ERR_CONNECTION_REFUSED' })).toBe(
      'POST FAILED net::ERR_CONNECTION_REFUSED http://localhost/x'
    )
  })
})

describe('browser_session approval keys', () => {
  it('keys an open by its URL host, the same grant a view_localhost of that host uses', () => {
    const open = { action: 'open', url: 'http://LocalHost:5173/x' }
    expect(browserSessionDestination(open, null)).toBe('localhost')
    expect(browserSessionDestination(open, null)).toBe(networkDestination('view_localhost', { url: 'http://localhost:5173' }))
  })

  it('keys act as interacting with the host the session is on, apart from reading it', () => {
    const at = 'http://127.0.0.1:3000/app'
    expect(browserSessionDestination({ action: 'act', steps: [] }, at)).toBe('127.0.0.1 (interactive)')
    expect(browserSessionDestination({ action: 'snapshot' }, at)).toBe('127.0.0.1')
    expect(browserSessionDestination({ action: 'console' }, at)).toBe('127.0.0.1')
    expect(describeNetworkDestination('127.0.0.1 (interactive)')).toBe('clicking and typing on 127.0.0.1')
  })

  it('ignores a url the model passes to a non-open action', () => {
    expect(browserSessionDestination({ action: 'act', url: 'http://other.localhost' }, 'http://localhost:3000')).toBe(
      'localhost (interactive)'
    )
  })

  it('falls back to the tool name when there is no page, never to a host grant', () => {
    expect(browserSessionDestination({ action: 'act' }, null)).toBe('browser_session')
    expect(browserSessionDestination({ action: 'open', url: 'not a url' }, null)).toBe('browser_session')
    expect(networkDestination('browser_session', { action: 'snapshot' })).toBe('browser_session')
  })
})

describe('browser_session tool', () => {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'browser-session-')))
  const tool = getTool(BROWSER_SESSION_NAME)!
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ workspace: ws, allowNetwork: true, ...over })

  it('is a network tool, offered only where the backend exists, and deferred', () => {
    expect(tool.kind).toBe('network')
    const base = { localhostCapture: true, imageGallery: true, spawn: false, scheduler: false, planMode: false }
    expect(builtinToolset(base).map((t) => t.schema.name)).not.toContain(BROWSER_SESSION_NAME)
    expect(builtinToolset({ ...base, browserSession: true }).map((t) => t.schema.name)).toContain(BROWSER_SESSION_NAME)
    expect(DEFERRED_TOOL_CATALOG[BROWSER_SESSION_NAME]).toBeTruthy()
  })

  it('says it is not available in a client without the backend', async () => {
    expect(await tool.execute({ action: 'snapshot' }, ctx())).toBe(BROWSER_UNAVAILABLE)
  })

  it('rejects an unknown action', async () => {
    await expect(tool.execute({ action: 'eval' }, ctx())).rejects.toThrow(/action must be one of/)
  })

  it('fences page text, the accessibility tree, and the logs as untrusted, and attaches the screenshot', async () => {
    const browserSession = new BrowserSession(
      backendWith([], { networkEntries: () => [{ method: 'GET', url: 'http://localhost:3000/api', status: 500 }] })
    )
    const images: ImageAttachment[] = []
    const evidence: EvidenceDraft[] = []
    const c = ctx({ browserSession, attachImage: (i) => images.push(i), recordEvidence: (e) => evidence.push(e) })
    const fence = /<untrusted-content-[0-9a-f]{16} source="[^"]*">\n/

    const opened = await tool.execute({ action: 'open', url: 'http://localhost:3000' }, c)
    expect(opened).toContain('Opened a browser session at http://localhost:3000/')
    expect(opened).toMatch(fence)
    expect(opened.split(fence)[0]).not.toContain('Hello')

    const snap = await tool.execute({ action: 'snapshot' }, c)
    expect(images).toHaveLength(1)
    expect(snap.split(fence)[0]).not.toContain('textbox "New"')
    expect(snap).toContain('textbox "New" [ref=e2]')

    const acted = await tool.execute({ action: 'act', steps: [{ action: 'fill', ref: 'e2', value: 'milk' }] }, c)
    expect(acted).toContain('✓ fill ref e2')
    expect(acted).not.toContain('milk')

    const net = await tool.execute({ action: 'network' }, c)
    expect(net.split(fence)[0]).not.toContain('/api')
    expect(net).toContain('GET 500 http://localhost:3000/api')

    const con = await tool.execute({ action: 'console', limit: 1 }, c)
    expect(con).toContain('Last 1 of 2 console messages')

    expect(await tool.execute({ action: 'close' }, c)).toBe('Closed the browser session.')
    expect(await tool.execute({ action: 'close' }, c)).toBe('No browser session was open.')
    expect(evidence.map((e) => (e.kind === 'browser' ? e.planned : -1))).toEqual([0, 1])
  })

  it('summarizes act steps for the approval card without the typed values', () => {
    expect(tool.summarize({ action: 'act', steps: [{ action: 'fill', ref: 'e3', value: 'secret' }] })).toBe(
      'Browser: fill ref e3'
    )
    expect(tool.summarize({ action: 'open', url: 'http://localhost:3000' })).toBe('Browser: open http://localhost:3000')
  })
})
