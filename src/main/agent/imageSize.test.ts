import { describe, expect, it } from 'vitest'
import { imageSize } from './imageSize'

const b64 = (bytes: number[] | Buffer): string => Buffer.from(bytes).toString('base64')

function png(width: number, height: number): string {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b64(b)
}

function gif(width: number, height: number): string {
  const b = Buffer.alloc(13)
  b.write('GIF89a', 0, 'latin1')
  b.writeUInt16LE(width, 6)
  b.writeUInt16LE(height, 8)
  return b64(b)
}

function riff(chunk: string, body: Buffer): string {
  const head = Buffer.alloc(20)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(12 + body.length, 4)
  head.write('WEBP', 8, 'latin1')
  head.write(chunk, 12, 'latin1')
  head.writeUInt32LE(body.length, 16)
  return b64(Buffer.concat([head, body]))
}

function webpLossy(width: number, height: number): string {
  const body = Buffer.alloc(12)
  body[3] = 0x9d
  body[4] = 0x01
  body[5] = 0x2a
  body.writeUInt16LE(width, 6)
  body.writeUInt16LE(height, 8)
  return riff('VP8 ', body)
}

function webpLossless(width: number, height: number): string {
  const body = Buffer.alloc(12)
  body[0] = 0x2f
  body.writeUInt32LE((width - 1) | ((height - 1) << 14), 1)
  return riff('VP8L', body)
}

function webpExtended(width: number, height: number): string {
  const body = Buffer.alloc(12)
  body.writeUIntLE(width - 1, 4, 3)
  body.writeUIntLE(height - 1, 7, 3)
  return riff('VP8X', body)
}

function jpeg(width: number, height: number, appBytes = 16): string {
  const app = Buffer.alloc(4 + appBytes)
  app[0] = 0xff
  app[1] = 0xe1 // APP1 (EXIF)
  app.writeUInt16BE(2 + appBytes, 2)
  const sof = Buffer.alloc(19)
  sof[0] = 0xff
  sof[1] = 0xc2 // progressive frame
  sof.writeUInt16BE(17, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return b64(Buffer.concat([Buffer.from([0xff, 0xd8]), app, Buffer.from([0xff, 0xff]), sof]))
}

describe('imageSize', () => {
  it('reads PNG, GIF, and every WebP flavor from the header', () => {
    expect(imageSize(png(3024, 1964))).toEqual({ width: 3024, height: 1964 })
    expect(imageSize(gif(640, 480))).toEqual({ width: 640, height: 480 })
    expect(imageSize(webpLossy(1600, 900))).toEqual({ width: 1600, height: 900 })
    expect(imageSize(webpLossless(4000, 3000))).toEqual({ width: 4000, height: 3000 })
    expect(imageSize(webpExtended(9000, 12000))).toEqual({ width: 9000, height: 12000 })
  })

  it('finds a JPEG frame header past metadata segments and fill bytes', () => {
    expect(imageSize(jpeg(4032, 3024))).toEqual({ width: 4032, height: 3024 })
    expect(imageSize(jpeg(800, 600, 60000))).toEqual({ width: 800, height: 600 })
  })

  it('sniffs the format from the bytes, not the declared type', () => {
    // Callers pass only the data; a PNG labelled as JPEG is still read as PNG.
    expect(imageSize(png(10, 20))).toEqual({ width: 10, height: 20 })
  })

  it('returns null for anything it cannot read with confidence', () => {
    expect(imageSize('')).toBeNull()
    expect(imageSize('not base64 image data')).toBeNull()
    expect(imageSize(png(0, 10))).toBeNull()
    expect(imageSize(png(10, 10).slice(0, 20))).toBeNull()
    // A JPEG whose scan starts before any frame header, and one cut off mid-segment.
    expect(imageSize(b64([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6]))).toBeNull()
    expect(imageSize(b64([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBeNull()
    expect(imageSize(riff('VP8 ', Buffer.alloc(12)))).toBeNull()
  })
})
