import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImageAttachment } from '@shared/images'
import { parseVariantList } from '@shared/mockup'
import { getTool, type ToolContext } from './tools'
import {
  captureLocalhost,
  type CaptureEmulation,
  type CaptureInput,
  type CaptureSession,
  type LocalhostCapture
} from './viewlocalhost'
import { MAX_ATTACH_IMAGE_BYTES } from './attachments'

/**
 * view_localhost variants: each variant is its own fresh page load in its own
 * viewport and color scheme, steps run at most once, and the tool attaches one
 * image per variant (or none) so the gallery can label them by position.
 */

const variants = (raw: unknown[]) => parseVariantList(raw, { fullPage: false, allowQuery: false })

function session(label: string, log: string[], over: Partial<CaptureSession> = {}): CaptureSession {
  return {
    load: async (url) => {
      log.push(`${label} load ${url}`)
      return {}
    },
    title: () => `Title ${label}`,
    url: () => 'http://localhost:3000/',
    rectForSelector: async () => null,
    screenshot: async () => Buffer.from(`shot ${label}`),
    screenshotFullPage: async (max) => ({ png: Buffer.from(`full ${label}`), height: Math.min(9000, max), truncated: 9000 > max }),
    consoleEntries: () => [{ level: 'warning', text: 'same warning' }, { level: 'log', text: `only ${label}` }],
    runStep: async (step) => {
      log.push(`${label} step ${step.action}`)
      return { ok: true }
    },
    pageText: async () => `text ${label}`,
    typedSecrets: () => [],
    close: () => log.push(`${label} close`),
    ...over
  }
}

describe('captureLocalhost with variants', () => {
  it('opens one emulated session per variant, in order, and closes each', async () => {
    const log: string[] = []
    const opened: { width: number; height: number; emulate?: CaptureEmulation }[] = []
    let n = 0
    const cap = await captureLocalhost(
      { url: 'http://localhost:3000', variants: variants(['desktop-light', 'mobile-dark']) },
      {
        open: async (opts) => {
          opened.push(opts)
          return session(String(++n), log)
        }
      }
    )
    expect(opened).toEqual([
      { width: 1280, height: 800, emulate: { colorScheme: 'light', mobile: false } },
      { width: 390, height: 844, emulate: { colorScheme: 'dark', mobile: true } }
    ])
    expect(log).toEqual(['1 load http://localhost:3000/', '1 close', '2 load http://localhost:3000/', '2 close'])
    expect(cap.variants?.map((v) => [v.label, v.png.toString(), v.width, v.height])).toEqual([
      ['Desktop, light', 'shot 1', 1280, 800],
      ['Mobile, dark', 'shot 2', 390, 844]
    ])
    // Top-level fields describe the first variant; console is deduplicated across all.
    expect(cap.title).toBe('Title 1')
    expect(cap.pageText).toBe('text 1')
    expect(cap.console).toEqual(['WARNING: same warning', 'LOG: only 1', 'LOG: only 2'])
  })

  it('captures the full page when a variant asks, and reports truncation', async () => {
    const cap = await captureLocalhost(
      { url: 'http://localhost:3000', variants: variants([{ preset: 'desktop', fullPage: true }]) },
      { open: async () => session('1', []) }
    )
    expect(cap.variants?.[0]).toMatchObject({ height: 6000, truncated: true })
    expect(cap.variants?.[0].png.toString()).toBe('full 1')
  })

  it('runs steps for a single variant', async () => {
    const log: string[] = []
    const cap = await captureLocalhost(
      { url: 'http://localhost:3000', variants: variants(['mobile']), steps: [{ action: 'click', selector: '#go' }] },
      { open: async () => session('1', log) }
    )
    expect(log).toContain('1 step click')
    expect(cap.steps).toEqual([{ step: 'click "#go"', ok: true }])
  })

  it('refuses steps with more than one variant, before opening anything', async () => {
    const open = vi.fn()
    await expect(
      captureLocalhost(
        { url: 'http://localhost:3000', variants: variants(['desktop', 'mobile']), steps: [{ action: 'click', selector: '#buy' }] },
        { open }
      )
    ).rejects.toThrow('steps can run with only one variant')
    expect(open).not.toHaveBeenCalled()
  })

  it('stops between variants once cancelled, closing what it opened', async () => {
    const controller = new AbortController()
    const log: string[] = []
    let n = 0
    await expect(
      captureLocalhost(
        { url: 'http://localhost:3000', variants: variants(['desktop', 'tablet', 'mobile']), signal: controller.signal },
        {
          open: async () => {
            const label = String(++n)
            return session(label, log, {
              screenshot: async () => {
                controller.abort()
                return Buffer.from('x')
              }
            })
          }
        }
      )
    ).rejects.toThrow('cancelled')
    expect(n).toBe(1)
    expect(log).toContain('1 close')
  })
})

