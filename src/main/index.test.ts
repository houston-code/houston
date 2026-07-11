import { describe, expect, it, vi } from 'vitest'
import { APP_NAME } from '@shared/constants'

/**
 * `userData` and the macOS Keychain service name that `safeStorage` uses for API
 * keys are derived from the app name and locked in at the `ready` event. If
 * `setName` runs inside `whenReady` (after ready) the name change no longer
 * affects them, so API keys fail to persist. Guard the ordering here.
 */

const setName = vi.fn()
// Never resolves, so the whenReady callback (registerIpc/createWindow) never runs.
const whenReady = vi.fn(() => new Promise<void>(() => {}))
const on = vi.fn()
const getPath = vi.fn(() => '/tmp/houston-test-userdata')
// Return undefined so the scrollbar-default guard falls through to setUserDefault.
const getUserDefault = vi.fn(() => undefined)
const setUserDefault = vi.fn()

vi.mock('electron', () => ({
  app: { setName, whenReady, on, getName: vi.fn(), getPath },
  shell: { openExternal: vi.fn() },
  systemPreferences: { getUserDefault, setUserDefault },
  BrowserWindow: vi.fn()
}))

// Keep the import graph hermetic — registerIpc only runs inside the (never-fired)
// ready callback, so a stub is enough.
vi.mock('./ipc', () => ({ registerIpc: vi.fn() }))

describe('main entry app identity', () => {
  it('sets the app name before whenReady so userData/Keychain stay stable', async () => {
    await import('./index')

    expect(setName).toHaveBeenCalledWith(APP_NAME)
    // setName must run before whenReady is awaited, not inside its callback.
    expect(setName.mock.invocationCallOrder[0]).toBeLessThan(
      whenReady.mock.invocationCallOrder[0]
    )
  })

  it('wires the userData seam from getPath, after setName and before whenReady', async () => {
    await import('./index')

    expect(getPath).toHaveBeenCalledWith('userData')
    // The profile dir must resolve AFTER setName (it derives from the app name)
    // and BEFORE ready, so every consumer of the seam sees the final location.
    expect(setName.mock.invocationCallOrder[0]).toBeLessThan(
      getPath.mock.invocationCallOrder[0]
    )
    expect(getPath.mock.invocationCallOrder[0]).toBeLessThan(
      whenReady.mock.invocationCallOrder[0]
    )
  })

  it('pins scrollbars to the slim auto-hiding overlay style before whenReady (macOS only)', async () => {
    await import('./index')

    if (process.platform === 'darwin') {
      // Overrides the app's own AppleShowScrollBars default so an OS "Always"
      // setting can't force the chunky, never-hiding legacy bar. Must land before
      // ready, since Chromium reads the scroller style when a render process boots.
      expect(setUserDefault).toHaveBeenCalledWith('AppleShowScrollBars', 'string', 'WhenScrolling')
      expect(setUserDefault.mock.invocationCallOrder[0]).toBeLessThan(
        whenReady.mock.invocationCallOrder[0]
      )
    } else {
      // The key is macOS-only; other platforms leave scrollbars untouched.
      expect(setUserDefault).not.toHaveBeenCalled()
    }
  })
})
