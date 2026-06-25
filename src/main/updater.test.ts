import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/constants'
import { RELEASE_HIGHLIGHTS } from '@shared/update'

/**
 * The updater touches electron (`app`, `BrowserWindow`), electron-updater, and the
 * persisted update-state. All three are stubbed via the hoisted `h` state so each
 * test drives version / packaged / feed-result and inspects what got broadcast or
 * recorded. The module keeps top-level state (the staged "What's new", the
 * configured-once flag), so every test imports it fresh via `vi.resetModules()`.
 */
const h = vi.hoisted(() => ({
  isPackaged: true,
  version: '0.2.0',
  sent: [] as Array<{ channel: string; payload: unknown }>,
  checkResult: null as unknown,
  checkError: null as Error | null,
  lastSeen: null as string | null,
  written: [] as string[]
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.isPackaged
    },
    getVersion: () => h.version
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => h.sent.push({ channel, payload })
        }
      }
    ]
  }
}))

vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      on: () => {},
      checkForUpdates: async () => {
        if (h.checkError) throw h.checkError
        return h.checkResult
      }
    }
  }
}))

vi.mock('./update-state', () => ({
  readLastSeenVersion: () => h.lastSeen,
  writeLastSeenVersion: (v: string) => h.written.push(v)
}))

async function load(): Promise<typeof import('./updater')> {
  vi.resetModules()
  return import('./updater')
}

beforeEach(() => {
  h.isPackaged = true
  h.version = '0.2.0'
  h.sent = []
  h.checkResult = null
  h.checkError = null
  h.lastSeen = null
  h.written = []
})

describe('checkForUpdates', () => {
  it('reports an available update and broadcasts it to open windows', async () => {
    h.checkResult = {
      isUpdateAvailable: true,
      updateInfo: { version: '0.3.0', releaseNotes: 'Faster search' }
    }
    const { checkForUpdates } = await load()
    const result = await checkForUpdates()

    expect(result).toMatchObject({
      status: 'available',
      currentVersion: '0.2.0',
      latestVersion: '0.3.0',
      notes: 'Faster search'
    })
    expect(result.status === 'available' && result.releaseUrl).toContain('github.com')

    const broadcasts = h.sent.filter((s) => s.channel === IPC.updateAvailable)
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0].payload).toMatchObject({ status: 'available', latestVersion: '0.3.0' })
  })

  it('reports up-to-date without broadcasting when no newer version exists', async () => {
    h.checkResult = { isUpdateAvailable: false, updateInfo: { version: '0.2.0' } }
    const { checkForUpdates } = await load()
    const result = await checkForUpdates()

    expect(result).toEqual({ status: 'up-to-date', currentVersion: '0.2.0' })
    expect(h.sent.filter((s) => s.channel === IPC.updateAvailable)).toHaveLength(0)
  })

  it('reports disabled for unpackaged builds and never hits the feed', async () => {
    h.isPackaged = false
    const { checkForUpdates } = await load()
    expect(await checkForUpdates()).toEqual({ status: 'disabled', currentVersion: '0.2.0' })
  })

  it('reports an error (not throws) when the feed check fails', async () => {
    h.checkError = new Error('feed unreachable')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { checkForUpdates } = await load()
    const result = await checkForUpdates()

    expect(result).toEqual({
      status: 'error',
      currentVersion: '0.2.0',
      message: 'feed unreachable'
    })
  })

  it('flattens array-form release notes', async () => {
    h.checkResult = {
      isUpdateAvailable: true,
      updateInfo: {
        version: '0.3.0',
        releaseNotes: [{ version: '0.3.0', note: 'Line A' }, { version: '0.3.0', note: 'Line B' }]
      }
    }
    const { checkForUpdates } = await load()
    const result = await checkForUpdates()
    expect(result.status === 'available' && result.notes).toBe('Line A\nLine B')
  })
})

describe('initUpdates / takePendingWhatsNew', () => {
  it('stages the "What\'s new" popup once after an upgrade, then records the version', async () => {
    h.isPackaged = false // skip the network check; exercise only the what's-new path
    h.version = '0.1.0' // a version that has bundled highlights
    h.lastSeen = '0.0.9'
    const { initUpdates, takePendingWhatsNew } = await load()
    initUpdates()

    expect(takePendingWhatsNew()).toEqual({
      version: '0.1.0',
      highlights: RELEASE_HIGHLIGHTS['0.1.0']
    })
    // One-shot: a second read yields nothing.
    expect(takePendingWhatsNew()).toBeNull()
    // The new version is recorded so it won't show again next launch.
    expect(h.written).toContain('0.1.0')
  })

  it('does not stage anything on a fresh install, but records the version', async () => {
    h.isPackaged = false
    h.version = '0.1.0'
    h.lastSeen = null
    const { initUpdates, takePendingWhatsNew } = await load()
    initUpdates()

    expect(takePendingWhatsNew()).toBeNull()
    expect(h.written).toContain('0.1.0')
  })

  it('does nothing when re-running the same version', async () => {
    h.isPackaged = false
    h.version = '0.1.0'
    h.lastSeen = '0.1.0'
    const { initUpdates, takePendingWhatsNew } = await load()
    initUpdates()

    expect(takePendingWhatsNew()).toBeNull()
    expect(h.written).toHaveLength(0)
  })

  it('records an upgrade even when the new version has no authored highlights', async () => {
    h.isPackaged = false
    h.version = '9.9.9' // no entry in RELEASE_HIGHLIGHTS
    h.lastSeen = '0.1.0'
    const { initUpdates, takePendingWhatsNew } = await load()
    initUpdates()

    expect(takePendingWhatsNew()).toBeNull()
    expect(h.written).toContain('9.9.9')
  })
})