describe('view_localhost tool with variants', () => {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'houston-vl-variants-')))
  const fake =
    (pngFor: (i: number) => Buffer = (i) => Buffer.from(`png ${i}`)) =>
    async (input: CaptureInput): Promise<LocalhostCapture> => {
      const vs = input.variants ?? []
      return {
        png: pngFor(0),
        console: [],
        title: 'Demo',
        finalUrl: `${input.url}/`,
        width: vs[0]?.width ?? 1280,
        height: vs[0]?.height ?? 800,
        variants: vs.map((v, i) => ({ label: v.label, png: pngFor(i), width: v.width, height: v.height }))
      }
    }
  const ctx = (images: ImageAttachment[], capture = fake()): ToolContext => ({
    workspace: ws,
    allowNetwork: true,
    attachImage: (i) => images.push(i),
    captureLocalhost: capture
  })

  it('attaches one screenshot per variant, in order, and lists them', async () => {
    const images: ImageAttachment[] = []
    const out = await getTool('view_localhost')!.execute(
      { url: 'http://localhost:3000', variants: ['desktop-light', { preset: 'mobile', colorScheme: 'dark' }] },
      ctx(images)
    )
    expect(images.map((i) => Buffer.from(i.data, 'base64').toString())).toEqual(['png 0', 'png 1'])
    expect(out).toContain('Captured 2 variants:')
    expect(out).toContain('1. Desktop, light (1280×800')
    expect(out).toContain('2. Mobile, dark (390×844')
  })

  it('attaches nothing when any variant is over the attach limit', async () => {
    const images: ImageAttachment[] = []
    const big = Buffer.alloc(MAX_ATTACH_IMAGE_BYTES + 1)
    const out = await getTool('view_localhost')!.execute(
      { url: 'http://localhost:3000', variants: ['desktop', 'mobile'] },
      ctx(images, fake((i) => (i === 1 ? big : Buffer.from('ok'))))
    )
    expect(images).toHaveLength(0)
    expect(out).toContain('Mobile, light is 5.0 MB, over the 5.0 MB attach limit')
  })

  it('rejects steps with several variants and a per-variant query', async () => {
    const images: ImageAttachment[] = []
    await expect(
      getTool('view_localhost')!.execute(
        { url: 'http://localhost:3000', variants: ['desktop', 'mobile'], steps: [{ action: 'click', selector: 'a' }] },
        ctx(images)
      )
    ).rejects.toThrow('steps can run with only one variant')
    await expect(
      getTool('view_localhost')!.execute({ url: 'http://localhost:3000', variants: [{ query: '?x' }] }, ctx(images))
    ).rejects.toThrow('put it in the URL')
  })

  it('names the variant count in the approval summary', () => {
    const tool = getTool('view_localhost')!
    expect(tool.summarize({ url: 'http://localhost:3000', variants: ['desktop', 'mobile-dark'] })).toBe(
      'View http://localhost:3000 in 2 variants'
    )
    expect(tool.summarize({ url: 'http://localhost:3000' })).toBe('View http://localhost:3000')
  })
})
