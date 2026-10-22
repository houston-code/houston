import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { expect, test } from '@playwright/test'
import { findPackagedApp, ROOT } from './launch'

/**
 * Static checks on the packaged app's files, without launching it: what electron-builder
 * put in the asar, the native addon it unpacked, and the macOS bundle metadata. Each
 * guards a packaging mistake that the launch tests would miss or report only as a crash.
 */

const packaged = findPackagedApp()

function skipUnlessPackaged(): void {
  // Same contract as packaged-resources.spec.ts: skip for unpackaged local runs, fail in CI.
  test.skip(!packaged && !process.env.CI, 'no packaged app in release/ (unpackaged local run)')
  expect(packaged, 'no packaged app in release/ for this platform. Did `npm run dist*` run first?').toBeTruthy()
}

interface AsarNode {
  files?: Record<string, AsarNode>
}

/**
 * List every file path in an asar archive. The format starts with two little-endian
 * UInt32 pickle headers, then a pickled string holding a JSON tree of `files` maps:
 * bytes 12..16 are the JSON length and the JSON starts at byte 16.
 */
function listAsar(path: string): Set<string> {
  const buf = readFileSync(path)
  const len = buf.readInt32LE(12)
  const root = JSON.parse(buf.subarray(16, 16 + len).toString('utf8')) as AsarNode
  const out = new Set<string>()
  const walk = (node: AsarNode, prefix: string): void => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${name}` : name
      if (child.files) walk(child, p)
      else out.add(p)
    }
  }
  walk(root, '')
  return out
}

/** Every file under `dir`, as forward-slash paths relative to it. */
function listDir(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    return e.isDirectory() ? listDir(join(dir, e.name), rel) : [rel]
  })
}

/**
 * The files a package's entry points name: `main`, plus every runtime target in
 * `exports['.']` (types and browser builds aside, which the app never loads).
 */
function entryFiles(pkg: { main?: string; exports?: unknown }): string[] {
  const out: string[] = []
  if (pkg.main) out.push(pkg.main)
  const collect = (v: unknown): void => {
    if (typeof v === 'string') out.push(v)
    else if (v && typeof v === 'object') {
      for (const [k, sub] of Object.entries(v)) if (k !== 'types' && k !== 'browser') collect(sub)
    }
  }
  const exp = pkg.exports
  collect(exp && typeof exp === 'object' && '.' in exp ? (exp as Record<string, unknown>)['.'] : exp)
  return [...new Set(out.filter((f) => !/\.d\.[cm]?ts$/.test(f)).map((f) => posix.normalize(f)))]
}

test('the asar carries every runtime dependency entry point and no dev-only files', () => {
  skipUnlessPackaged()
  const resources = packaged!.resources
  const asar = listAsar(join(resources, 'app.asar'))
  const unpacked = new Set(listDir(join(resources, 'app.asar.unpacked')))
  const has = (p: string): boolean => asar.has(p) || unpacked.has(p)

  // The app's own bundle, and the package.json `main` that points at it.
  const appPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    main: string
    dependencies: Record<string, string>
  }
  expect(asar.has(posix.normalize(appPkg.main)), `${appPkg.main} missing from the asar`).toBe(true)

  // Every production dependency, with the files its entry points resolve to. The files
  // filter in electron-builder.yml strips .map/.d.ts/.ts from node_modules; a pattern
  // that also caught a runtime file (say the .mjs entry of @google/genai) fails here.
  for (const dep of Object.keys(appPkg.dependencies)) {
    const pkgPath = `node_modules/${dep}/package.json`
    expect(has(pkgPath), `${dep} is missing from the packaged app`).toBe(true)
    const pkg = JSON.parse(readFileSync(join(ROOT, pkgPath), 'utf8')) as { main?: string; exports?: unknown }
    for (const f of entryFiles(pkg)) {
      const p = `node_modules/${dep}/${f}`
      expect(has(p), `${dep}'s entry ${f} is missing from the packaged app`).toBe(true)
    }
  }

  // And what the filter is there to drop.
  const devOnly = [...asar].filter((p) => p.startsWith('node_modules/') && /\.(map|d\.[cm]?ts|ts)$/.test(p))
  expect(devOnly.slice(0, 10), 'source maps, type declarations or raw .ts sources in the asar').toEqual([])
})

