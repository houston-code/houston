import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeKind, scrubPePdbPaths, scrubNativePaths, stripRootFromStrings } from './scrub-native-paths.mjs'

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

describe('stripRootFromStrings', () => {
  const ROOT = 'D:\\a\\houston\\houston'
  const cstr = (b, at) => b.toString('utf8', at, b.indexOf(0, at))

  it('cuts the root and its separator out of a narrow string, in place', () => {
    const src = `${ROOT}\\node_modules\\node-pty\\deps\\winpty\\src\\agent\\Agent.cc`
    const buf = Buffer.concat([Buffer.from('xx\0', 'utf8'), Buffer.from(src + '\0', 'utf8'), Buffer.from('tail', 'utf8')])
    const before = buf.length
    expect(stripRootFromStrings(buf, ROOT)).toBe(1)
    expect(buf.length).toBe(before)
    expect(cstr(buf, 3)).toBe('node_modules\\node-pty\\deps\\winpty\\src\\agent\\Agent.cc')
    // The freed tail of the old string is NULs, and the bytes after it are untouched.
    expect(buf.toString('utf8', buf.length - 4)).toBe('tail')
    expect(buf.includes(Buffer.from('houston'))).toBe(false)
  })

  it('matches forward slashes and UTF-16LE strings', () => {
    const fwd = Buffer.from('D:/a/houston/houston/src/x.cc\0', 'utf8')
    expect(stripRootFromStrings(fwd, ROOT)).toBe(1)
    expect(cstr(fwd, 0)).toBe('src/x.cc')

    const wide = Buffer.from(`${ROOT}\\src\\y.cc\0`, 'utf16le')
    expect(stripRootFromStrings(wide, ROOT)).toBe(1)
    expect(wide.toString('utf16le', 0, wide.indexOf(Buffer.from('\0\0', 'latin1')) + 1).replace(/\0+$/, '')).toBe(
      'src\\y.cc'
    )
    expect(wide.includes(Buffer.from('houston', 'utf16le'))).toBe(false)
  })

  it('handles several strings and leaves a lookalike prefix alone', () => {
    const buf = Buffer.from(`${ROOT}\\a.cc\0${ROOT}2\\b.cc\0${ROOT}\\c.cc\0`, 'utf8')
    expect(stripRootFromStrings(buf, ROOT)).toBe(2)
    const parts = buf.toString('utf8').split('\0').filter(Boolean)
    expect(parts).toEqual(['a.cc', `${ROOT}2\\b.cc`, 'c.cc'])
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
      // A PE with no PDB path but an embedded __FILE__ string under the build root.
      const agent = join(dir, 'build', 'Release', 'winpty-agent.exe')
      const pe = fakePe('winpty-agent.pdb')
      Buffer.from('C:\\build\\repo\\src\\Agent.cc\0', 'utf8').copy(pe, 0x300)
      writeFileSync(agent, pe)

      const changed = scrubNativePaths(dir, 'win32', { strip, root: 'C:\\build\\repo' })
      const file = join(dir, 'build', 'Release', 'conpty.node')
      expect(changed.sort()).toEqual([file, agent].sort())
      expect(pdbAt(readFileSync(file))).toBe('conpty.pdb')
      const scrubbed = readFileSync(agent)
      expect(scrubbed.toString('utf8', 0x300, scrubbed.indexOf(0, 0x300))).toBe('src\\Agent.cc')
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
