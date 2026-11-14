import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { _electron as electron, test, type ElectronApplication } from '@playwright/test'

export const ROOT = join(__dirname, '..')

/** How long `close()` waits for a clean quit before killing the app. */
const CLOSE_TIMEOUT_MS = 15_000

/** Where a packaged app from `npm run dist*` lives in `release/`, per platform. */
export interface PackagedApp {
  /** What a copy of the app copies: the .app bundle on macOS, else the unpacked dir. */
  bundle: string
  /** The app's own executable. */
  executable: string
  /** Its resources dir: the asar, Resources/bin, and the license files. */
  resources: string
  /** The `release/` subdir it was found in, for the launch-mode annotation. */
  dir: string
}

/**
 * Locate the packaged app for the current platform, or null if none was built. macOS
 * output dirs carry the arch (mac-arm64, or mac for Intel); Windows and Linux use the
 * `*-unpacked` dir electron-builder leaves next to the installers.
 */
export function findPackagedApp(): PackagedApp | null {
  const release = join(ROOT, 'release')
  const candidates: PackagedApp[] = []
  if (process.platform === 'darwin') {
    for (const dir of ['mac-arm64', 'mac', 'mac-universal']) {
      const bundle = join(release, dir, 'Houston.app')
      const contents = join(bundle, 'Contents')
      candidates.push({
        bundle,
        executable: join(contents, 'MacOS', 'Houston'),
        resources: join(contents, 'Resources'),
        dir
      })
    }
  } else if (process.platform === 'win32') {
    const base = join(release, 'win-unpacked')
    candidates.push({
      bundle: base,
      executable: join(base, 'Houston.exe'),
      resources: join(base, 'resources'),
      dir: 'win-unpacked'
    })
  } else {
    // electron-builder names the Linux executable after package.json `name`.
    const base = join(release, 'linux-unpacked')
    candidates.push({
      bundle: base,
      executable: join(base, 'houston'),
      resources: join(base, 'resources'),
      dir: 'linux-unpacked'
    })
  }
  return candidates.find((c) => existsSync(c.executable)) ?? null
}

/**
 * Set by e2e/global-setup.ts to the executable of an inspectable copy of the packaged app,
 * when the packaged app's fuses refuse the Node inspector Playwright drives it through.
 */
export const LAUNCH_EXECUTABLE_ENV = 'HOUSTON_E2E_LAUNCH_EXECUTABLE'

export interface LaunchTarget {
  executablePath: string
  args: string[]
  /** Human-readable label, recorded as a test annotation. */
  mode: string
  packaged: boolean
}

/**
 * Decide what to launch. Prefer the packaged app: it runs the real artifact (the asar
 * archive, the afterPack-vendored binaries, the `app.isPackaged` code paths). Locally,
 * fall back to the unpackaged `out/` bundle from `npm run build` for fast runs. In CI
 * the package job always builds the app first, so a missing one is a failure there, not
 * a silent fallback that would leave the suite testing something other than the artifact.
 */
export function resolveLaunch(prefer: 'packaged' | 'unpackaged' = 'packaged'): LaunchTarget {
  if (prefer === 'unpackaged') return unpackagedTarget()
  const packaged = findPackagedApp()
  if (packaged) {
    // The copy differs from the artifact only in the inspector fuse (and, on macOS, an
    // ad-hoc signature); see inspectableCopy in fuses.ts.
    const copy = process.env[LAUNCH_EXECUTABLE_ENV]
    return {
      executablePath: copy ?? packaged.executable,
      args: [],
      mode: copy ? `packaged (${packaged.dir}, inspectable copy)` : `packaged (${packaged.dir})`,
      packaged: true
    }
  }
  if (process.env.CI) {
    throw new Error('No packaged app in release/ for this platform. Did `npm run dist*` run before the e2e suite?')
  }
  return unpackagedTarget()
}

/** The `out/` bundle from `npm run build`, run by the `electron` package's binary. */
function unpackagedTarget(): LaunchTarget {
  const main = join(ROOT, 'out', 'main', 'index.js')
  if (!existsSync(main)) throw new Error('No out/ bundle. Run `npm run build` first.')
  // In Node, importing `electron` yields the path to the executable, but its published
  // types describe the in-process API, so cast to use it as the launcher.
  return {
    executablePath: electronPath as unknown as string,
    args: [main],
    mode: 'unpackaged (out/)',
    packaged: false
  }
}

export interface LaunchOptions {
  /**
   * Reuse an existing userData dir (e.g. to relaunch over the state a previous launch
   * left). The caller then owns its cleanup. Omitted: a fresh throwaway dir is created
   * and removed by `close()`.
   */
  userDataDir?: string
  /** Extra environment for the app, layered over the test process's own. */
  env?: Record<string, string>
  /** Extra command-line switches for Electron, before the app's own arguments. */
  switches?: string[]
  /**
   * Launch the unpackaged `out/` bundle even where a packaged app exists (the memory
   * soak measures the app's code, and builds `out/` rather than installers). Default:
   * the packaged app, as described on resolveLaunch.
   */
  prefer?: 'packaged' | 'unpackaged'
}

export interface LaunchedApp {
  app: ElectronApplication
  userDataDir: string
  mode: string
  packaged: boolean
  /** Close the app, then remove the userData dir if this launch created it. */
  close(): Promise<void>
}

/**
 * Launch the app for a test. userData is always isolated: a boot writes settings,
 * window state and the credential store, which would otherwise land in the developer's
 * real profile. The updater is always off: a packaged build would otherwise query the
 * live release feed, making the suite depend on the network and on whatever is
 * published at the time.
 */
export async function launchApp(opts: LaunchOptions = {}): Promise<LaunchedApp> {
  const target = resolveLaunch(opts.prefer)
  test.info().annotations.push({ type: 'launch-mode', description: target.mode })
  const owned = opts.userDataDir === undefined
  const userDataDir = opts.userDataDir ?? mkdtempSync(join(tmpdir(), 'houston-e2e-'))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env[LAUNCH_EXECUTABLE_ENV]
  Object.assign(env, { HOUSTON_DISABLE_UPDATER: '1' }, opts.env)
  let app: ElectronApplication
  try {
    app = await electron.launch({
      executablePath: target.executablePath,
      args: [...(opts.switches ?? []), ...target.args, `--user-data-dir=${userDataDir}`],
      env
    })
  } catch (err) {
    if (owned) rmSync(userDataDir, { recursive: true, force: true })
    throw err
  }
  return {
    app,
    userDataDir,
    mode: target.mode,
    packaged: target.packaged,
    async close() {
      try {
        // A test that fails mid-turn leaves work running, and quitting with work running
        // raises the "Quit anyway?" confirmation that nothing here answers, so a plain
        // app.close() would hang until the worker is torn down and bury the real failure.
        // Give a clean quit a bounded window, then kill the process.
        let timer: NodeJS.Timeout | undefined
        const quit = app.close().then(() => true)
        const timedOut = new Promise<false>((r) => (timer = setTimeout(() => r(false), CLOSE_TIMEOUT_MS)))
        const closed = await Promise.race([quit, timedOut])
        clearTimeout(timer)
        if (!closed) {
          app.process().kill('SIGKILL')
          await quit.catch(() => {})
        }
      } finally {
        if (owned) rmSync(userDataDir, { recursive: true, force: true })
      }
    }
  }
}
