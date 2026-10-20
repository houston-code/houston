import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The pure serving and filtering rules are tested here; the Electron pieces are
// stubbed so the module loads outside Electron.
vi.mock('electron', () => ({ BrowserWindow: class {}, protocol: {}, session: {} }))

const {
  MOCKUP_CSP,
  MOCKUP_SCHEME,
  contentTypeFor,
  isAllowedMockupRequest,
  mockupHeaders,
  mockupUrl,
  serveMockupRequest
} = await import('./mockupCapture')

const TOKEN = '0123456789abcdef0123456789abcdef'
let root: string
let outside: string
const lookup = (token: string): string | undefined => (token === TOKEN ? root : undefined)
const url = (path: string): string => `${MOCKUP_SCHEME}://${TOKEN}/${path}`

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'houston-mockup-serve-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'houston-mockup-secret-')))
  mkdirSync(join(root, 'mockups', 'assets'), { recursive: true })
  writeFileSync(join(root, 'mockups', 'page one.html'), '<link rel="stylesheet" href="assets/app.css">')
  writeFileSync(join(root, 'mockups', 'assets', 'app.css'), 'body{color:red}')
  writeFileSync(join(outside, 'id_rsa'), 'PRIVATE KEY')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('isAllowedMockupRequest', () => {
  it('lets only the private scheme and in-memory URLs through', () => {
    expect(isAllowedMockupRequest(url('mockups/a.html'))).toBe(true)
    expect(isAllowedMockupRequest('data:image/png;base64,AAAA')).toBe(true)
    expect(isAllowedMockupRequest('blob:houston-mockup://x/1234')).toBe(true)
    expect(isAllowedMockupRequest('about:blank')).toBe(true)
  })

  it('cancels every scheme that reaches a network or the filesystem', () => {
    for (const u of [
      'https://fonts.googleapis.com/css',
      'http://127.0.0.1:9/',
      'http://169.254.169.254/latest/meta-data',
      'ws://localhost:3000/socket',
      'wss://example.com/',
      'ftp://example.com/x',
      'file:///etc/passwd',
      'not a url'
    ]) {
      expect(isAllowedMockupRequest(u)).toBe(false)
    }
  })
})

describe('serveMockupRequest', () => {
  it('serves a file inside the root with its type and the lockdown headers', async () => {
    const res = await serveMockupRequest(url('mockups/assets/app.css'), lookup)
    expect(res.status).toBe(200)
    expect(String(res.body)).toBe('body{color:red}')
    expect(res.headers['content-type']).toBe('text/css; charset=utf-8')
    expect(res.headers['content-security-policy']).toBe(MOCKUP_CSP)
    expect(res.headers['x-dns-prefetch-control']).toBe('off')
  })

  it('decodes percent-encoded names', async () => {
    const res = await serveMockupRequest(url('mockups/page%20one.html'), lookup)
    expect(res.status).toBe(200)
  })

  it('never serves anything outside the root', async () => {
    for (const path of [
      '../' + outside.split('/').pop() + '/id_rsa',
      '%2e%2e/%2e%2e/etc/passwd',
      'mockups/..%2f..%2f' + 'etc/passwd',
      encodeURIComponent(join(outside, 'id_rsa')),
      'mockups/%00.html'
    ]) {
      const res = await serveMockupRequest(url(path), lookup)
      expect(res.status, path).toBe(404)
      expect(String(res.body)).not.toContain('PRIVATE KEY')
    }
  })

  it('never serves a credential file inside the root', async () => {
    writeFileSync(join(root, '.env'), 'API_KEY=sk-live-123')
    mkdirSync(join(root, 'keys'))
    writeFileSync(join(root, 'keys', 'server.pem'), 'PRIVATE KEY')
    for (const path of ['.env', 'keys/server.pem', 'mockups/../.env']) {
      const res = await serveMockupRequest(url(path), lookup)
      expect(res.status, path).toBe(404)
      expect(String(res.body)).not.toMatch(/sk-live|PRIVATE/)
    }
  })

  it('refuses a symlink that leads out of the root', async () => {
    if (process.platform === 'win32') return
    symlinkSync(join(outside, 'id_rsa'), join(root, 'mockups', 'key.css'))
    const res = await serveMockupRequest(url('mockups/key.css'), lookup)
    expect(res.status).toBe(404)
  })

  it('answers 404 for an unknown token, a directory, the root itself, or another scheme', async () => {
    expect((await serveMockupRequest(`${MOCKUP_SCHEME}://ffff/mockups/assets/app.css`, lookup)).status).toBe(404)
    expect((await serveMockupRequest(url('mockups/assets'), lookup)).status).toBe(404)
    expect((await serveMockupRequest(url(''), lookup)).status).toBe(404)
    expect((await serveMockupRequest(`https://${TOKEN}/mockups/assets/app.css`, lookup)).status).toBe(404)
  })

  it('keeps the lockdown headers on a 404 too', async () => {
    const res = await serveMockupRequest(url('missing.css'), lookup)
    expect(res.headers['content-security-policy']).toBe(MOCKUP_CSP)
  })
})

describe('mockup page URLs', () => {
  it('encode each path segment and append the variant query', () => {
    const u = mockupUrl(TOKEN, root, join(root, 'mockups', 'page one.html'), '?state=empty')
    expect(u).toBe(`${MOCKUP_SCHEME}://${TOKEN}/mockups/page%20one.html?state=empty`)
  })

  it('round-trip through the server to the same file', async () => {
    const res = await serveMockupRequest(mockupUrl(TOKEN, root, join(root, 'mockups', 'page one.html')), lookup)
    expect(res.status).toBe(200)
  })
})

describe('response details', () => {
  it('types common mockup assets and falls back to octet-stream', () => {
    expect(contentTypeFor('a.HTML')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('font.woff2')).toBe('font/woff2')
    expect(contentTypeFor('x.unknown')).toBe('application/octet-stream')
  })

  it('limits the page to its own origin', () => {
    expect(MOCKUP_CSP).toContain("connect-src 'self' data: blob:")
    expect(MOCKUP_CSP).toContain("form-action 'none'")
    expect(MOCKUP_CSP).not.toMatch(/https?:/)
    expect(mockupHeaders('text/plain')['x-content-type-options']).toBe('nosniff')
  })
})
