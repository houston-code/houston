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
const h = vi.hoisted(() => {
  const self = {
    isPackaged: true,
    version: '0.2.0',
    sent: [] as Array<{ channel: string; payload: unknown }>,
    checkResult: null as unknown,
    checkError: null as Error | null,
    lastSeen: null as string | null,
    written: [] as string[],
    autoInstall: true,
    quitAndInstallCalls: 0,
    listeners: {} as Record<string, Array<(arg: unknown) => void>>,
    // Assigned below so the methods can close over `self`.
    autoUpdater: undefined as unknown as {
      autoDownload: boolean
      autoInstallOnAppQuit: boolean
      on: (event: string, cb: (arg: unknown) => void) => void
      checkForUpdates: () => Promise<unknown>
      quitAndInstall: () => void
    }
  }
  self.autoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on: (event, cb) => {
      ;(self.listeners[event] ??= []).push(cb)
    },
    checkForUpdates: async () => {
      if (self.checkError) throw self.checkError
      return self.checkResult
    },
    quitAndInstall: () => {
      self.quitAndInstallCalls++
    }
  }
  return self
})

/** Invoke every listener the updater registered for an electron-updater event. */
function fire(event: string, arg: unknown): void {
  for (const cb of h.listeners[event] ?? []) cb(arg)
}

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
  default: { autoUpdater: h.autoUpdater }
}))

// Keep the real update-policy behaviour but make the "may auto-install?" gate
// controllable, so the signed-macOS path can be exercised on Linux CI too (where the
// real `shouldAutoInstallUpdates` returns false because process.platform !== 'darwin').
vi.mock('./update-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./update-policy')>()
  return { ...actual, shouldAutoInstallUpdates: () => h.autoInstall }
})

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
  h.autoInstall = true
  h.quitAndInstallCalls = 0
  h.listeners = {}
  h.autoUpdater.autoDownload = false
  h.autoUpdater.autoInstallOnAppQuit = false
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
    // The manual-download link must point at the PUBLIC releases repo (the private
    // source repo has no published assets), not just any github.com URL.
    expect(result.status === 'available' && result.releaseUrl).toContain('houston-releases/releases')

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

describe('menuUpdateDialog', () => {
  it('offers a Download button pointing at the release for an available update', async () => {
    const { menuUpdateDialog } = await load()
    const { options, downloadUrl } = menuUpdateDialog({
      status: 'available',
      currentVersion: '0.2.0',
      latestVersion: '0.3.0',
      releaseUrl: 'https://example.com/releases'
    })
    expect(downloadUrl).toBe('https://example.com/releases')
    expect(options.buttons).toEqual(['Download', 'Later'])
    expect(options.defaultId).toBe(0)
    expect(options.message).toContain('0.3.0')
    expect(options.detail).toContain('0.2.0')
  })

  it('reports up-to-date with a single OK button and no download', async () => {
    const { menuUpdateDialog } = await load()
    const { options, downloadUrl } = menuUpdateDialog({
      status: 'up-to-date',
      currentVersion: '0.2.0'
    })
    expect(downloadUrl).toBeNull()
    expect(options.buttons).toEqual(['OK'])
    expect(options.detail).toContain('0.2.0')
  })

  it('explains the disabled (unpackaged) case', async () => {
    const { menuUpdateDialog } = await load()
    const { options, downloadUrl } = menuUpdateDialog({
      status: 'disabled',
      currentVersion: '0.2.0'
    })
    expect(downloadUrl).toBeNull()
    expect(options.message).toMatch(/packaged builds/i)
  })

  it('surfaces the failure message as a warning dialog', async () => {
    const { menuUpdateDialog } = await load()
    const { options, downloadUrl } = menuUpdateDialog({
      status: 'error',
      currentVersion: '0.2.0',
      message: 'feed unreachable'
    })
    expect(downloadUrl).toBeNull()
    expect(options.type).toBe('warning')
    expect(options.detail).toBe('feed unreachable')
  })
})

describe('auto-install (signed macOS)', () => {
  it('flags the available result + broadcast as auto-install', async () => {
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }
    const { checkForUpdates } = await load()
    const result = await checkForUpdates()
    expect(result).toMatchObject({ status: 'available', autoInstall: true })
    const broadcast = h.sent.find((s) => s.channel === IPC.updateAvailable)
    expect(broadcast?.payload).toMatchObject({ autoInstall: true })
  })

  it('enables autoDownload + autoInstallOnAppQuit', async () => {
    const { checkForUpdates } = await load()
    await checkForUpdates()
    expect(h.autoUpdater.autoDownload).toBe(true)
    expect(h.autoUpdater.autoInstallOnAppQuit).toBe(true)
  })

  it('broadcasts rounded download progress', async () => {
    const { checkForUpdates } = await load()
    await checkForUpdates() // configures the updater + attaches the event listeners
    fire('download-progress', { percent: 42.7, bytesPerSecond: 1000.6, transferred: 5, total: 10 })
    const progress = h.sent.filter((s) => s.channel === IPC.updateDownloadProgress)
    expect(progress).toHaveLength(1)
    expect(progress[0].payload).toEqual({
      percent: 43,
      bytesPerSecond: 1001,
      transferred: 5,
      total: 10
    })
  })

  it('broadcasts update-downloaded with the version', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { checkForUpdates } = await load()
    await checkForUpdates()
    fire('update-downloaded', { version: '0.3.0' })
    const done = h.sent.filter((s) => s.channel === IPC.updateDownloaded)
    expect(done).toHaveLength(1)
    expect(done[0].payload).toEqual({ version: '0.3.0' })
  })

  it('installUpdate quits and installs', async () => {
    const { installUpdate } = await load()
    installUpdate()
    expect(h.quitAndInstallCalls).toBe(1)
  })
})

describe('without auto-install (unsigned Windows/Linux)', () => {
  beforeEach(() => {
    h.autoInstall = false
  })

  it('marks the available result as not auto-install', async () => {
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }
    const { checkForUpdates } = await load()
    expect(await checkForUpdates()).toMatchObject({ status: 'available', autoInstall: false })
  })

  it('leaves autoDownload + autoInstallOnAppQuit off', async () => {
    const { checkForUpdates } = await load()
    await checkForUpdates()
    expect(h.autoUpdater.autoDownload).toBe(false)
    expect(h.autoUpdater.autoInstallOnAppQuit).toBe(false)
  })

  it('never wires or broadcasts progress/downloaded events', async () => {
    const { checkForUpdates } = await load()
    await checkForUpdates()
    fire('download-progress', { percent: 50, bytesPerSecond: 1, transferred: 1, total: 2 })
    fire('update-downloaded', { version: '0.3.0' })
    expect(h.sent.some((s) => s.channel === IPC.updateDownloadProgress)).toBe(false)
    expect(h.sent.some((s) => s.channel === IPC.updateDownloaded)).toBe(false)
  })

  it('installUpdate is a no-op', async () => {
    const { installUpdate } = await load()
    installUpdate()
    expect(h.quitAndInstallCalls).toBe(0)
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
