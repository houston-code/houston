import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOWNLOAD_URL } from '@shared/update'
import { currentInstallMethod, detectInstallMethod, upgradeHint, type InstallMethod } from './install-method'

describe('detectInstallMethod', () => {
  // Where each channel actually puts the running script (symlinks already resolved).
  it.each<[string, InstallMethod]>([
    ['/usr/local/lib/node_modules/@houston-code/cli/houston-cli.cjs', 'npm'],
    ['/Users/dev/.nvm/versions/node/v22.23.4/lib/node_modules/@houston-code/cli/houston-cli.cjs', 'npm'],
    ['C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@houston-code\\cli\\houston-cli.cjs', 'npm'],
    ['/Users/dev/.bun/install/global/node_modules/@houston-code/cli/houston-cli.cjs', 'bun'],
    ['/opt/homebrew/Cellar/houston/0.9.0/libexec/houston-cli.cjs', 'homebrew'],
    ['/home/linuxbrew/.linuxbrew/Cellar/houston/0.9.0/libexec/houston-cli.cjs', 'homebrew'],
    ['/usr/lib/houston/houston-cli.cjs', 'aur'],
    ['/home/dev/.local/bin/houston', 'install-script'],
    ['/home/dev/code/houston/out/cli/houston-cli.cjs', 'source'],
    ['/home/dev/Downloads/houston-cli.cjs', 'download'],
    ['/srv/tools/houston-cli.cjs', 'download'],
  ])('%s is %s', (path, method) => {
    expect(detectInstallMethod(path, false)).toBe(method)
  })

  it('reports the desktop app whatever the script path', () => {
    expect(detectInstallMethod('/usr/local/lib/node_modules/@houston-code/cli/houston-cli.cjs', true)).toBe('desktop')
  })

  it('falls back to the download link with no script path', () => {
    expect(detectInstallMethod(undefined, false)).toBe('download')
  })

  // A different npm package that merely has "houston" in its path is not ours to upgrade.
  it('does not mistake another package for the CLI', () => {
    expect(detectInstallMethod('/usr/lib/node_modules/houston/index.js', false)).toBe('download')
  })
})

describe('upgradeHint', () => {
  it('gives each channel its own upgrade command', () => {
    expect(upgradeHint('npm')).toEqual({
      line: 'update with: npm i -g @houston-code/cli@latest',
      fix: 'npm i -g @houston-code/cli@latest'
    })
    expect(upgradeHint('bun').fix).toBe('bun add -g @houston-code/cli@latest')
    expect(upgradeHint('homebrew').fix).toBe('brew upgrade houston')
    expect(upgradeHint('aur').fix).toBe('paru -Syu houston-bin (or your AUR helper)')
    expect(upgradeHint('install-script').fix).toBe('curl -fsSL https://houstoncode.ai/install.sh | sh')
    expect(upgradeHint('source').fix).toBe('git pull && npm run build:cli')
  })

  it('sends the desktop app and unknown installs to the download page', () => {
    expect(upgradeHint('desktop').line).toBe(`update the Houston app: ${DOWNLOAD_URL}`)
    expect(upgradeHint('download')).toEqual({ line: `download: ${DOWNLOAD_URL}`, fix: `download it at ${DOWNLOAD_URL}` })
  })

  it('never shows an em dash to the user', () => {
    const methods: InstallMethod[] = ['npm', 'bun', 'homebrew', 'aur', 'install-script', 'source', 'desktop', 'download']
    for (const m of methods) expect(`${upgradeHint(m).line} ${upgradeHint(m).fix}`).not.toContain('\u2014')
  })
})

describe('currentInstallMethod', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  // npm's global bin is a symlink to the package's file; the method comes from the target.
  it.skipIf(process.platform === 'win32')('follows a symlinked bin to the package it points at', () => {
    dir = mkdtempSync(join(tmpdir(), 'houston-install-method-'))
    const pkg = join(dir, 'lib', 'node_modules', '@houston-code', 'cli')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'houston-cli.cjs'), '')
    mkdirSync(join(dir, 'bin'))
    symlinkSync(join(pkg, 'houston-cli.cjs'), join(dir, 'bin', 'houston'))
    expect(currentInstallMethod(join(dir, 'bin', 'houston'), false)).toBe('npm')
  })

  it('matches a path that cannot be resolved as given', () => {
    expect(currentInstallMethod('/nonexistent/.local/bin/houston', false)).toBe('install-script')
  })

  it('reports the desktop app under Electron', () => {
    expect(currentInstallMethod('/anything', true)).toBe('desktop')
  })
})
