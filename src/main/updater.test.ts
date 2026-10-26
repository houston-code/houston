import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/constants'

// The bundled "What's new" text is generated from CHANGELOG.md for the running version;
// pin it so these tests stay independent of the changelog's contents.
const WHATS_NEW = 'A short summary of the release.'
vi.mock('@shared/release-highlights', () => ({
  RELEASE_SUMMARY: { version: '0.1.0', summary: 'A short summary of the release.' }
}))

/**
 * The updater touches electron (`app`, `BrowserWindow`, and the native `autoUpdater`,
 * i.e. Squirrel.Mac), electron-updater, and the persisted update-state. All three are stubbed via the hoisted `h` state so each
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
    /** `autoDownload` as each feed check saw it (true = electron-updater downloads). */
    checkAutoDownload: [] as boolean[],
    dialogResponses: [] as number[],
    dialogs: [] as Array<Record<string, unknown>>,
    opened: [] as string[],
    listeners: {} as Record<string, Array<(arg: unknown) => void>>,
    /** Listeners on Electron's native autoUpdater (Squirrel.Mac's verdict events). */
    nativeListeners: {} as Record<string, Array<(arg?: unknown) => void>>,
    // Assigned below so the methods can close over `self`.
    autoUpdater: undefined as unknown as {
      autoDownload: boolean
      autoInstallOnAppQuit: boolean
      on: (event: string, cb: (arg: unknown) => void) => void
      checkForUpdates: () => Promise<unknown>
      downloadUpdate: (token?: unknown) => Promise<unknown>
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
      self.checkAutoDownload.push(self.autoUpdater.autoDownload)
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

/** Deliver Squirrel.Mac's verdict: an `update-downloaded` (accepted) or `error` (refused). */
function fireNative(event: 'update-downloaded' | 'error', arg?: unknown): void {
  for (const cb of h.nativeListeners[event] ?? []) cb(arg)
}

/** The refusal Squirrel.Mac reports for a release signed by a different Apple team. */
const SIGNATURE_MISMATCH = new Error(
  'Code signature at URL file:///tmp/Houston.app did not pass validation: code failed to satisfy specified code requirement(s)'
)

vi.mock('electron', () => ({
  autoUpdater: {
    on: (event: string, cb: (arg?: unknown) => void) => {
      ;(h.nativeListeners[event] ??= []).push(cb)
    }
  },
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

/** Stand-in for electron-updater's CancellationToken: cancel() runs what's registered. */
class FakeToken {
  cancelled = false
  onCancel: () => void = () => {}
  cancel(): void {
    this.cancelled = true
    this.onCancel()
  }
}

/** A download that never finishes on its own and rejects once its token is cancelled,
 *  the way electron-updater's does. */
function cancellableDownload(token = new FakeToken()): {
  token: FakeToken
  promise: Promise<unknown>
} {
  const promise = new Promise((_resolve, reject) => {
    token.onCancel = () => reject(new Error('cancelled'))
  })
  return { token, promise }
}

/** An available update whose background download can be cancelled. */
function availableWithDownload(): { token: FakeToken; promise: Promise<unknown> } {
  const download = cancellableDownload()
  h.checkResult = {
    isUpdateAvailable: true,
    updateInfo: { version: '0.3.0' },
    downloadPromise: download.promise,
    cancellationToken: download.token
  }
  return download
}

vi.mock('electron-updater', () => ({
  default: { autoUpdater: h.autoUpdater, CancellationToken: FakeToken }
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
  h.checkAutoDownload = []
  h.dialogResponses = []
  h.dialogs = []
  h.opened = []
  h.listeners = {}
  h.nativeListeners = {}
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
    // The manual-download link goes to the website's download section, never a raw
    // list of release assets.
    expect(result.status === 'available' && result.releaseUrl).toBe('https://houstoncode.ai/#download')

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

  it('falls back to the download page where auto-install is unavailable', async () => {
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

  it('auto-downloads on every check until an update is staged', async () => {
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }
    const { checkForUpdates } = await load()
    await checkForUpdates()
    await checkForUpdates() // e.g. the first download failed: the next check retries it
    expect(h.checkAutoDownload).toEqual([true, true])
    expect(h.downloadUpdateCalls).toBe(0) // electron-updater's own download, not a manual one
  })

  it('keeps auto-downloading after a refusal, so a later check can retry in place', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }
    const { checkForUpdates } = await load()
    await checkForUpdates()
    fire('update-downloaded', { version: '0.3.0' })
    fireNative('error', SIGNATURE_MISMATCH)
    await checkForUpdates()
    expect(h.checkAutoDownload).toEqual([true, true])
    expect(h.downloadUpdateCalls).toBe(0)
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

  it('broadcasts update-downloaded only once Squirrel.Mac accepts the download', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { checkForUpdates } = await load()
    await checkForUpdates()
    // electron-updater says "downloaded" before Squirrel has checked the signature.
    fire('update-downloaded', { version: '0.3.0' })
    expect(h.sent.some((s) => s.channel === IPC.updateDownloaded)).toBe(false)
    fireNative('update-downloaded')
    const done = h.sent.filter((s) => s.channel === IPC.updateDownloaded)
    expect(done).toHaveLength(1)
    expect(done[0].payload).toEqual({ version: '0.3.0' })
    expect(h.sent.some((s) => s.channel === IPC.updateInstallFailed)).toBe(false)
  })

  it('offers the download page instead of a restart when Squirrel.Mac refuses it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { checkForUpdates } = await load()
    await checkForUpdates()
    fire('update-downloaded', { version: '0.3.0' })
    fireNative('error', SIGNATURE_MISMATCH)
    const failed = h.sent.filter((s) => s.channel === IPC.updateInstallFailed)
    expect(failed).toHaveLength(1)
    expect(failed[0].payload).toEqual({
      version: '0.3.0',
      releaseUrl: 'https://houstoncode.ai/#download'
    })
    expect(h.sent.some((s) => s.channel === IPC.updateDownloaded)).toBe(false)
  })

  it('reports a refused version as a manual download on later checks', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }
    const { checkForUpdates } = await load()
    expect(await checkForUpdates()).toMatchObject({ autoInstall: true })
    fire('update-downloaded', { version: '0.3.0' })
    fireNative('error', SIGNATURE_MISMATCH)

    expect(await checkForUpdates()).toMatchObject({ latestVersion: '0.3.0', autoInstall: false })
    const last = h.sent.filter((s) => s.channel === IPC.updateAvailable).at(-1)
    expect(last?.payload).toMatchObject({ autoInstall: false })

    // A newer release gets its own in-place attempt.
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.1' } }
    expect(await checkForUpdates()).toMatchObject({ latestVersion: '0.3.1', autoInstall: true })
  })

  it('offers Restart to install again if Squirrel.Mac later accepts a refused version', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }
    const { checkForUpdates } = await load()
    await checkForUpdates()
    fire('update-downloaded', { version: '0.3.0' })
    fireNative('error', new Error('Could not unzip the update'))

    // The next check re-hands the cached download to Squirrel, and this time it passes.
    await checkForUpdates()
    fire('update-downloaded', { version: '0.3.0' })
    fireNative('update-downloaded')
    const done = h.sent.filter((s) => s.channel === IPC.updateDownloaded)
    expect(done.map((s) => s.payload)).toEqual([{ version: '0.3.0' }])
    expect(await checkForUpdates()).toMatchObject({ autoInstall: true })
  })

  it('ignores Squirrel.Mac events when no download is waiting on its verdict', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { checkForUpdates } = await load()
    await checkForUpdates()
    fireNative('error', new Error('unrelated'))
    fireNative('update-downloaded')
    expect(h.sent.some((s) => s.channel === IPC.updateInstallFailed)).toBe(false)
    expect(h.sent.some((s) => s.channel === IPC.updateDownloaded)).toBe(false)
  })

  it('re-checks without re-downloading once an update is staged', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }
    const { checkForUpdates } = await load()
    await checkForUpdates()
    fire('update-downloaded', { version: '0.3.0' })
    fireNative('update-downloaded')
    expect(await checkForUpdates()).toMatchObject({ status: 'available', autoInstall: true })
    expect(h.checkAutoDownload).toEqual([true, false])
    expect(h.downloadUpdateCalls).toBe(0)
    expect(h.autoUpdater.autoDownload).toBe(true) // restored for the next check
  })

  it('re-checks without re-downloading while Squirrel.Mac is verifying', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }
    const { checkForUpdates } = await load()
    await checkForUpdates()
    fire('update-downloaded', { version: '0.3.0' })
    await checkForUpdates()
    expect(h.checkAutoDownload).toEqual([true, false])
    expect(h.downloadUpdateCalls).toBe(0)
  })

  it('downloads a release newer than the staged one', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }
    const { checkForUpdates } = await load()
    await checkForUpdates()
    fire('update-downloaded', { version: '0.3.0' })
    fireNative('update-downloaded')
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.1' } }
    await checkForUpdates()
    expect(h.downloadUpdateCalls).toBe(1)
  })

  it('installUpdate waits for Squirrel.Mac to finish verifying', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { checkForUpdates, installUpdate } = await load()
    await checkForUpdates()
    fire('update-downloaded', { version: '0.3.0' })
    const done = installUpdate()
    await new Promise((r) => setTimeout(r, 0))
    expect(h.quitAndInstallCalls).toBe(0)
    fireNative('update-downloaded')
    expect(await done).toBe(true)
    expect(h.quitAndInstallCalls).toBe(1)
  })

  it('installUpdate gives up when Squirrel.Mac refuses the download', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { checkForUpdates, installUpdate } = await load()
    await checkForUpdates()
    fire('update-downloaded', { version: '0.3.0' })
    const done = installUpdate()
    fireNative('error', SIGNATURE_MISMATCH)
    expect(await done).toBe(false)
    expect(h.quitAndInstallCalls).toBe(0)
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
    expect(h.checkAutoDownload).toEqual([true])
  })

  it('installs right away when the update is already downloaded', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }
    const { checkForUpdates, checkForUpdatesFromMenu } = await load()
    await checkForUpdates()
    fire('update-downloaded', { version: '0.3.0' })
    fireNative('update-downloaded')
    h.dialogResponses = [0]
    await checkForUpdatesFromMenu()
    expect(h.quitAndInstallCalls).toBe(1)
    expect(h.downloadUpdateCalls).toBe(0)
    // The menu's own check must not re-hand the staged update to Squirrel.Mac.
    expect(h.checkAutoDownload).toEqual([true, false])
  })

  it('waits for a newer release to verify instead of installing the staged one', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }
    const { checkForUpdates, checkForUpdatesFromMenu } = await load()
    await checkForUpdates()
    fire('update-downloaded', { version: '0.3.0' })
    fireNative('update-downloaded')

    let finish!: () => void
    const original = h.autoUpdater.downloadUpdate
    h.autoUpdater.downloadUpdate = () => {
      h.downloadUpdateCalls++
      return new Promise((r) => (finish = () => r([])))
    }
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.1' } }
    h.dialogResponses = [0] // Update
    try {
      const done = checkForUpdatesFromMenu()
      await new Promise((r) => setTimeout(r, 0))
      expect(h.downloadUpdateCalls).toBe(1)
      fire('update-downloaded', { version: '0.3.1' })
      finish()
      await new Promise((r) => setTimeout(r, 0))
      expect(h.quitAndInstallCalls).toBe(0) // Squirrel is still checking 0.3.1
      fireNative('update-downloaded')
      await done
    } finally {
      h.autoUpdater.downloadUpdate = original
    }
    expect(h.quitAndInstallCalls).toBe(1)
  })

  it('waits for Squirrel.Mac to verify the download before installing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
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
    // electron-updater hands the file to Squirrel, then settles its download.
    fire('update-downloaded', { version: '0.3.0' })
    finish()
    await new Promise((r) => setTimeout(r, 0))
    expect(h.quitAndInstallCalls).toBe(0) // Squirrel is still checking the signature
    fireNative('update-downloaded')
    await done
    expect(h.quitAndInstallCalls).toBe(1)
    expect(h.opened).toEqual([])
  })

  it('offers the download page when macOS refuses the update', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let finish!: () => void
    const download = new Promise<void>((r) => (finish = r))
    h.checkResult = {
      isUpdateAvailable: true,
      updateInfo: { version: '0.3.0' },
      downloadPromise: download
    }
    h.dialogResponses = [0, 0] // Update, then "Open download page"
    const { checkForUpdatesFromMenu } = await load()
    const done = checkForUpdatesFromMenu()
    await new Promise((r) => setTimeout(r, 0))
    fire('update-downloaded', { version: '0.3.0' })
    finish()
    await new Promise((r) => setTimeout(r, 0))
    fireNative('error', SIGNATURE_MISMATCH)
    await done
    expect(h.quitAndInstallCalls).toBe(0)
    expect(h.dialogs[1]).toMatchObject({
      message: 'Couldn’t install the update.',
      detail: 'You can download the new version from the website instead.'
    })
    expect(JSON.stringify(h.dialogs[1])).not.toContain('code requirement')
    expect(h.opened).toEqual(['https://houstoncode.ai/#download'])
  })

  it('sends a version macOS already refused straight to the download page', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }
    const { checkForUpdates, checkForUpdatesFromMenu } = await load()
    await checkForUpdates()
    fire('update-downloaded', { version: '0.3.0' })
    fireNative('error', SIGNATURE_MISMATCH)
    h.dialogResponses = [0] // Update
    await checkForUpdatesFromMenu()
    expect(h.dialogs[0]).toMatchObject({ detail: expect.stringMatching(/download page/i) })
    expect(h.downloadUpdateCalls).toBe(0)
    expect(h.quitAndInstallCalls).toBe(0)
    expect(h.opened).toEqual(['https://houstoncode.ai/#download'])
  })

  it('starts a download when none is in flight, then installs', async () => {
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }
    h.dialogResponses = [0]
    const { checkForUpdatesFromMenu } = await load()
    await checkForUpdatesFromMenu()
    expect(h.downloadUpdateCalls).toBe(1)
    expect(h.quitAndInstallCalls).toBe(1)
    expect(h.checkAutoDownload).toEqual([true])
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

  it('offers the website download page when the download fails', async () => {
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
    expect(h.opened).toEqual(['https://houstoncode.ai/#download'])
  })

  it('opens the website download page instead of installing on unsigned builds', async () => {
    h.autoInstall = false
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }
    h.dialogResponses = [0]
    const { checkForUpdatesFromMenu } = await load()
    await checkForUpdatesFromMenu()
    expect(h.quitAndInstallCalls).toBe(0)
    expect(h.opened).toEqual(['https://houstoncode.ai/#download'])
  })
})

