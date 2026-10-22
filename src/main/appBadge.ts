import { deflateSync } from 'node:zlib'
import type { ChatStatusMap } from '@shared/chatStatus'

/**
 * The app-icon badge: how many chats want the user (waiting on input, failed, or
 * with a reply they haven't seen), shown on the macOS Dock icon and the Linux
 * launcher as a count, and as a dot overlay on the Windows taskbar button (Windows
 * has no badge count API). Pure parts are exported for tests; {@link applyAppBadge}
 * does the platform call.
 */

/** Chats that want the user: blocked on a prompt, or with something unseen. */
export function attentionCount(status: ChatStatusMap): number {
  let n = 0
  for (const s of Object.values(status)) if (s.pending.length > 0 || s.unread !== undefined) n++
  return n
}

/** What the Windows overlay's accessible description says for a count. */
export function badgeDescription(count: number): string {
  return count === 1 ? '1 chat needs you' : `${count} chats need you`
}

// ---- A 16×16 red dot as a PNG, built once (nativeImage reads PNG, not SVG) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** A `size`×`size` PNG of a filled circle in `rgb`, anti-aliased at the edge. */
export function dotPng(size = 16, rgb: [number, number, number] = [0xe5, 0x48, 0x4d]): Buffer {
  const rows: Buffer[] = []
  const r = size / 2
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4) // filter byte 0, then RGBA pixels
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - r, y + 0.5 - r)
      const alpha = Math.max(0, Math.min(1, r - d))
      row.set([rgb[0], rgb[1], rgb[2], Math.round(alpha * 255)], 1 + x * 4)
    }
    rows.push(row)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** The slice of Electron the badge needs, injected so this file stays testable. */
export interface BadgeHost<Icon> {
  platform: NodeJS.Platform
  setBadgeCount: (count: number) => void
  windows: () => { setOverlayIcon: (icon: Icon | null, description: string) => void; isDestroyed: () => boolean }[]
  overlayIcon: () => Icon
}

/** Show `count` on the app icon, or clear it when `enabled` is false or nothing waits. */
export function applyAppBadge<Icon>(host: BadgeHost<Icon>, count: number, enabled: boolean): void {
  const n = enabled ? count : 0
  if (host.platform === 'win32') {
    const icon = n > 0 ? host.overlayIcon() : null
    for (const w of host.windows()) if (!w.isDestroyed()) w.setOverlayIcon(icon, n > 0 ? badgeDescription(n) : '')
    return
  }
  host.setBadgeCount(n)
}
