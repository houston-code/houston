import { join } from 'node:path'
import { homedir } from 'node:os'
import { APP_NAME } from '@shared/constants'

/**
 * Per-user profile directory for the standalone CLI — computed without Electron,
 * but deliberately matching `app.getPath('userData')` for this app name on every
 * platform, so the CLI and the desktop app read and write the SAME profile
 * (settings.json, conversations, TUI history). Getting this wrong wouldn't crash
 * anything; it would silently fork the user's sessions into a second profile.
 *
 * Electron resolves userData as `appData + '/' + app name`, where appData is:
 *   - macOS:   ~/Library/Application Support
 *   - Windows: %APPDATA% (the Roaming dir)
 *   - Linux:   $XDG_CONFIG_HOME, falling back to ~/.config
 */

export interface ResolvePathDeps {
  /** Platform override (defaults to process.platform); injected in tests. */
  platform?: NodeJS.Platform
  /** Environment override (defaults to process.env); injected in tests. */
  env?: NodeJS.ProcessEnv
  /** Home-dir override (defaults to os.homedir()); injected in tests. */
  home?: string
}

/**
 * Resolve the CLI's user-data directory. `HOUSTON_DATA_DIR` overrides everything —
 * an isolated profile for tests, CI, or a locked-down server — otherwise the
 * platform default above.
 */
export function resolveUserDataDir(deps: ResolvePathDeps = {}): string {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()

  const override = env['HOUSTON_DATA_DIR']
  if (override) return override

  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP_NAME)
  if (platform === 'win32') return join(env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), APP_NAME)
  return join(env['XDG_CONFIG_HOME'] ?? join(home, '.config'), APP_NAME)
}
