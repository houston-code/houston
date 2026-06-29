import { describe, expect, it } from 'vitest'
import {
  isLoopbackUrl,
  normalizeManualUrl,
  selectPreviewPanes,
  type PreviewPaneItem
} from './preview'
import type { PreviewServer } from '@shared/preview'

const server = (over: Partial<PreviewServer> & { id: string }): PreviewServer => ({
  command: 'npm run dev',
  running: true,
  ...over
})

describe('isLoopbackUrl', () => {
  it('accepts loopback http(s) URLs', () => {
    expect(isLoopbackUrl('http://localhost:5173')).toBe(true)
    expect(isLoopbackUrl('http://127.0.0.1:3000/')).toBe(true)
    expect(isLoopbackUrl('https://app.localhost:8443')).toBe(true)
    expect(isLoopbackUrl('http://[::1]:9000')).toBe(true)
  })

  it('rejects non-loopback hosts and bad schemes', () => {
    expect(isLoopbackUrl('http://192.168.1.4:3000')).toBe(false)
    expect(isLoopbackUrl('https://example.com')).toBe(false)
    expect(isLoopbackUrl('file:///etc/passwd')).toBe(false)
    expect(isLoopbackUrl('not a url')).toBe(false)
  })
})

describe('normalizeManualUrl', () => {
  it('expands a bare port', () => {
    expect(normalizeManualUrl('3000')).toBe('http://localhost:3000/')
  })
  it('adds a missing scheme', () => {
    expect(normalizeManualUrl('localhost:8080')).toBe('http://localhost:8080/')
  })
  it('keeps a full loopback URL and rejects non-loopback / empty', () => {
    expect(normalizeManualUrl('http://127.0.0.1:4000/app')).toBe('http://127.0.0.1:4000/app')
    expect(normalizeManualUrl('example.com')).toBeNull()
    expect(normalizeManualUrl('   ')).toBeNull()
  })
})

describe('selectPreviewPanes', () => {
  it('includes only running servers that have a URL', () => {
    const { panes, startingCount } = selectPreviewPanes(
      [
        server({ id: 'a', url: 'http://localhost:3000/' }),
        server({ id: 'b' }), // running, no URL yet
        server({ id: 'c', running: false, url: 'http://localhost:4000/' }) // exited
      ],
      []
    )
    expect(panes.map((p) => p.id)).toEqual(['server:a'])
    expect(startingCount).toBe(1)
  })

  it('appends manual URLs after servers and dedupes by URL', () => {
    const { panes } = selectPreviewPanes(
      [server({ id: 'a', url: 'http://localhost:3000/' })],
      ['http://localhost:3000/', 'http://localhost:9999/']
    )
    expect(panes.map((p: PreviewPaneItem) => p.url)).toEqual([
      'http://localhost:3000/',
      'http://localhost:9999/'
    ])
    expect(panes.map((p) => p.kind)).toEqual(['server', 'manual'])
  })

  it('caps the panes and reports how many were hidden', () => {
    const servers = ['a', 'b', 'c', 'd'].map((id) =>
      server({ id, url: `http://localhost:300${id.charCodeAt(0)}/` })
    )
    const { panes, hiddenCount } = selectPreviewPanes(servers, ['http://localhost:7000/'])
    expect(panes).toHaveLength(3)
    expect(hiddenCount).toBe(2) // 4 servers + 1 manual = 5 previewable, 3 shown
  })
})
