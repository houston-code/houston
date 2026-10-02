import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/constants'

// The bundled "What's new" text is generated from CHANGELOG.md for the running version;
// pin it so these tests stay independent of the changelog's contents.
const WHATS_NEW = 'A short summary of the release.'
vi.mock('@shared/release-highlights', () => ({
  RELEASE_SUMMARY: { version: '0.1.0', summary: 'A short summary of the release.' }
}))

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
    downloadUpdateCalls: 0,
    dialogResponses: [] as number[],
    dialogs: [] as Array<Record<string, unknown>>,
    opened: [] as string[],
    listeners: {} as Record<string, Array<(arg: unknown) => void>>,
    // Assigned below so the methods can close over `self`.
    autoUpdater: undefined as unknown as {
      autoDownload: boolean
      autoInstallOnAppQuit: boolean
      on: (event: string, cb: (arg: unknown) => void) => void
      checkForUpdates: () => Promise<unknown>
      downloadUpdate: () => Promise<unknown>
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
    downloadUpdate: async () => {
      self.downloadUpdateCalls++
      return []
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
  dialog: {
    showMessageBox: async (...args: unknown[]) => {
      h.dialogs.push(args[args.length - 1] as Record<string, unknown>)
      return { response: h.dialogResponses.shift() ?? 1 }
    }
  },
  BrowserWindow: {
    getFocusedWindow: () => null,
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

vi.mock('./safeExternal', () => ({
  openExternalSafely: (url: string) => h.opened.push(url)
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
  h.autoInstall = true
  h.quitAndInstallCalls = 0
  h.downloadUpdateCalls = 0
  h.dialogResponses = []
  h.dialogs = []
  h.opened = []
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
    expect(result.status === 'available' && result.releaseUrl).toContain('houston-code/houston/releases')

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
  it('offers an Update button that installs in place on auto-install builds', async () => {
    const { menuUpdateDialog } = await load()
    const { options, action } = menuUpdateDialog({
      status: 'available',
      currentVersion: '0.2.0',
      latestVersion: '0.3.0',
      releaseUrl: 'https://example.com/releases',
      autoInstall: true
    })
    expect(action).toEqual({ kind: 'install' })
    expect(options.buttons).toEqual(['Update', 'Later'])
    expect(options.defaultId).toBe(0)
    expect(options.message).toContain('0.3.0')
    expect(options.detail).toContain('0.2.0')
    expect(options.detail).toMatch(/restart to install/i)
  })

  it('falls back to the Releases page where auto-install is unavailable', async () => {
    const { menuUpdateDialog } = await load()
    const { options, action } = menuUpdateDialog({
      status: 'available',
      currentVersion: '0.2.0',
      latestVersion: '0.3.0',
      releaseUrl: 'https://example.com/releases',
      autoInstall: false
    })
    expect(action).toEqual({ kind: 'open', url: 'https://example.com/releases' })
    expect(options.buttons).toEqual(['Update', 'Later'])
    expect(options.detail).toMatch(/download page/i)
  })

  it('reports up-to-date with a single OK button and no download', async () => {
    const { menuUpdateDialog } = await load()
    const { options, action } = menuUpdateDialog({
      status: 'up-to-date',
      currentVersion: '0.2.0'
    })
    expect(action).toBeNull()
    expect(options.buttons).toEqual(['OK'])
    expect(options.detail).toContain('0.2.0')
  })

  it('explains the disabled (unpackaged) case', async () => {
    const { menuUpdateDialog } = await load()
    const { options, action } = menuUpdateDialog({
      status: 'disabled',
      currentVersion: '0.2.0'
    })
    expect(action).toBeNull()
    expect(options.message).toMatch(/packaged builds/i)
  })

  it('surfaces the failure message as a warning dialog', async () => {
    const { menuUpdateDialog } = await load()
    const { options, action } = menuUpdateDialog({
      status: 'error',
      currentVersion: '0.2.0',
      message: 'feed unreachable'
    })
    expect(action).toBeNull()
    expect(options.type).toBe('warning')
    expect(options.message).toBe('Couldn’t check for updates.')
    // Not a network error: no hint, and never the raw error text.
    expect(options.detail).toBeUndefined()
  })

  it('shows a connection hint, not the raw error, when offline', async () => {
    const { menuUpdateDialog } = await load()
    const { options } = menuUpdateDialog({
      status: 'error',
      currentVersion: '0.3.0',
      message: 'net::ERR_NAME_NOT_RESOLVED'
    })
    expect(options.detail).toBe('Check your internet connection and try again.')
    expect(JSON.stringify(options)).not.toContain('ERR_NAME_NOT_RESOLVED')
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
    expect(await installUpdate()).toBe(true)
    expect(h.quitAndInstallCalls).toBe(1)
  })

  it('installUpdate asks the install guard first and stops when it declines', async () => {
    const { installUpdate, setInstallGuard } = await load()
    const guard = vi.fn(async () => false)
    setInstallGuard(guard)
    expect(await installUpdate()).toBe(false)
    expect(guard).toHaveBeenCalledOnce()
    expect(h.quitAndInstallCalls).toBe(0)
  })

  it('installUpdate proceeds when the guard approves', async () => {
    const { installUpdate, setInstallGuard } = await load()
    setInstallGuard(async () => true)
    expect(await installUpdate()).toBe(true)
    expect(h.quitAndInstallCalls).toBe(1)
  })

  it('undoes the confirmation when quitAndInstall throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { installUpdate, setInstallGuard } = await load()
    const aborted = vi.fn()
    setInstallGuard(async () => true, aborted)
    const original = h.autoUpdater.quitAndInstall
    h.autoUpdater.quitAndInstall = () => {
      throw new Error('boom')
    }
    try {
      expect(await installUpdate()).toBe(false)
    } finally {
      h.autoUpdater.quitAndInstall = original
    }
    expect(aborted).toHaveBeenCalledOnce()
  })
})

describe('checkForUpdatesFromMenu', () => {
  it('installs once the in-flight background download finishes', async () => {
    let finish!: () => void
    const download = new Promise<void>((r) => (finish = r))
    h.checkResult = {
      isUpdateAvailable: true,
      updateInfo: { version: '0.3.0' },
      downloadPromise: download
    }
    h.dialogResponses = [0] // Update
    const { checkForUpdatesFromMenu } = await load()
    const done = checkForUpdatesFromMenu()
    await new Promise((r) => setTimeout(r, 0))
    expect(h.quitAndInstallCalls).toBe(0) // still downloading
    finish()
    await done
    expect(h.quitAndInstallCalls).toBe(1)
    expect(h.downloadUpdateCalls).toBe(0)
    expect(h.opened).toEqual([])
  })

  it('installs right away when the update is already downloaded', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }
    const { checkForUpdates, checkForUpdatesFromMenu } = await load()
    await checkForUpdates()
    fire('update-downloaded', { version: '0.3.0' })
    h.dialogResponses = [0]
    await checkForUpdatesFromMenu()
    expect(h.quitAndInstallCalls).toBe(1)
    expect(h.downloadUpdateCalls).toBe(0)
  })

  it('starts a download when none is in flight, then installs', async () => {
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }
    h.dialogResponses = [0]
    const { checkForUpdatesFromMenu } = await load()
    await checkForUpdatesFromMenu()
    expect(h.downloadUpdateCalls).toBe(1)
    expect(h.quitAndInstallCalls).toBe(1)
  })

  it('does nothing on Later', async () => {
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }
    h.dialogResponses = [1]
    const { checkForUpdatesFromMenu } = await load()
    await checkForUpdatesFromMenu()
    expect(h.quitAndInstallCalls).toBe(0)
    expect(h.downloadUpdateCalls).toBe(0)
    expect(h.opened).toEqual([])
  })

  it('offers the Releases page when the download fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // The background download failed earlier, so Update retries it, and that fails too.
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }
    const original = h.autoUpdater.downloadUpdate
    h.autoUpdater.downloadUpdate = async () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED')
    }
    h.dialogResponses = [0, 0] // Update, then "Open download page"
    const { checkForUpdatesFromMenu } = await load()
    try {
      await checkForUpdatesFromMenu()
    } finally {
      h.autoUpdater.downloadUpdate = original
    }
    expect(h.quitAndInstallCalls).toBe(0)
    expect(h.dialogs[1]).toMatchObject({ message: 'Couldn’t download the update.' })
    expect(h.opened).toEqual(['https://github.com/houston-code/houston/releases'])
  })

  it('opens the Releases page instead of installing on unsigned builds', async () => {
    h.autoInstall = false
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }
    h.dialogResponses = [0]
    const { checkForUpdatesFromMenu } = await load()
    await checkForUpdatesFromMenu()
    expect(h.quitAndInstallCalls).toBe(0)
    expect(h.opened).toEqual(['https://github.com/houston-code/houston/releases'])
  })
})