test('the packaged app embeds no absolute path from the build machine', () => {
  skipUnlessPackaged()
  const resources = packaged!.resources
  // The checkout path stands in for "the build machine": a bundler or native build that
  // records absolute paths writes this prefix, which on a developer's machine carries
  // their home directory and user name. On Windows, tools write it with either slash.
  const needles = [...new Set([ROOT, ROOT.replace(/\\/g, '/')])].map((p) => Buffer.from(p))
  const files = [
    join(resources, 'app.asar'),
    ...listDir(join(resources, 'app.asar.unpacked')).map((p) => join(resources, 'app.asar.unpacked', p))
  ]
  const leaks = files.filter((f) => {
    const data = readFileSync(f)
    return needles.some((n) => data.includes(n))
  })
  expect(leaks.map((f) => f.slice(resources.length + 1)), `files containing ${ROOT}`).toEqual([])
})

/** The CPU arch a native binary was built for, read from its Mach-O, ELF or PE header. */
function binaryArch(path: string): string {
  const b = readFileSync(path)
  if (b.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = b.readUInt32LE(4)
    return cpu === 0x0100000c ? 'arm64' : cpu === 0x01000007 ? 'x64' : `mach-o:${cpu.toString(16)}`
  }
  if (b.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    const machine = b.readUInt16LE(0x12)
    return machine === 0x3e ? 'x64' : machine === 0xb7 ? 'arm64' : `elf:${machine.toString(16)}`
  }
  if (b.subarray(0, 2).toString('latin1') === 'MZ') {
    const machine = b.readUInt16LE(b.readUInt32LE(0x3c) + 4)
    return machine === 0x8664 ? 'x64' : machine === 0xaa64 ? 'arm64' : `pe:${machine.toString(16)}`
  }
  return 'unknown'
}

test('node-pty is unpacked from the asar and built for this arch', () => {
  skipUnlessPackaged()
  // node-pty loads build/Release first and falls back to its prebuilds only if that
  // fails, so the rebuilt addon is the one that must match. It can't load from inside
  // the asar, hence asarUnpack in electron-builder.yml.
  const addon = join(packaged!.resources, 'app.asar.unpacked', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node')
  expect(existsSync(addon), 'node-pty build/Release/pty.node is not unpacked').toBe(true)
  expect(statSync(addon).size).toBeGreaterThan(0)
  expect(binaryArch(addon), 'node-pty was built for the wrong arch').toBe(process.arch)
})

test("node-pty ships only this platform's prebuilds", () => {
  skipUnlessPackaged()
  // The loader's fallback is prebuilds/<platform>-<arch> and nothing else, so another
  // platform's prebuilds are dead weight (the Windows ones also carry their own DLLs and
  // helper executables). electron-builder.yml keeps only the target's.
  const prebuilds = join(packaged!.resources, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds')
  const present = existsSync(prebuilds) ? readdirSync(prebuilds) : []
  const own = `${process.platform}-${process.arch}`
  expect(present.filter((d) => d !== own), 'other platforms\' node-pty prebuilds are packaged').toEqual([])
})

test('the macOS bundle declares its id, version and minimum OS', () => {
  test.skip(process.platform !== 'darwin', 'Info.plist is macOS-only')
  skipUnlessPackaged()
  const plist = readFileSync(join(packaged!.resources, '..', 'Info.plist'), 'utf8')
  const value = (key: string): string | undefined =>
    new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1]
  const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version

  expect(value('CFBundleIdentifier')).toBe('com.houston.app')
  expect(value('CFBundleShortVersionString')).toBe(version)
  // electron-builder.yml pins the floor so an older Mac gets a clean "requires macOS 13"
  // dialog instead of a dyld crash; a dropped setting would fall back to Electron's own.
  expect(value('LSMinimumSystemVersion')).toBe('13.0')
})
