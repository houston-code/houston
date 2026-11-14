import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { FUSE_INDEX, type FuseName } from '../scripts/electron-fuses.mjs'
import type { PackagedApp } from './launch'

/**
 * Read and flip Electron fuses in a packaged app, without @electron/fuses (it is only a
 * transitive dependency of electron-builder). The wire format is small and stable: a
 * 32-byte sentinel, a version byte (1), a length byte, then one byte per fuse: '1'
 * enabled, '0' disabled, 'r' removed. A universal macOS binary carries one wire per slice.
 * The values the build sets live in scripts/electron-fuses.mjs.
 */
const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'latin1')
const ENABLED = 0x31
const DISABLED = 0x30
const REMOVED = 0x72

export type FuseState = 'enabled' | 'disabled' | 'removed' | 'unknown'

/** The file that holds the fuse wire: the Electron Framework on macOS, else the executable. */
export function fuseBinaryOf(app: PackagedApp): string {
  if (process.platform === 'darwin') {
    return join(app.bundle, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework')
  }
  return app.executable
}

/** Offset of the first fuse byte of every wire in `buf`. */
function wireOffsets(buf: Buffer): number[] {
  const out: number[] = []
  for (let at = buf.indexOf(SENTINEL); at !== -1; at = buf.indexOf(SENTINEL, at + 1)) {
    const version = buf[at + SENTINEL.length]
    if (version !== 1) throw new Error(`unsupported fuse wire version ${version}`)
    out.push(at + SENTINEL.length + 2)
  }
  if (out.length === 0) throw new Error('no Electron fuse wire in the binary')
  return out
}

function stateOf(byte: number | undefined): FuseState {
  if (byte === ENABLED) return 'enabled'
  if (byte === DISABLED) return 'disabled'
  if (byte === REMOVED) return 'removed'
  return 'unknown'
}

/** Every named fuse's state. Throws when the slices of a universal binary disagree. */
export function readFuses(binary: string): Record<FuseName, FuseState> {
  const buf = readFileSync(binary)
  const offsets = wireOffsets(buf)
  const out = {} as Record<FuseName, FuseState>
  for (const [name, index] of Object.entries(FUSE_INDEX) as Array<[FuseName, number]>) {
    const states = new Set(offsets.map((o) => stateOf(buf[o + index])))
    if (states.size !== 1) throw new Error(`fuse ${name} differs between the binary's slices`)
    out[name] = [...states][0]
  }
  return out
}

function setFuse(binary: string, name: FuseName, enabled: boolean): void {
  const buf = readFileSync(binary)
  for (const o of wireOffsets(buf)) buf[o + FUSE_INDEX[name]] = enabled ? ENABLED : DISABLED
  writeFileSync(binary, buf)
}

/**
 * Playwright's Electron launcher drives the main process through the Node inspector
 * (`--inspect=0`), which the shipped app's fuses refuse on purpose. So the suite launches
 * a throwaway COPY of the packaged app with that one fuse turned back on, and never touches
 * the artifact in release/ (the release workflow signs and ships that same tree, and
 * package-contents.spec.ts checks its fuses). On macOS the flip invalidates the copy's
 * signature, so the copy is re-signed ad hoc, keeping its entitlements and hardened runtime.
 *
 * Returns null when the packaged app already accepts the inspector (nothing to copy).
 */
export function inspectableCopy(app: PackagedApp): { executable: string; root: string } | null {
  if (readFuses(fuseBinaryOf(app)).EnableNodeCliInspectArguments === 'enabled') return null
  const root = mkdtempSync(join(tmpdir(), 'houston-e2e-app-'))
  try {
    const bundle = join(root, basename(app.bundle))
    if (process.platform === 'darwin') {
      // ditto keeps the bundle exactly: framework symlinks, modes, extended attributes.
      execFileSync('ditto', [app.bundle, bundle])
    } else {
      cpSync(app.bundle, bundle, { recursive: true, verbatimSymlinks: true })
    }
    const copy: PackagedApp = {
      ...app,
      bundle,
      executable: join(bundle, relative(app.bundle, app.executable)),
      resources: join(bundle, relative(app.bundle, app.resources))
    }
    setFuse(fuseBinaryOf(copy), 'EnableNodeCliInspectArguments', true)
    if (process.platform === 'darwin') {
      execFileSync('codesign', [
        '--sign',
        '-',
        '--force',
        '--deep',
        '--preserve-metadata=entitlements,requirements,flags,runtime',
        bundle
      ])
    }
    return { executable: copy.executable, root }
  } catch (err) {
    rmSync(root, { recursive: true, force: true })
    throw err
  }
}
