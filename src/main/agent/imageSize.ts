/**
 * Pixel size of a base64 PNG, JPEG, GIF, or WebP image, read from its header alone
 * so a caller can tell whether an image needs scaling without decoding it. The
 * format is sniffed from the bytes, not taken from a declared media type. Returns
 * null for anything it can't read with confidence (unknown format, truncated or
 * malformed header, a zero dimension); callers then fall back to a full decode.
 */
export interface ImageSize {
  width: number
  height: number
}

/** Base64 characters decoded for the formats whose size sits in the first few bytes. */
const SHORT_PREFIX_CHARS = 64
/**
 * Base64 characters decoded when scanning a JPEG for its frame header, which comes
 * after any metadata segments (EXIF, ICC profiles, thumbnails). 512 KiB of base64 is
 * 384 KiB of image, past the metadata of ordinary photos and screenshots.
 */
const JPEG_PREFIX_CHARS = 512 * 1024

function decodePrefix(data: string, chars: number): Buffer {
  // A multiple of 4 so the prefix ends on a whole base64 group.
  return Buffer.from(data.slice(0, chars - (chars % 4)), 'base64')
}

function sized(width: number, height: number): ImageSize | null {
  return width > 0 && height > 0 ? { width, height } : null
}

function pngSize(b: Buffer): ImageSize | null {
  // 8-byte signature, then the IHDR chunk: length (4), type (4), width (4), height (4).
  if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') return null
  return sized(b.readUInt32BE(16), b.readUInt32BE(20))
}

function gifSize(b: Buffer): ImageSize | null {
  // "GIF87a" or "GIF89a", then the logical screen width and height (little-endian).
  if (b.length < 10) return null
  return sized(b.readUInt16LE(6), b.readUInt16LE(8))
}

function webpSize(b: Buffer): ImageSize | null {
  if (b.length < 30) return null
  const chunk = b.toString('latin1', 12, 16)
  if (chunk === 'VP8 ') {
    // Lossy: a frame tag (3 bytes) and start code 9d 01 2a, then 14-bit dimensions.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    return sized(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff)
  }
  if (chunk === 'VP8L') {
    // Lossless: signature 0x2f, then width-1 and height-1 as packed 14-bit fields.
    if (b[20] !== 0x2f) return null
    const bits = b.readUInt32LE(21)
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  if (chunk === 'VP8X') {
    // Extended: canvas width-1 and height-1 as 24-bit little-endian fields.
    return sized(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1)
  }
  return null
}

function jpegSize(b: Buffer): ImageSize | null {
  let i = 2
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return null
    // Any number of 0xff fill bytes may precede a marker.
    while (i < b.length && b[i] === 0xff) i++
    if (i >= b.length) return null
    const marker = b[i]
    i++
    // Markers that stand alone, with no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    // End of image, or start of scan before any frame header: no size to read.
    if (marker === 0xd9 || marker === 0xda) return null
    if (i + 2 > b.length) return null
    const length = b.readUInt16BE(i)
    if (length < 2) return null
    // Start-of-frame markers (every C0-CF except DHT C4, JPG C8, and DAC CC):
    // length (2), precision (1), height (2), width (2).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 7 > b.length) return null
      return sized(b.readUInt16BE(i + 5), b.readUInt16BE(i + 3))
    }
    i += length
  }
  return null
}

export function imageSize(data: string): ImageSize | null {
  try {
    const head = decodePrefix(data, SHORT_PREFIX_CHARS)
    if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a) {
      return pngSize(head)
    }
    const sig = head.toString('latin1', 0, 6)
    if (sig === 'GIF87a' || sig === 'GIF89a') return gifSize(head)
    if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') {
      return webpSize(head)
    }
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
      return jpegSize(decodePrefix(data, JPEG_PREFIX_CHARS))
    }
    return null
  } catch {
    return null
  }
}
