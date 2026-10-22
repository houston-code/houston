import { realpathSync } from 'node:fs'
import { DOWNLOAD_URL } from '@shared/update'

/**
 * How this copy of Houston was installed, so an update notice can name the one command
 * that upgrades it instead of sending everyone to the download page.
 *
 * Read from where the running script actually lives (symlinks resolved): every channel
 * puts the CLI somewhere recognizable. npm and bun link `houston` to the package's
 * houston-cli.cjs, the Homebrew formula and the AUR package run it from their own
 * directories through a wrapper, install.sh copies it to a file named `houston`, and a
 * source checkout builds it to out/cli/. Anything unrecognized falls back to the
 * download link, which is always correct, just less convenient.
 */
export type InstallMethod =
  | 'npm'
  | 'bun'
  | 'homebrew'
  | 'aur'
  | 'install-script'
  | 'source'
  | 'desktop'
  | 'download'

export function detectInstallMethod(scriptPath: string | undefined, isDesktop: boolean): InstallMethod {
  if (isDesktop) return 'desktop'
  if (!scriptPath) return 'download'
  // Windows paths from npm's global prefix use backslashes; match on one separator.
  const p = scriptPath.replace(/\\/g, '/')
  if (p.includes('/.bun/install/global/') && p.includes('/node_modules/@houston-code/cli/')) return 'bun'
  if (p.includes('/node_modules/@houston-code/cli/')) return 'npm'
  if (p.includes('/Cellar/houston/')) return 'homebrew'
  if (p === '/usr/lib/houston/houston-cli.cjs') return 'aur'
  if (p.endsWith('/out/cli/houston-cli.cjs')) return 'source'
  // install.sh installs the bundle itself as a file named `houston`; every other channel
  // runs a file named houston-cli.cjs.
  if (p.endsWith('/houston')) return 'install-script'
  return 'download'
}

/** How to upgrade: `line` is the notice's second line, `fix` the bare action for /doctor. */
export interface UpgradeHint {
  line: string
  fix: string
}

const command = (cmd: string): UpgradeHint => ({ line: `update with: ${cmd}`, fix: cmd })

/**
 * The command (or link) that upgrades this install. Fixed strings only, so no release
 * note or cached file can change what is suggested.
 */
export function upgradeHint(method: InstallMethod): UpgradeHint {
  switch (method) {
    case 'npm':
      return command('npm i -g @houston-code/cli@latest')
    case 'bun':
      return command('bun add -g @houston-code/cli@latest')
    case 'homebrew':
      return command('brew upgrade houston')
    case 'aur':
      return command('paru -Syu houston-bin (or your AUR helper)')
    case 'install-script':
      return command('curl -fsSL https://houstoncode.ai/install.sh | sh')
    case 'source':
      return command('git pull && npm run build:cli')
    case 'desktop':
      return { line: `update the Houston app: ${DOWNLOAD_URL}`, fix: `update the Houston app: ${DOWNLOAD_URL}` }
    case 'download':
      return { line: `download: ${DOWNLOAD_URL}`, fix: `download it at ${DOWNLOAD_URL}` }
  }
}

/** The install method of the running process. Never throws: unknown means the download link. */
export function currentInstallMethod(
  argv1: string | undefined = process.argv[1],
  isDesktop: boolean = Boolean(process.versions.electron)
): InstallMethod {
  let scriptPath = argv1
  try {
    if (argv1) scriptPath = realpathSync(argv1)
  } catch {
    // A path that can't be resolved is still worth matching as given.
  }
  return detectInstallMethod(scriptPath, isDesktop)
}
