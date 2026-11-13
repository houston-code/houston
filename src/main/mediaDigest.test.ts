import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { externalizeMedia, hydrateMedia } from './conversationMedia'
import { mediaDigest, rememberMediaDigest } from './mediaDigest'

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

let dir = ''
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('mediaDigest', () => {
  it('is the sha256 of the base64 data, the same for equal bytes in different objects', () => {
    const data = Buffer.from('image bytes').toString('base64')
    expect(mediaDigest({ data })).toBe(sha(data))
    expect(mediaDigest({ data })).toBe(mediaDigest({ data }))
    expect(mediaDigest({ data: data + 'AA' })).not.toBe(mediaDigest({ data }))
  })

  it('uses a remembered digest for that object only', () => {
    const att = { data: 'AAAA' }
    rememberMediaDigest(att, 'f'.repeat(64))
    expect(mediaDigest(att)).toBe('f'.repeat(64))
    expect(mediaDigest({ data: 'AAAA' })).toBe(sha('AAAA'))
  })

  it('takes a loaded attachment digest from its content address instead of hashing again', () => {
    dir = mkdtempSync(join(tmpdir(), 'media-digest-'))
    const media = join(dir, 'c.media')
    const data = Buffer.from('\x89PNG\r\n\x1a\nbytes').toString('base64')
    const { value } = externalizeMedia({ images: [{ mediaType: 'image/png', data }] }, media)
    const loaded = hydrateMedia(value, media)
    expect(loaded.images[0].data).toBe(data)
    expect(mediaDigest(loaded.images[0])).toBe(sha(data))

    // A file is trusted to hold the bytes its name says, as externalizeMedia already
    // does; a deliberately misnamed one shows the name is what gets reused.
    mkdirSync(media, { recursive: true })
    const name = 'a'.repeat(64)
    writeFileSync(join(media, `${name}.png`), Buffer.from('other'))
    const misnamed = hydrateMedia({ images: [{ mediaType: 'image/png', mediaRef: `${name}.png` }] }, media)
    expect(mediaDigest(misnamed.images[0] as unknown as { data: string })).toBe(name)
  })
})
