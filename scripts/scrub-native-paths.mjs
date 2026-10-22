// Remove the build machine's absolute paths from the native binaries electron-builder
// unpacks next to the asar (node-pty's addons and helpers). Called from the afterPack
// hook, which runs before macOS signing, so the signature covers the scrubbed files.
//
// Compilers record where they built: Mach-O binaries carry debug stabs (SO/OSO entries
// naming each source and object file), and Windows PE binaries carry the absolute path
// of their .pdb in a CodeView debug record. Shipped as-is, every locally built package
// names the builder's home directory, and CI builds name the runner's checkout. Neither
// is needed at runtime: stabs only serve a debugger with the object files at hand, and
// the loader never reads the .pdb path.

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MACHO_64 = 0xfeedfacf
const IMAGE_DEBUG_TYPE_CODEVIEW = 2

/** Pure: whether a file's first bytes are a 64-bit Mach-O or a PE (MZ) header. */
export function nativeKind(buf) {
  if (buf.length >= 4 && buf.readUInt32LE(0) === MACHO_64) return 'macho'
  if (buf.length >= 0x40 && buf[0] === 0x4d && buf[1] === 0x5a) return 'pe'
  return null
}

/**
 * Pure: rewrite every CodeView (RSDS) record's PDB path in a PE image to its bare file
 * name, in place, padding with NULs so no offset in the file moves. Returns how many
 * records changed. A path that is already a bare name is left alone. Anything that does
 * not parse as a PE with a debug directory returns 0 untouched.
 */
export function scrubPePdbPaths(buf) {
  const pe = buf.readUInt32LE(0x3c)
  if (pe + 24 > buf.length || buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') return 0
  const sections = buf.readUInt16LE(pe + 6)
  const optSize = buf.readUInt16LE(pe + 20)
  const opt = pe + 24
  const magic = buf.readUInt16LE(opt)
  // Data directories start at 96 (PE32) or 112 (PE32+); the debug directory is entry 6.
  const dirs = opt + (magic === 0x20b ? 112 : 96)
  if (dirs + 7 * 8 > opt + optSize) return 0
  const debugRva = buf.readUInt32LE(dirs + 6 * 8)
  const debugSize = buf.readUInt32LE(dirs + 6 * 8 + 4)
  if (!debugRva || !debugSize) return 0

  // Map the debug directory's RVA to a file offset through the section table.
  const table = opt + optSize
  let debugOff = -1
  for (let i = 0; i < sections; i++) {
    const s = table + i * 40
    const va = buf.readUInt32LE(s + 12)
    const size = Math.max(buf.readUInt32LE(s + 8), buf.readUInt32LE(s + 16))
    if (debugRva >= va && debugRva < va + size) {
      debugOff = buf.readUInt32LE(s + 20) + (debugRva - va)
      break
    }
  }
  if (debugOff < 0) return 0

  let changed = 0
  for (let e = debugOff; e + 28 <= debugOff + debugSize && e + 28 <= buf.length; e += 28) {
    if (buf.readUInt32LE(e + 12) !== IMAGE_DEBUG_TYPE_CODEVIEW) continue
    const dataSize = buf.readUInt32LE(e + 16)
    const raw = buf.readUInt32LE(e + 24)
    if (raw + 24 > buf.length || buf.toString('latin1', raw, raw + 4) !== 'RSDS') continue
    // RSDS, 16-byte GUID, 4-byte age, then the NUL-terminated path.
    const start = raw + 24
    const limit = Math.min(raw + dataSize, buf.length)
    let end = start
    while (end < limit && buf[end] !== 0) end++
    const path = buf.toString('utf8', start, end)
    const base = path.split(/[\\/]/).pop()
    if (base === path) continue
    const bytes = Buffer.from(base, 'utf8')
    buf.fill(0, start, end)
    bytes.copy(buf, start)
    changed++
  }
  return changed
}

/** Every regular file under `dir`, as absolute paths. */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? walk(p) : e.isFile() ? [p] : []
  })
}

/**
 * Scrub every native binary under `dir` for the platform being packaged: strip debug
 * symbols from Mach-O files with the system `strip`, and rewrite PE files' PDB paths.
 * Linux needs nothing: its addons build without debug info. Returns the files changed.
 */
export function scrubNativePaths(dir, platform, { strip = (f) => execFileSync('strip', ['-S', f]) } = {}) {
  const changed = []
  for (const file of walk(dir)) {
    const buf = readFileSync(file)
    const kind = nativeKind(buf)
    if (platform === 'darwin' && kind === 'macho') {
      strip(file)
      changed.push(file)
    } else if (platform === 'win32' && kind === 'pe' && scrubPePdbPaths(buf) > 0) {
      writeFileSync(file, buf)
      changed.push(file)
    }
  }
  return changed
}
