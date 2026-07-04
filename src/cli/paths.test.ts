import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { resolveUserDataDir } from './paths'

const HOME = '/home/dev'

describe('resolveUserDataDir', () => {
  it('matches Electron userData on macOS', () => {
    expect(resolveUserDataDir({ platform: 'darwin', env: {}, home: HOME })).toBe(
      join(HOME, 'Library', 'Application Support', 'Houston')
    )
  })

  it('uses %APPDATA% on Windows, with a Roaming fallback', () => {
    expect(
      resolveUserDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' }, home: HOME })
    ).toBe(join('C:\\Users\\dev\\AppData\\Roaming', 'Houston'))
    expect(resolveUserDataDir({ platform: 'win32', env: {}, home: HOME })).toBe(
      join(HOME, 'AppData', 'Roaming', 'Houston')
    )
  })

  it('uses XDG_CONFIG_HOME on Linux, with a ~/.config fallback', () => {
    expect(
      resolveUserDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, home: HOME })
    ).toBe(join('/xdg', 'Houston'))
    expect(resolveUserDataDir({ platform: 'linux', env: {}, home: HOME })).toBe(
      join(HOME, '.config', 'Houston')
    )
  })

  it('HOUSTON_DATA_DIR overrides the platform default', () => {
    expect(
      resolveUserDataDir({ platform: 'darwin', env: { HOUSTON_DATA_DIR: '/srv/profile' }, home: HOME })
    ).toBe('/srv/profile')
  })

  it('treats an empty XDG_CONFIG_HOME / APPDATA as unset (not a relative dir)', () => {
    // An exported-but-empty var must not fork the profile into a cwd-relative dir.
    expect(resolveUserDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '' }, home: HOME })).toBe(
      join(HOME, '.config', 'Houston')
    )
    expect(resolveUserDataDir({ platform: 'win32', env: { APPDATA: '' }, home: HOME })).toBe(
      join(HOME, 'AppData', 'Roaming', 'Houston')
    )
  })
})
