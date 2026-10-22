import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeKind, scrubPePdbPaths, scrubNativePaths } from './scrub-native-paths.mjs'

/**
 * A minimal PE32+ image: DOS header, PE signature, COFF header, optional header with
 * the debug data directory, one section, and a CodeView (RSDS) record naming `pdb`.
 */
function fakePe(pdb, { magic = 0x20b } = {}) {
  const buf = Buffer.alloc(0x400)
  buf.write('MZ', 0, 'latin1')
  const pe = 0x80
  buf.writeUInt32LE(pe, 0x3c)
  buf.write('PE\0\0', pe, 'latin1')
  buf.writeUInt16LE(1, pe + 6) // one section
  const optSize = magic === 0x20b ? 240 : 224
  buf.writeUInt16LE(optSize, pe + 20)
  const opt = pe + 24
  buf.writeUInt16LE(magic, opt)
  const dirs = opt + (magic === 0x20b ? 112 : 96)
  // The section maps RVA 0x1000.. onto file offset 0x200.
  const section = opt + optSize
  buf.writeUInt32LE(0x200, section + 8) // virtual size
  buf.writeUInt32LE(0x1000, section + 12) // virtual address
  buf.writeUInt32LE(0x200, section + 16) // raw size
  buf.writeUInt32LE(0x200, section + 20) // raw pointer
  // Debug directory: one 28-byte CODEVIEW entry at RVA 0x1000 (file 0x200).
  buf.writeUInt32LE(0x1000, dirs + 6 * 8)
  buf.writeUInt32LE(28, dirs + 6 * 8 + 4)
  const entry = 0x200
  const record = 0x240
  const data = Buffer.concat([Buffer.from('RSDS', 'latin1'), Buffer.alloc(20, 7), Buffer.from(pdb + '\0', 'utf8')])
  buf.writeUInt32LE(2, entry + 12) // IMAGE_DEBUG_TYPE_CODEVIEW
  buf.writeUInt32LE(data.length, entry + 16)
  buf.writeUInt32LE(0x1040, entry + 20) // RVA
  buf.writeUInt32LE(record, entry + 24) // file pointer
  data.copy(buf, record)
  return buf
}

const pdbAt = (buf) => buf.toString('utf8', 0x240 + 24, buf.indexOf(0, 0x240 + 24))

describe('nativeKind', () => {
  it('recognizes 64-bit Mach-O and PE headers, and nothing else', () => {
    const macho = Buffer.alloc(8)
    macho.writeUInt32LE(0xfeedfacf, 0)
    expect(nativeKind(macho)).toBe('macho')
    expect(nativeKind(fakePe('x.pdb'))).toBe('pe')
    expect(nativeKind(Buffer.from('#!/bin/sh\necho hi\n'))).toBeNull()
    expect(nativeKind(Buffer.alloc(0))).toBeNull()
  })
})

describe('scrubPePdbPaths', () => {
  it('rewrites an absolute PDB path to its file name without moving any bytes', () => {
    const buf = fakePe('D:\\a\\houston\\houston\\node_modules\\node-pty\\build\\Release\\pty.pdb')
    const before = buf.length
    expect(scrubPePdbPaths(buf)).toBe(1)
    expect(pdbAt(buf)).toBe('pty.pdb')
    expect(buf.length).toBe(before)
    expect(buf.includes(Buffer.from('houston'))).toBe(false)
  })

  it('handles forward slashes and PE32 images', () => {
    const buf = fakePe('/home/runner/work/x/conpty.pdb', { magic: 0x10b })
    expect(scrubPePdbPaths(buf)).toBe(1)
    expect(pdbAt(buf)).toBe('conpty.pdb')
  })

  it('leaves a bare file name, and anything that is not a PE, untouched', () => {
    const bare = fakePe('pty.pdb')
    const copy = Buffer.from(bare)
    expect(scrubPePdbPaths(bare)).toBe(0)
    expect(bare.equals(copy)).toBe(true)

    const notPe = fakePe('C:\\x\\y.pdb')
    notPe.write('XX', 0x80, 'latin1') // break the PE signature
    expect(scrubPePdbPaths(notPe)).toBe(0)
  })

  it('returns 0 for an image with no debug directory', () => {
    const buf = fakePe('C:\\x\\y.pdb')
    buf.writeUInt32LE(0, 0x80 + 24 + 112 + 6 * 8)
    expect(scrubPePdbPaths(buf)).toBe(0)
    expect(pdbAt(buf)).toBe('C:\\x\\y.pdb')
  })
})

describe('scrubNativePaths', () => {
  function tree() {
    const dir = mkdtempSync(join(tmpdir(), 'scrub-native-'))
    mkdirSync(join(dir, 'build', 'Release'), { recursive: true })
    const macho = Buffer.alloc(16)
    macho.writeUInt32LE(0xfeedfacf, 0)
    writeFileSync(join(dir, 'build', 'Release', 'pty.node'), macho)
    writeFileSync(join(dir, 'build', 'Release', 'conpty.node'), fakePe('D:\\a\\b\\conpty.pdb'))
    writeFileSync(join(dir, 'package.json'), '{}')
    return dir
  }

  it('strips Mach-O files on macOS and leaves the rest alone', () => {
    const dir = tree()
    try {
      const stripped = []
      const changed = scrubNativePaths(dir, 'darwin', { strip: (f) => stripped.push(f) })
      expect(stripped).toEqual([join(dir, 'build', 'Release', 'pty.node')])
      expect(changed).toEqual(stripped)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rewrites PE PDB paths on Windows and writes the file back', () => {
    const dir = tree()
    try {
      const strip = () => {
        throw new Error('strip must not run on Windows')
      }
      const changed = scrubNativePaths(dir, 'win32', { strip })
      const file = join(dir, 'build', 'Release', 'conpty.node')
      expect(changed).toEqual([file])
      expect(pdbAt(readFileSync(file))).toBe('conpty.pdb')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('changes nothing on Linux', () => {
    const dir = tree()
    try {
      expect(scrubNativePaths(dir, 'linux', { strip: () => {} })).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
