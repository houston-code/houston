import { describe, expect, it, vi } from 'vitest'
import { crc32, inflateSync } from 'node:zlib'
import { applyAppBadge, attentionCount, badgeDescription, dotPng } from './appBadge'

describe('attentionCount', () => {
  it('counts chats waiting on input or with something unseen, not ones only working', () => {
    expect(
      attentionCount({
        a: { running: true, pending: [{ kind: 'question' }] },
        b: { running: true, pending: [] },
        c: { running: false, pending: [], unread: { since: 1, outcome: 'done' } },
        d: { running: false, pending: [], unread: { since: 1, outcome: 'error' } },
        e: { running: true, pending: [{ kind: 'approval' }], unread: { since: 1, outcome: 'done' } }
      })
    ).toBe(4)
    expect(attentionCount({})).toBe(0)
  })
})

describe('applyAppBadge', () => {
  const host = (platform: NodeJS.Platform) => {
    const win = { setOverlayIcon: vi.fn(), isDestroyed: () => false }
    const gone = { setOverlayIcon: vi.fn(), isDestroyed: () => true }
    return {
      win,
      gone,
      h: {
        platform,
        setBadgeCount: vi.fn(),
        windows: () => [win, gone],
        overlayIcon: () => 'ICON'
      }
    }
  }

  it('sets the count on macOS and Linux, and clears it when disabled', () => {
    const { h } = host('darwin')
    applyAppBadge(h, 3, true)
    expect(h.setBadgeCount).toHaveBeenLastCalledWith(3)
    applyAppBadge(h, 3, false)
    expect(h.setBadgeCount).toHaveBeenLastCalledWith(0)
    const linux = host('linux').h
    applyAppBadge(linux, 1, true)
    expect(linux.setBadgeCount).toHaveBeenLastCalledWith(1)
  })

  it('puts a dot overlay on live Windows windows, and removes it at zero', () => {
    const { h, win, gone } = host('win32')
    applyAppBadge(h, 2, true)
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith('ICON', '2 chats need you')
    expect(gone.setOverlayIcon).not.toHaveBeenCalled()
    applyAppBadge(h, 0, true)
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith(null, '')
    expect(h.setBadgeCount).not.toHaveBeenCalled()
  })

  it('describes the count in words', () => {
    expect(badgeDescription(1)).toBe('1 chat needs you')
    expect(badgeDescription(5)).toBe('5 chats need you')
  })
})

describe('dotPng', () => {
  it('is a valid RGBA PNG with an opaque center and transparent corners', () => {
    const png = dotPng(16)
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(png.readUInt32BE(16)).toBe(16) // IHDR width
    expect(png.readUInt32BE(20)).toBe(16) // IHDR height
    const idatAt = png.indexOf('IDAT')
    const len = png.readUInt32BE(idatAt - 4)
    const raw = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + len))
    const alpha = (x: number, y: number): number => raw[y * (1 + 16 * 4) + 1 + x * 4 + 3]
    expect(alpha(8, 8)).toBe(255)
    expect(alpha(0, 0)).toBe(0)
    // Each chunk's CRC covers its type and data (a bad one makes decoders reject it).
    const ihdrCrc = png.readUInt32BE(8 + 4 + 4 + 13)
    expect(ihdrCrc).toBe(crc32(png.subarray(12, 12 + 4 + 13)))
  })
})
