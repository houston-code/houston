// Remove the build machine's absolute paths from the native binaries electron-builder
// unpacks next to the asar (node-pty's addons and helpers). Called from the afterPack
// hook, which runs before macOS signing, so the signature covers the scrubbed files.
//
// Compilers record where they built: Mach-O binaries carry debug stabs (SO/OSO entries
// naming each source and object file), and Windows PE binaries carry the absolute path
// of their .pdb in a CodeView debug record and, where the code uses __FILE__ (winpty's
// assertions do), each source file's absolute path as a string. Shipped as-is, every locally built package
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

/**
 * Pure: cut `root` out of every string embedded in `buf` that starts with it, in place.
 * A match must be followed by a path separator, which goes too, so
 * `D:\a\repo\src\x.cc` becomes `src\x.cc`. The rest of the string moves left and the
 * freed bytes become NULs, so the string stays NUL-terminated within its original span
 * and nothing else in the file moves. Both slash forms are matched, as narrow (UTF-8)
 * strings and as UTF-16LE ones (MSVC's wide __FILEW__). Returns how many strings changed.
 */
export function stripRootFromStrings(buf, root) {
  const roots = [...new Set([root, root.replace(/\\/g, '/'), root.replace(/\//g, '\\')])]
  let changed = 0
  for (const r of roots) {
    for (const wide of [false, true]) {
      const unit = wide ? 2 : 1
      const needle = Buffer.from(r, wide ? 'utf16le' : 'utf8')
      const at = (i) => (wide ? buf.readUInt16LE(i) : buf[i])
      let i = buf.indexOf(needle)
      while (i !== -1) {
        const after = i + needle.length
        const sep = after + unit <= buf.length ? at(after) : 0
        if (sep === 0x5c || sep === 0x2f) {
          let end = after + unit
          while (end + unit <= buf.length && at(end) !== 0) end += unit
          const rest = Buffer.from(buf.subarray(after + unit, end))
          rest.copy(buf, i)
          buf.fill(0, i + rest.length, end)
          changed++
        }
        i = buf.indexOf(needle, i + unit)
      }
    }
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
 * symbols from Mach-O files with the system `strip`, and on PE files rewrite the PDB
 * path and cut `root` (the checkout the addons were built in) out of embedded strings.
 * Linux needs nothing: its addons build without debug info. Returns the files changed.
 */
export function scrubNativePaths(dir, platform, { root, strip = (f) => execFileSync('strip', ['-S', f]) } = {}) {
  const changed = []
  for (const file of walk(dir)) {
    const buf = readFileSync(file)
    const kind = nativeKind(buf)
    if (platform === 'darwin' && kind === 'macho') {
      strip(file)
      changed.push(file)
    } else if (platform === 'win32' && kind === 'pe') {
      const n = scrubPePdbPaths(buf) + (root ? stripRootFromStrings(buf, root) : 0)
      if (n > 0) {
        writeFileSync(file, buf)
        changed.push(file)
      }
    }
  }
  return changed
}