describe('check scheduling', () => {
  it('shares one in-flight check between concurrent callers', async () => {
    let calls = 0
    const original = h.autoUpdater.checkForUpdates
    h.autoUpdater.checkForUpdates = async () => {
      calls++
      await new Promise((r) => setTimeout(r, 0))
      return null
    }
    try {
      const { checkForUpdates } = await load()
      const [a, b] = await Promise.all([checkForUpdates(), checkForUpdates()])
      expect(calls).toBe(1)
      expect(a).toEqual(b)
      await checkForUpdates() // a later call runs a fresh check
      expect(calls).toBe(2)
    } finally {
      h.autoUpdater.checkForUpdates = original
    }
  })

  it('re-checks every 6 hours after the launch check', async () => {
    vi.useFakeTimers()
    let calls = 0
    const original = h.autoUpdater.checkForUpdates
    h.autoUpdater.checkForUpdates = async () => {
      calls++
      return null
    }
    try {
      const { initUpdates, UPDATE_CHECK_INTERVAL_MS } = await load()
      expect(UPDATE_CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000)
      initUpdates()
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBe(1) // launch check
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toBe(2)
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
      expect(calls).toBe(3)
    } finally {
      h.autoUpdater.checkForUpdates = original
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('schedules nothing in an unpackaged build', async () => {
    vi.useFakeTimers()
    h.isPackaged = false
    let calls = 0
    const original = h.autoUpdater.checkForUpdates
    h.autoUpdater.checkForUpdates = async () => {
      calls++
      return null
    }
    try {
      const { initUpdates, UPDATE_CHECK_INTERVAL_MS } = await load()
      initUpdates()
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2)
      expect(calls).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      h.autoUpdater.checkForUpdates = original
      vi.useRealTimers()
    }
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
    expect(await installUpdate()).toBe(false)
    expect(h.quitAndInstallCalls).toBe(0)
  })
})

describe('initUpdates / takePendingWhatsNew', () => {
  it('stages the "What\'s new" popup once after an upgrade, then records the version', async () => {
    h.isPackaged = false // skip the network check; exercise only the what's-new path
    h.version = '0.1.0' // the version the bundled summary is for
    h.lastSeen = '0.0.9'
    const { initUpdates, takePendingWhatsNew } = await load()
    initUpdates()

    expect(takePendingWhatsNew()).toEqual({
      version: '0.1.0',
      highlights: WHATS_NEW
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
    h.version = '9.9.9' // not the version the bundled summary is for
    h.lastSeen = '0.1.0'
    const { initUpdates, takePendingWhatsNew } = await load()
    initUpdates()

    expect(takePendingWhatsNew()).toBeNull()
    expect(h.written).toContain('9.9.9')
  })
})
