import { describe, expect, it, vi } from 'vitest'

// The serving and validation rules are pure; the Electron pieces are stubbed so the
// module loads outside Electron.
vi.mock('electron', () => ({ BrowserWindow: class {}, protocol: {}, session: {}, app: { commandLine: {} } }))

const {
  HTML_VISUAL_CSP,
  HTML_VISUAL_RUNTIME,
  MAX_HTML_VISUAL,
  MERMAID_RUNNER,
  htmlVisualDocument,
  isAllowedChatFrameUrl,
  isAllowedVisualRequest,
  parseMermaidRequest,
  registerHtmlVisual,
  serveHtmlVisual,
  serveMermaidAsset
} = await import('./visualRender')
const { PREFETCH_OFF_META } = await import('./mockupCapture')

const ID = '0123456789abcdef0123456789abcdef'

describe('HTML visual documents', () => {
  it('put the prefetch-off meta and the runtime first, after any doctype', () => {
    expect(htmlVisualDocument('<!DOCTYPE html><p>x</p>')).toBe(`<!DOCTYPE html>${PREFETCH_OFF_META}${HTML_VISUAL_RUNTIME}<p>x</p>`)
    expect(htmlVisualDocument('<p>x</p>').startsWith(PREFETCH_OFF_META + HTML_VISUAL_RUNTIME)).toBe(true)
  })

  it('remove WebRTC before the page can use it, and report only a height', () => {
    expect(HTML_VISUAL_RUNTIME).toContain("'RTCPeerConnection'")
    expect(HTML_VISUAL_RUNTIME).toContain('configurable: false')
    expect(HTML_VISUAL_RUNTIME).toContain("houstonVisual: 'resize'")
  })

  it('are served with a CSP that refuses every kind of request', () => {
    const res = serveHtmlVisual(`houston-visual://doc/${ID}`, (id) => (id === ID ? '<p>hi</p>' : undefined))
    expect(res.status).toBe(200)
    expect(res.headers['content-security-policy']).toBe(HTML_VISUAL_CSP)
    for (const d of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "form-action 'none'"]) {
      expect(HTML_VISUAL_CSP).toContain(d)
    }
    expect(HTML_VISUAL_CSP).not.toMatch(/https?:|\*/)
    expect(res.body).toContain('<p>hi</p>')
  })

  it('answer 404 for anything but a known, well-formed document id', () => {
    const lookup = (id: string): string | undefined => (id === ID ? '<p>hi</p>' : undefined)
    for (const url of [
      `houston-visual://doc/${'f'.repeat(32)}`,
      'houston-visual://doc/../mermaid/runner.html',
      `houston-visual://mermaid/${ID}`,
      `https://doc/${ID}`,
      'not a url'
    ]) {
      expect(serveHtmlVisual(url, lookup).status, url).toBe(404)
    }
  })

  it('are registered only within the size cap, and the oldest are forgotten', () => {
    expect(registerHtmlVisual('')).toBeNull()
    expect(registerHtmlVisual(42)).toBeNull()
    expect(registerHtmlVisual('x'.repeat(MAX_HTML_VISUAL + 1))).toBeNull()
    const first = registerHtmlVisual('<p>first</p>')!
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(serveHtmlVisual(`houston-visual://doc/${first}`).status).toBe(200)
    for (let i = 0; i < 64; i++) registerHtmlVisual(`<p>${i}</p>`)
    expect(serveHtmlVisual(`houston-visual://doc/${first}`).status).toBe(404)
  })
})

describe('Mermaid window assets', () => {
  it('serve only the runner page and the bundled library', () => {
    const js = (): string => 'MERMAID'
    expect(serveMermaidAsset('houston-visual://mermaid/runner.html', js).body).toBe(MERMAID_RUNNER)
    expect(serveMermaidAsset('houston-visual://mermaid/mermaid.min.js', js).body).toBe('MERMAID')
    expect(serveMermaidAsset('houston-visual://mermaid/../../etc/passwd', js).status).toBe(404)
    expect(serveMermaidAsset(`houston-visual://doc/${ID}`, js).status).toBe(404)
  })

  it('render with Mermaid’s strict security level and DNS prefetch off', () => {
    expect(MERMAID_RUNNER).toContain("securityLevel: 'strict'")
    expect(MERMAID_RUNNER).toContain(PREFETCH_OFF_META)
  })
})

describe('request and navigation rules', () => {
  it('let the Mermaid window load only the private scheme and in-memory data', () => {
    expect(isAllowedVisualRequest('houston-visual://mermaid/mermaid.min.js')).toBe(true)
    expect(isAllowedVisualRequest('data:image/png;base64,AA')).toBe(true)
    for (const u of ['https://cdn.example/x.js', 'http://127.0.0.1:9/', 'file:///etc/passwd', 'ws://x/']) {
      expect(isAllowedVisualRequest(u)).toBe(false)
    }
  })

  it('let a frame in the chat load only an HTML visual document', () => {
    expect(isAllowedChatFrameUrl(`houston-visual://doc/${ID}`)).toBe(true)
    expect(isAllowedChatFrameUrl('about:blank')).toBe(true)
    for (const u of ['https://example.com/', 'houston-visual://mermaid/runner.html', 'file:///etc/hosts', 'javascript:alert(1)']) {
      expect(isAllowedChatFrameUrl(u)).toBe(false)
    }
  })

  it('validate Mermaid requests from the renderer', () => {
    expect(parseMermaidRequest('flowchart LR', 'dark')).toEqual({ source: 'flowchart LR', theme: 'dark' })
    expect(parseMermaidRequest('flowchart LR', 'sepia')).toEqual({ source: 'flowchart LR', theme: 'light' })
    expect(parseMermaidRequest('', 'dark')).toBeNull()
    expect(parseMermaidRequest('x'.repeat(50_001), 'dark')).toBeNull()
    expect(parseMermaidRequest(7, 'dark')).toBeNull()
  })
})
