// electron-builder `afterPack` hook: copy the vendored `rg` (ripgrep) and `ast-grep`
// binaries for the EXACT (platform, arch) being packaged into that build's
// Resources/bin. The main process resolves them via `process.resourcesPath`
// (see src/main/binaries.ts) so search/structural-search work out of the box.
//
// Why a hook and not static `extraResources`: electron-builder shares one config
// object across all arches of a platform, and `extraResources` `from:` paths can't
// vary by arch — a multi-arch run would copy the WRONG-arch binary into one build.
// The hook fires once per (platform, arch) and copies exactly the right one, and it
// THROWS if the sub-package is missing (electron-builder would only warn and ship a
// broken app). The pure planners are unit-tested without ever packaging.

import { copyFileSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Single source of truth for the per-(os,arch) vendored binary layout. Verified
 * against package-lock.json: ripgrep is uniform (`ripgrep-{os}-{arch}`, binary under
 * `bin/`), while ast-grep carries a toolchain suffix (`-gnu` on Linux, `-msvc` on
 * Windows, none on macOS) and its binary sits at the package root. Windows binaries
 * end in `.exe`.
 */
export const BINARY_MAP = {
  'darwin-arm64': {
    rg: { pkg: '@vscode/ripgrep-darwin-arm64', file: 'bin/rg', dest: 'rg' },
    astGrep: { pkg: '@ast-grep/cli-darwin-arm64', file: 'ast-grep', dest: 'ast-grep' }
  },
  'darwin-x64': {
    rg: { pkg: '@vscode/ripgrep-darwin-x64', file: 'bin/rg', dest: 'rg' },
    astGrep: { pkg: '@ast-grep/cli-darwin-x64', file: 'ast-grep', dest: 'ast-grep' }
  },
  'linux-x64': {
    rg: { pkg: '@vscode/ripgrep-linux-x64', file: 'bin/rg', dest: 'rg' },
    astGrep: { pkg: '@ast-grep/cli-linux-x64-gnu', file: 'ast-grep', dest: 'ast-grep' }
  },
  'linux-arm64': {
    rg: { pkg: '@vscode/ripgrep-linux-arm64', file: 'bin/rg', dest: 'rg' },
    astGrep: { pkg: '@ast-grep/cli-linux-arm64-gnu', file: 'ast-grep', dest: 'ast-grep' }
  },
  'win32-x64': {
    rg: { pkg: '@vscode/ripgrep-win32-x64', file: 'bin/rg.exe', dest: 'rg.exe' },
    astGrep: { pkg: '@ast-grep/cli-win32-x64-msvc', file: 'ast-grep.exe', dest: 'ast-grep.exe' }
  },
  'win32-arm64': {
    rg: { pkg: '@vscode/ripgrep-win32-arm64', file: 'bin/rg.exe', dest: 'rg.exe' },
    astGrep: { pkg: '@ast-grep/cli-win32-arm64-msvc', file: 'ast-grep.exe', dest: 'ast-grep.exe' }
  }
}

/** electron-builder's Arch enum index → our arch string. */
export const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

/** Pure: given (platform, arch), return the resolved {from, to} copy plan, or throw. */
export function planCopies(electronPlatformName, archName, { root, resourcesDir }) {
  const key = `${electronPlatformName}-${archName}`
  const entry = BINARY_MAP[key]
  if (!entry) {
    throw new Error(
      `copy-bundled-binaries: no vendored binaries mapped for "${key}". ` +
        `Supported: ${Object.keys(BINARY_MAP).join(', ')}.`
    )
  }
  return Object.values(entry).map((b) => ({
    from: join(root, 'node_modules', b.pkg, b.file),
    to: join(resourcesDir, 'bin', b.dest)
  }))
}

/**
 * The Resources dir differs by platform: on macOS it nests inside the .app bundle;
 * on Windows/Linux it's `<appOutDir>/resources`. Uses `productFilename` (the actual
 * .app bundle name), not the display `productName`, which can differ.
 */
export function resourcesDirFor(electronPlatformName, appOutDir, productFilename) {
  if (electronPlatformName === 'darwin') {
    return join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
  }
  return join(appOutDir, 'resources')
}

export default async function afterPack(context) {
  const { appOutDir, electronPlatformName, arch } = context
  const archName = ARCH_NAMES[arch]
  const productFilename = context.packager.appInfo.productFilename
  const root = process.cwd()
  const resourcesDir = resourcesDirFor(electronPlatformName, appOutDir, productFilename)
  const plan = planCopies(electronPlatformName, archName, { root, resourcesDir })
  mkdirSync(join(resourcesDir, 'bin'), { recursive: true })
  for (const { from, to } of plan) {
    copyFileSync(from, to) // throws loudly if the per-arch sub-package wasn't installed
    chmodSync(to, 0o755) // npm can drop the executable bit on extract
  }
  console.log(`✓ copied ${plan.length} vendored binaries for ${electronPlatformName}-${archName}`)
}
