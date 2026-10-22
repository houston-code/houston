import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { _electron as electron, test, type ElectronApplication } from '@playwright/test'

export const ROOT = join(__dirname, '..')

/** Where a packaged app from `npm run dist*` lives in `release/`, per platform. */
interface PackagedApp {
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
      const contents = join(release, dir, 'Houston.app', 'Contents')
      candidates.push({ executable: join(contents, 'MacOS', 'Houston'), resources: join(contents, 'Resources'), dir })
    }
  } else if (process.platform === 'win32') {
    const base = join(release, 'win-unpacked')
    candidates.push({ executable: join(base, 'Houston.exe'), resources: join(base, 'resources'), dir: 'win-unpacked' })
  } else {
    // electron-builder names the Linux executable after package.json `name`.
    const base = join(release, 'linux-unpacked')
    candidates.push({ executable: join(base, 'houston'), resources: join(base, 'resources'), dir: 'linux-unpacked' })
  }
  return candidates.find((c) => existsSync(c.executable)) ?? null
}

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
export function resolveLaunch(): LaunchTarget {
  const packaged = findPackagedApp()
  if (packaged) {
    return { executablePath: packaged.executable, args: [], mode: `packaged (${packaged.dir})`, packaged: true }
  }
  if (process.env.CI) {
    throw new Error('No packaged app in release/ for this platform. Did `npm run dist*` run before the e2e suite?')
  }
  // In Node, importing `electron` yields the path to the executable, but its published
  // types describe the in-process API, so cast to use it as the launcher.
  return {
    executablePath: electronPath as unknown as string,
    args: [join(ROOT, 'out', 'main', 'index.js')],
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
  const target = resolveLaunch()
  test.info().annotations.push({ type: 'launch-mode', description: target.mode })
  const owned = opts.userDataDir === undefined
  const userDataDir = opts.userDataDir ?? mkdtempSync(join(tmpdir(), 'houston-e2e-'))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  Object.assign(env, { HOUSTON_DISABLE_UPDATER: '1' }, opts.env)
  let app: ElectronApplication
  try {
    app = await electron.launch({
      executablePath: target.executablePath,
      args: [...target.args, `--user-data-dir=${userDataDir}`],
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
        await app.close()
      } finally {
        if (owned) rmSync(userDataDir, { recursive: true, force: true })
      }
    }
  }
}
