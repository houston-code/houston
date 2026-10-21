import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImageAttachment } from '@shared/images'
import { builtinToolset, getTool, type BuiltinToolsetOptions, type ToolContext } from './tools'
import { MAX_ATTACH_IMAGE_BYTES } from './attachments'
import { FileReadTracker } from './readCache'

/**
 * show_images: presents image files as a gallery. Every path is confined to the
 * roots, every file must sniff as an image, and the call is all-or-nothing so the
 * attached images line up with the labels the renderer draws them under.
 */

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])

let workspace: string
let outside: string
let images: ImageAttachment[]
let ctx: ToolContext

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'houston-show-images-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'houston-show-outside-')))
  images = []
  ctx = { workspace, allowNetwork: false, attachImage: (img) => images.push(img) }
  mkdirSync(join(workspace, 'shots'))
  writeFileSync(join(workspace, 'shots', 'light.png'), PNG)
  writeFileSync(join(workspace, 'shots', 'dark.jpg'), JPEG)
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const show = (args: Record<string, unknown>, over: Partial<ToolContext> = {}): Promise<string> =>
  getTool('show_images')!.execute(args, { ...ctx, ...over })

describe('show_images', () => {
  it('attaches each image in order and lists them for the model', async () => {
    const out = await show({
      title: 'Settings page',
      images: [
        { path: 'shots/light.png', label: 'Light' },
        { path: 'shots/dark.jpg', label: 'Dark', caption: 'Dark theme' }
      ]
    })
    expect(images.map((i) => i.mediaType)).toEqual(['image/png', 'image/jpeg'])
    expect(images[0].data).toBe(PNG.toString('base64'))
    expect(out).toContain('gallery titled "Settings page" of 2 images')
    expect(out).toContain('1. Light: shots/light.png (image/png')
    expect(out).toContain('2. Dark: shots/dark.jpg (image/jpeg')
  })

  it('attaches compare images after the entries, in entry order', async () => {
    writeFileSync(join(workspace, 'shots', 'old.png'), PNG)
    const out = await show({
      images: [
        { path: 'shots/dark.jpg', label: 'Dark', compareWith: 'shots/old.png' },
        { path: 'shots/light.png', label: 'Light' }
      ]
    })
    expect(images.map((i) => i.mediaType)).toEqual(['image/jpeg', 'image/png', 'image/png'])
    expect(out).toContain('of 2 images (plus 1 to compare against, attached after them)')
    expect(out).toContain('1. Dark: shots/dark.jpg (image/jpeg, 10 B), compared with shots/old.png')
  })

  it('refuses a compare file that is not an image, attaching nothing', async () => {
    writeFileSync(join(workspace, 'notes.png'), 'not an image')
    await expect(
      show({ images: [{ path: 'shots/light.png', compareWith: 'notes.png' }] })
    ).rejects.toThrow('compareWith (notes.png): not a PNG, JPEG, GIF, or WebP image.')
    expect(images).toHaveLength(0)
  })

  it('types a file by its bytes, not its extension', async () => {
    writeFileSync(join(workspace, 'shots', 'misnamed.gif'), PNG)
    await show({ images: [{ path: 'shots/misnamed.gif' }] })
    expect(images[0].mediaType).toBe('image/png')
  })

  it('refuses a file that is not an image, and attaches nothing from the call', async () => {
    writeFileSync(join(workspace, 'secret.png'), 'API_KEY=sk-live-123')
    await expect(
      show({ images: [{ path: 'shots/light.png' }, { path: 'secret.png' }] })
    ).rejects.toThrow('images[1] (secret.png): not a PNG, JPEG, GIF, or WebP image.')
    expect(images).toHaveLength(0)
  })

  it('never puts the file contents in its error', async () => {
    writeFileSync(join(workspace, 'notes.png'), 'password=hunter2')
    const err = await show({ images: [{ path: 'notes.png' }] }).catch((e: Error) => e.message)
    expect(err).not.toContain('hunter2')
  })

  it('refuses paths outside the roots, including through a symlink', async () => {
    writeFileSync(join(outside, 'x.png'), PNG)
    await expect(show({ images: [{ path: join(outside, 'x.png') }] })).rejects.toThrow('escapes the allowed roots')
    await expect(show({ images: [{ path: '../x.png' }] })).rejects.toThrow('escapes the allowed roots')
    if (process.platform !== 'win32') {
      symlinkSync(join(outside, 'x.png'), join(workspace, 'link.png'))
      await expect(show({ images: [{ path: 'link.png' }] })).rejects.toThrow('via a symlink')
    }
    expect(images).toHaveLength(0)
  })

  it('reads from an added root', async () => {
    writeFileSync(join(outside, 'x.png'), PNG)
    await show({ images: [{ path: join(outside, 'x.png') }] }, { roots: [workspace, outside] })
    expect(images).toHaveLength(1)
  })

  it('reports a missing file and a directory as no such file', async () => {
    await expect(show({ images: [{ path: 'nope.png' }] })).rejects.toThrow('images[0] (nope.png): no such file.')
    await expect(show({ images: [{ path: 'shots' }] })).rejects.toThrow('images[0] (shots): no such file.')
  })

  it('refuses an image over the attachment limit before reading it', async () => {
    const big = Buffer.alloc(MAX_ATTACH_IMAGE_BYTES + 1)
    PNG.copy(big)
    writeFileSync(join(workspace, 'big.png'), big)
    await expect(show({ images: [{ path: 'big.png' }] })).rejects.toThrow('over the 5.0 MB limit')
  })

  it('fails when the context cannot show images', async () => {
    await expect(show({ images: [{ path: 'shots/light.png' }] }, { attachImage: undefined })).rejects.toThrow(
      'cannot be shown in this context'
    )
  })

  it('rejects malformed arguments with the shared parser message', async () => {
    await expect(show({ images: [] })).rejects.toThrow('images must be a non-empty array')
  })

  it('counts the files as read for the stale-write guard', async () => {
    const tracker = new FileReadTracker()
    await show({ images: [{ path: 'shots/light.png' }] }, { fileTracker: tracker })
    expect(tracker.has(join(workspace, 'shots', 'light.png'))).toBe(true)
  })

  it('summarizes the call for the approval UI', () => {
    const tool = getTool('show_images')!
    expect(tool.kind).toBe('read')
    expect(tool.summarize({ title: 'UI', images: [{ path: 'a.png' }, { path: 'b.png' }] })).toBe('UI (2 images)')
    expect(tool.summarize({ images: [{ path: 'a.png' }] })).toBe('1 image')
    expect(tool.summarize({ images: 'bad' })).toBe('Show images')
  })
})

describe('show_images in the toolset', () => {
  const base: BuiltinToolsetOptions = {
    localhostCapture: true,
    imageGallery: true,
    spawn: true,
    scheduler: true,
    planMode: false
  }
  const names = (o: Partial<BuiltinToolsetOptions>): string[] =>
    builtinToolset({ ...base, ...o }).map((t) => t.schema.name)

  it('is offered only where a client draws the gallery or lists links', () => {
    expect(names({})).toContain('show_images')
    expect(names({ imageGallery: false })).not.toContain('show_images')
    expect(names({ imageGallery: false, imageLinks: true })).toContain('show_images')
    // A terminal can't show a render that was never a file.
    expect(names({ imageGallery: false, imageLinks: true })).not.toContain('render_mockup')
  })

  it('stays available in plan mode, since it only reads', () => {
    expect(names({ planMode: true })).toContain('show_images')
  })
})
