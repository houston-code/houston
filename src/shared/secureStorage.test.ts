import { describe, expect, it } from 'vitest'
import { secureStorageUnavailableMessage } from './secureStorage'

describe('secureStorageUnavailableMessage', () => {
  it('tells macOS users to restart and allow Keychain access', () => {
    const m = secureStorageUnavailableMessage('darwin')
    expect(m).toContain('Keychain')
    expect(m).toContain('Restart Houston')
    expect(m).toContain('Always Allow')
  })

  it('points Linux users at a keyring', () => {
    const m = secureStorageUnavailableMessage('linux')
    expect(m).toContain('keyring')
    expect(m).toContain('restart Houston')
  })

  it('falls back to a generic restart hint elsewhere', () => {
    expect(secureStorageUnavailableMessage('win32')).toContain('Restart Houston')
  })

  it('never uses an em dash (user-visible copy)', () => {
    for (const p of ['darwin', 'linux', 'win32']) {
      expect(secureStorageUnavailableMessage(p)).not.toContain('\u2014')
    }
  })
})
