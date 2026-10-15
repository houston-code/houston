import { existsSync } from 'node:fs'

/** Where Homebrew installs its `brew` (Apple Silicon, then Intel). */
const BREW_PATHS = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']

/** The host OS. A function rather than `process.platform` inline, so tests can pin it. */
export function hostPlatform(): NodeJS.Platform {
  return process.platform
}

/**
 * The host facts an install suggestion depends on (see installSuggestion in
 * @shared/runtimes). Homebrew is checked at its fixed install paths rather than
 * on PATH, which a GUI-launched app inherits minimal.
 */
export function installHost(
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync
): { platform: NodeJS.Platform; hasBrew: boolean } {
  return { platform, hasBrew: platform === 'darwin' && BREW_PATHS.some((p) => exists(p)) }
}
