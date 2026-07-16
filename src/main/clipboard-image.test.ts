import { describe, it, expect } from 'vitest'
import { clipboardImageProbe, noClipboardHint, isPng, readClipboardImage } from './clipboard-image'

const FILE = '/tmp/x.png'

describe('clipboardImageProbe', () => {
  it('uses AppleScript on macOS, writing to a file (it cannot pipe binary)', () => {
    const p = clipboardImageProbe('darwin', FILE, {})
    expect(p?.cmd).toBe('osascript')
    expect(p?.stdout).toBe(false)
    expect(p?.args.join(' ')).toContain('PNGf') // the clipboard's PNG flavor
    expect(p?.args.join(' ')).toContain(FILE)
  })

  // A Wayland session usually HAS xclip, but it cannot see the real clipboard —
  // so picking by presence alone would silently read the wrong (empty) one.
  it('prefers wl-paste on Wayland over xclip', () => {
    expect(clipboardImageProbe('linux', FILE, { WAYLAND_DISPLAY: 'wayland-0' })?.cmd).toBe('wl-paste')
    expect(clipboardImageProbe('linux', FILE, {})?.cmd).toBe('xclip')
  })

  it('reads binary from stdout on Linux', () => {
    expect(clipboardImageProbe('linux', FILE, {})?.stdout).toBe(true)
  })

  it('uses PowerShell on Windows, in a single-threaded apartment', () => {
    const p = clipboardImageProbe('win32', FILE, {})
    expect(p?.cmd).toBe('powershell')
    // Without -sta the clipboard API silently returns nothing.
    expect(p?.args).toContain('-sta')
    expect(p?.stdout).toBe(false)
  })

  it('returns null for a platform we have no way into', () => {
    expect(clipboardImageProbe('freebsd' as NodeJS.Platform, FILE, {})).toBeNull()
  })
})

describe('noClipboardHint', () => {
  it('names the tool to install on Linux, per session type', () => {
    expect(noClipboardHint('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toContain('wl-clipboard')
    expect(noClipboardHint('linux', {})).toContain('xclip')
  })

  it('points at the file form elsewhere', () => {
    expect(noClipboardHint('darwin', {})).toContain('/image <path>')
  })
})

describe('isPng', () => {
  // A helper that "succeeded" with a text payload would otherwise be base64'd and
  // sent as an image, failing deep in the provider with a confusing error.
  it('accepts the PNG magic number and rejects anything else', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
    expect(isPng(png)).toBe(true)
    expect(isPng(Buffer.from('hello world, this is text'))).toBe(false)
    expect(isPng(Buffer.alloc(0))).toBe(false)
    expect(isPng(Buffer.from([0x89, 0x50]))).toBe(false) // truncated magic
  })
})

describe('readClipboardImage', () => {
  it('reports no image rather than throwing on a platform with no way in', () => {
    expect(readClipboardImage('freebsd' as NodeJS.Platform)).toBeNull()
  })

  // The helper is missing / the clipboard holds text / it is a headless box: all
  // of these are "no image to paste", not failures.
  it('reports no image when the helper cannot run', () => {
    expect(readClipboardImage('linux')).toBeNull()
  })
})