describe('cancelDownload (the banner close button)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('cancels the background download a check started', async () => {
    const download = availableWithDownload()
    const { cancelDownload, checkForUpdates } = await load()
    await checkForUpdates()

    expect(cancelDownload()).toBe(true)
    expect(download.token.cancelled).toBe(true)
    await expect(download.promise).rejects.toThrow('cancelled')
    // Nothing is left to cancel, and nothing was handed over to install on quit.
    expect(cancelDownload()).toBe(false)
    expect(h.sent.some((s) => s.channel === IPC.updateDownloaded)).toBe(false)
  })

  it('does nothing when no download is running', async () => {
    h.checkResult = { isUpdateAvailable: false, updateInfo: { version: '0.2.0' } }
    const { cancelDownload, checkForUpdates } = await load()
    expect(cancelDownload()).toBe(false)
    await checkForUpdates()
    expect(cancelDownload()).toBe(false)
  })

  it('leaves a download alone once it is handed to Squirrel.Mac', async () => {
    const download = availableWithDownload()
    const { cancelDownload, checkForUpdates } = await load()
    await checkForUpdates()
    fire('update-downloaded', { version: '0.3.0' })

    // Squirrel is verifying it, and will install it on quit whatever we do now.
    expect(cancelDownload()).toBe(false)
    fireNative('update-downloaded')
    expect(cancelDownload()).toBe(false)
    expect(download.token.cancelled).toBe(false)
  })

  it('lets the next check download the update again', async () => {
    const first = availableWithDownload()
    const { cancelDownload, checkForUpdates } = await load()
    await checkForUpdates()
    cancelDownload()
    await first.promise.catch(() => {})

    const second = availableWithDownload()
    await checkForUpdates()
    expect(h.sent.filter((s) => s.channel === IPC.updateAvailable)).toHaveLength(2)
    expect(cancelDownload()).toBe(true)
    expect(second.token.cancelled).toBe(true)
  })

  it('still cancels the download after another check while it runs', async () => {
    const download = availableWithDownload()
    const { cancelDownload, checkForUpdates } = await load()
    await checkForUpdates()

    // electron-updater returns the running download again, with a new token it never uses.
    const unused = new FakeToken()
    h.checkResult = { ...(h.checkResult as object), cancellationToken: unused }
    await checkForUpdates()

    expect(cancelDownload()).toBe(true)
    expect(download.token.cancelled).toBe(true)
    await expect(download.promise).rejects.toThrow('cancelled')
  })

  it('stops a menu Update that is waiting on the download, without an error dialog', async () => {
    availableWithDownload()
    h.dialogResponses = [0] // Update
    const { cancelDownload, checkForUpdatesFromMenu } = await load()
    const done = checkForUpdatesFromMenu()
    await new Promise((r) => setTimeout(r, 0))

    expect(cancelDownload()).toBe(true)
    await done
    expect(h.quitAndInstallCalls).toBe(0)
    expect(h.dialogs).toHaveLength(1) // just the "Update available" prompt
    expect(h.opened).toEqual([])
  })

  it('can cancel a download the menu started itself', async () => {
    h.checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }
    let started: FakeToken | null = null
    const original = h.autoUpdater.downloadUpdate
    h.autoUpdater.downloadUpdate = (token) => {
      started = token as FakeToken
      return cancellableDownload(started).promise
    }
    h.dialogResponses = [0] // Update
    const { cancelDownload, checkForUpdatesFromMenu } = await load()
    try {
      const done = checkForUpdatesFromMenu()
      await new Promise((r) => setTimeout(r, 0))
      expect(started).toBeInstanceOf(FakeToken)
      expect(cancelDownload()).toBe(true)
      await done
    } finally {
      h.autoUpdater.downloadUpdate = original
    }
    expect(started!.cancelled).toBe(true)
    expect(h.quitAndInstallCalls).toBe(0)
    expect(h.dialogs).toHaveLength(1)
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
    expect(h.checkAutoDownload).toEqual([false])
    expect(h.autoUpdater.autoInstallOnAppQuit).toBe(false)
  })

  it('never wires or broadcasts progress/downloaded events', async () => {
    const { checkForUpdates } = await load()
    await checkForUpdates()
    fire('download-progress', { percent: 50, bytesPerSecond: 1, transferred: 1, total: 2 })
    fire('update-downloaded', { version: '0.3.0' })
    expect(h.sent.some((s) => s.channel === IPC.updateDownloadProgress)).toBe(false)
    expect(h.sent.some((s) => s.channel === IPC.updateDownloaded)).toBe(false)
    // Squirrel.Mac is never involved off signed macOS.
    expect(h.nativeListeners).toEqual({})
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
