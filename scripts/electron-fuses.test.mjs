import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi } from 'vitest'
import { load } from 'js-yaml'
import fuses from '@electron/fuses'
import { PlatformPackager } from 'app-builder-lib'
import { FUSE_INDEX, fusesFor, fuseConfigFor, flipFusesForPack } from './electron-fuses.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const builderConfig = load(readFileSync(resolve(ROOT, 'electron-builder.yml'), 'utf8'))

// The fuses that let a same-user process run code as the signed app. Each must be off on
// every platform (RunAsNode: everywhere but Linux, whose sandbox forwarder needs it).
const CODE_EXECUTION_FUSES = ['EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments']

describe('fusesFor', () => {
  it('turns off the debugger and NODE_OPTIONS on every platform', () => {
    for (const platform of ['darwin', 'mas', 'win32', 'linux']) {
      for (const fuse of CODE_EXECUTION_FUSES) expect(fusesFor(platform)[fuse], `${platform} ${fuse}`).toBe(false)
    }
  })

  it('turns off RunAsNode on macOS and Windows', () => {
    expect(fusesFor('darwin').RunAsNode).toBe(false)
    expect(fusesFor('mas').RunAsNode).toBe(false)
    expect(fusesFor('win32').RunAsNode).toBe(false)
  })

  it('keeps RunAsNode on Linux only, for the egress forwarder', () => {
    expect(fusesFor('linux').RunAsNode).toBe(true)
    // The forwarder really does rely on it; if it stops, turn the fuse off on Linux too.
    const linuxBackend = readFileSync(resolve(ROOT, 'src/main/sandbox/linux.ts'), 'utf8')
    expect(linuxBackend).toMatch(/ELECTRON_RUN_AS_NODE: '1'/)
  })

  it('loads the app only from an integrity-checked asar on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(fusesFor(platform).EnableEmbeddedAsarIntegrityValidation).toBe(true)
      expect(fusesFor(platform).OnlyLoadAppFromAsar).toBe(true)
    }
  })

  it('pins the exact set everywhere', () => {
    expect(fusesFor('darwin')).toEqual({
      RunAsNode: false,
      EnableCookieEncryption: true,
      EnableNodeOptionsEnvironmentVariable: false,
      EnableNodeCliInspectArguments: false,
      EnableEmbeddedAsarIntegrityValidation: true,
      OnlyLoadAppFromAsar: true,
      LoadBrowserProcessSpecificV8Snapshot: false,
      GrantFileProtocolExtraPrivileges: true
    })
    expect(fusesFor('win32')).toEqual(fusesFor('darwin'))
    expect(fusesFor('linux')).toEqual({ ...fusesFor('darwin'), RunAsNode: true })
  })

  it('sets every fuse Electron has, by name', () => {
    expect(Object.keys(fusesFor('darwin')).sort()).toEqual(Object.keys(FUSE_INDEX).sort())
  })

  it('refuses an unknown platform rather than shipping defaults', () => {
    expect(() => fusesFor('freebsd')).toThrow(/unknown platform "freebsd"/)
    expect(() => fusesFor(undefined)).toThrow(/unknown platform/)
  })
})

describe('FUSE_INDEX', () => {
  it('matches the wire positions @electron/fuses (the one electron-builder loads) uses', () => {
    for (const [name, index] of Object.entries(FUSE_INDEX)) expect(fuses.FuseV1Options[name], name).toBe(index)
    // and covers every fuse that package knows
    const known = Object.keys(fuses.FuseV1Options).filter((k) => Number.isNaN(Number(k)))
    expect(known.sort()).toEqual(Object.keys(FUSE_INDEX).sort())
  })
})

describe('fuseConfigFor', () => {
  it('maps the named values onto the V1 wire', () => {
    const config = fuseConfigFor('win32')
    expect(config.version).toBe(fuses.FuseVersion.V1)
    expect(config[fuses.FuseV1Options.RunAsNode]).toBe(false)
    expect(config[fuses.FuseV1Options.EnableNodeCliInspectArguments]).toBe(false)
    expect(config[fuses.FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(false)
    expect(config[fuses.FuseV1Options.OnlyLoadAppFromAsar]).toBe(true)
    expect(config[fuses.FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(true)
    expect(fuseConfigFor('linux')[fuses.FuseV1Options.RunAsNode]).toBe(true)
  })

  it('re-signs ad hoc on macOS only, so an unsigned arm64 build still launches', () => {
    expect(fuseConfigFor('darwin').resetAdHocDarwinSignature).toBe(true)
    expect(fuseConfigFor('mas').resetAdHocDarwinSignature).toBe(true)
    expect(fuseConfigFor('win32').resetAdHocDarwinSignature).toBe(false)
    expect(fuseConfigFor('linux').resetAdHocDarwinSignature).toBe(false)
  })
})

describe('flipFusesForPack', () => {
  it("flips this pack's platform config through the packager", async () => {
    const addElectronFuses = vi.fn(async () => 1)
    const context = { electronPlatformName: 'darwin', appOutDir: '/x', packager: { addElectronFuses } }
    await flipFusesForPack(context)
    expect(addElectronFuses).toHaveBeenCalledWith(context, fuseConfigFor('darwin'))
  })

  it('uses an electron-builder API that exists in the installed version', () => {
    expect(typeof PlatformPackager.prototype.addElectronFuses).toBe('function')
  })
})

describe('packaging wiring', () => {
  it('flips the fuses from the afterPack hook, after the copies and the scrub', () => {
    expect(builderConfig.afterPack).toBe('./scripts/copy-bundled-binaries.mjs')
    const hook = readFileSync(resolve(ROOT, 'scripts/copy-bundled-binaries.mjs'), 'utf8')
    expect(hook).toMatch(/import \{ flipFusesForPack \} from '\.\/electron-fuses\.mjs'/)
    const flip = hook.indexOf('await flipFusesForPack(context)')
    expect(flip).toBeGreaterThan(hook.indexOf('scrubNativePaths(unpacked'))
  })

  it("never sets electron-builder's platform-blind electronFuses as well", () => {
    expect(builderConfig).not.toHaveProperty('electronFuses')
    for (const platform of ['mac', 'win', 'linux']) expect(builderConfig[platform]).not.toHaveProperty('electronFuses')
  })

  it('keeps asar packaging on (the asar fuses assume it)', () => {
    expect(builderConfig.asar).toBe(true)
  })
})

describe('macOS entitlements', () => {
  const plistPath = resolve(ROOT, 'build/entitlements.mac.plist')
  const plist = readFileSync(plistPath, 'utf8')
  // Every <key> granted <true/>, ignoring comments.
  const granted = [...plist.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((m) => m[1])

  it('is the file both the app and its helpers are signed with', () => {
    expect(builderConfig.mac.entitlements).toBe('build/entitlements.mac.plist')
    expect(builderConfig.mac.entitlementsInherit).toBe('build/entitlements.mac.plist')
  })

  it('does not allow DYLD environment variables (library injection)', () => {
    expect(granted).not.toContain('com.apple.security.cs.allow-dyld-environment-variables')
  })

  it('grants exactly the reviewed set', () => {
    expect(granted.sort()).toEqual([
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.disable-library-validation'
    ])
  })
})
