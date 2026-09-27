import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { load } from 'js-yaml'
import { Arch, getArtifactArchName } from 'builder-util/out/arch.js'

// Every file a release ships should name its arch. electron-builder's DEFAULT zip name
// leaves the arch out for x64 (`Houston-<v>-mac.zip`), which made the Intel mac zip look
// like a universal build next to the arm64 one. The mac platform `artifactName` fixes
// that; these checks keep it from regressing.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const config = load(readFileSync(resolve(ROOT, 'electron-builder.yml'), 'utf8'))

// Same precedence electron-builder uses (platformPackager.artifactPatternConfig): the
// target's own section, then the platform section, then the top level.
function artifactName(platform, target, ext, arch) {
  const pattern = config[target]?.artifactName ?? config[platform]?.artifactName ?? config.artifactName
  if (!pattern) throw new Error(`no artifactName for ${platform}/${target}; the default drops x64`)
  return pattern
    .replace('${productName}', config.productName)
    .replace('${version}', '1.2.3')
    .replace('${arch}', getArtifactArchName(arch, ext))
    .replace('${os}', platform)
    .replace('${ext}', ext)
}

const SHIPPED = [
  ['mac', 'dmg', 'dmg', Arch.arm64, 'Houston-1.2.3-arm64.dmg'],
  ['mac', 'zip', 'zip', Arch.arm64, 'Houston-1.2.3-arm64-mac.zip'],
  ['mac', 'dmg', 'dmg', Arch.x64, 'Houston-1.2.3-x64.dmg'],
  ['mac', 'zip', 'zip', Arch.x64, 'Houston-1.2.3-x64-mac.zip'],
  ['win', 'nsis', 'exe', Arch.x64, 'Houston-1.2.3-x64-setup.exe'],
  ['linux', 'appImage', 'AppImage', Arch.x64, 'Houston-1.2.3-x86_64.AppImage'],
  ['linux', 'deb', 'deb', Arch.x64, 'Houston-1.2.3-amd64.deb'],
]

describe('release artifact names', () => {
  for (const [platform, target, ext, arch, expected] of SHIPPED) {
    it(`${platform} ${target} (${Arch[arch]}) is ${expected}`, () => {
      expect(artifactName(platform, target, ext, arch)).toBe(expected)
    })
  }

  it('ships Windows as the nsis installer only (the updater never reads a zip there)', () => {
    expect(config.win.target.map((t) => t.target)).toEqual(['nsis'])
  })

  it('keeps the dmg out of the update feed (no .dmg.blockmap; MacUpdater reads the zip)', () => {
    expect(config.dmg.writeUpdateInfo).toBe(false)
    expect(config.mac.target).toContain('zip')
  })

  it('gives every shipped file a distinct name', () => {
    const names = SHIPPED.map(([p, t, e, a]) => artifactName(p, t, e, a))
    expect(new Set(names).size).toBe(names.length)
  })

  it('keeps the arm64 marker the merged mac feed splits on out of the Intel names', () => {
    // merge-mac-update-yml.mjs treats a file as arm64 iff its URL contains "arm64".
    expect(artifactName('mac', 'zip', 'zip', Arch.x64)).not.toContain('arm64')
    expect(artifactName('mac', 'dmg', 'dmg', Arch.x64)).not.toContain('arm64')
  })
})
