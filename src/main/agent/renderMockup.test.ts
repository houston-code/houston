import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImageAttachment } from '@shared/images'
import { builtinToolset, getTool, type BuiltinToolsetOptions, type ToolContext } from './tools'
import { MAX_ATTACH_IMAGE_BYTES } from './attachments'
import type { MockupRender, MockupRenderInput } from './mockupRender'

/**
 * render_mockup with a fake renderer: argument checks, root confinement, what it
 * hands the renderer, and how renders become attachments and the model's summary.
 * The real offscreen browser and its isolation are covered in mockupCapture.test.ts.
 */

let workspace: string
let outside: string
let images: ImageAttachment[]
let calls: MockupRenderInput[]
let ctx: ToolContext

const png = (n: number): Buffer => Buffer.from(`\x89PNG\r\n\x1a\nrender-${n}`)

function fakeRenderer(over: Partial<MockupRender> = {}): (input: MockupRenderInput) => Promise<MockupRender[]> {
  return async (input) => {
    calls.push(input)
    return input.variants.map((v, i) => ({ png: png(i), width: v.width, height: v.height, console: [], ...over }))
  }
}

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'houston-mockup-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'houston-mockup-outside-')))
  images = []
  calls = []
  ctx = { workspace, allowNetwork: false, attachImage: (img) => images.push(img), renderMockup: fakeRenderer() }
  mkdirSync(join(workspace, 'mockups'))
  writeFileSync(join(workspace, 'mockups', 'settings.html'), '<!doctype html><title>Settings</title>')
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const render = (args: Record<string, unknown>, over: Partial<ToolContext> = {}): Promise<string> =>
  getTool('render_mockup')!.execute(args, { ...ctx, ...over })

describe('render_mockup', () => {
  it('renders each variant and attaches the screenshots in order', async () => {
    const out = await render({ file: 'mockups/settings.html', variants: ['desktop-light', 'mobile-dark'] })
    expect(calls).toHaveLength(1)
    expect(calls[0].root).toBe(workspace)
    expect(calls[0].file).toBe(join(workspace, 'mockups', 'settings.html'))
    expect(calls[0].variants.map((v) => v.label)).toEqual(['Desktop, light', 'Mobile, dark'])
    expect(images.map((i) => Buffer.from(i.data, 'base64').toString())).toEqual([png(0).toString(), png(1).toString()])
    expect(images.every((i) => i.mediaType === 'image/png')).toBe(true)
    expect(out).toContain('Rendered mockups/settings.html in 2 variants:')
    expect(out).toContain('1. Desktop, light (1280×800')
    expect(out).toContain('2. Mobile, dark (390×844')
    expect(out).toContain('Console output: (none)')
  })

  it('passes the run’s abort signal to the renderer', async () => {
    const controller = new AbortController()
    await render({ file: 'mockups/settings.html' }, { signal: controller.signal })
    expect(calls[0].signal).toBe(controller.signal)
  })

  it('reports load warnings, truncation, and console output once', async () => {
    const out = await render(
      { file: 'mockups/settings.html', variants: ['desktop', 'mobile'] },
      {
        renderMockup: fakeRenderer({
          loadError: 'Page did not finish loading within 15000ms',
          truncated: true,
          console: ['ERROR: x is not defined']
        })
      }
    )
    expect(out).toContain('[load warning: Page did not finish loading within 15000ms]')
    expect(out).toContain('cut at 6000px')
    expect(out.match(/x is not defined/g)).toHaveLength(1)
  })

  it('finds the root that holds the file when there are several', async () => {
    writeFileSync(join(outside, 'other.html'), '<p>other</p>')
    await render({ file: join(outside, 'other.html') }, { roots: [workspace, outside] })
    expect(calls[0].root).toBe(outside)
  })

  it('refuses a file outside the roots, including through a symlink', async () => {
    writeFileSync(join(outside, 'x.html'), '<p>x</p>')
    await expect(render({ file: join(outside, 'x.html') })).rejects.toThrow('escapes the allowed roots')
    if (process.platform !== 'win32') {
      symlinkSync(join(outside, 'x.html'), join(workspace, 'link.html'))
      await expect(render({ file: 'link.html' })).rejects.toThrow('via a symlink')
    }
    expect(calls).toHaveLength(0)
  })

  it('refuses a missing file and a non-HTML file before rendering', async () => {
    await expect(render({ file: 'nope.html' })).rejects.toThrow('No such file: nope.html')
    await expect(render({ file: 'notes.md' })).rejects.toThrow('.html or .htm')
    expect(calls).toHaveLength(0)
  })

  it('attaches nothing when a screenshot is over the limit', async () => {
    const big = Buffer.alloc(MAX_ATTACH_IMAGE_BYTES + 1)
    await expect(
      render({ file: 'mockups/settings.html', variants: ['desktop', 'mobile'] }, { renderMockup: fakeRenderer({ png: big }) })
    ).rejects.toThrow('Desktop, light: the screenshot is 5.0 MB, over the 5.0 MB limit')
    expect(images).toHaveLength(0)
  })

  it('attaches nothing when the renderer returns the wrong number of images', async () => {
    const short = vi.fn(async () => [{ png: png(0), width: 1, height: 1, console: [] }])
    await expect(
      render({ file: 'mockups/settings.html', variants: ['desktop', 'mobile'] }, { renderMockup: short })
    ).rejects.toThrow('wrong number of images')
    expect(images).toHaveLength(0)
  })

  it('fails cleanly where nothing can render or show images', async () => {
    await expect(render({ file: 'mockups/settings.html' }, { renderMockup: undefined })).rejects.toThrow(
      'Mockups cannot be rendered in this context'
    )
    await expect(render({ file: 'mockups/settings.html' }, { attachImage: undefined })).rejects.toThrow(
      'Images cannot be shown in this context'
    )
  })

  it('summarizes the call for the approval UI', () => {
    const tool = getTool('render_mockup')!
    expect(tool.kind).toBe('read')
    expect(tool.summarize({ file: 'm.html', variants: ['desktop', 'mobile'] })).toBe('m.html (2 variants)')
    expect(tool.summarize({ file: 'm.png' })).toBe('Render mockup')
  })
})

describe('render_mockup in the toolset', () => {
  const base: BuiltinToolsetOptions = {
    localhostCapture: true,
    imageGallery: true,
    mockupRender: true,
    spawn: true,
    scheduler: true,
    planMode: false
  }
  const names = (o: Partial<BuiltinToolsetOptions>): string[] =>
    builtinToolset({ ...base, ...o }).map((t) => t.schema.name)

  it('needs both a wired renderer and a client that draws galleries', () => {
    expect(names({})).toContain('render_mockup')
    expect(names({ mockupRender: false })).not.toContain('render_mockup')
    expect(names({ mockupRender: undefined })).not.toContain('render_mockup')
    expect(names({ imageGallery: false })).not.toContain('render_mockup')
  })

  it('stays available in plan mode, since it writes nothing', () => {
    expect(names({ planMode: true })).toContain('render_mockup')
  })
})
