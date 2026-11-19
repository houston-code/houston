import { execFile } from 'node:child_process'
import { basename, dirname } from 'node:path'

/**
 * What the windowless schedule daemon does with the events macOS sends "the running
 * Houston".
 *
 * On macOS the daemon is the app's own executable (`Houston.app/Contents/MacOS/Houston
 * --schedule-daemon`), started by a LaunchAgent. LaunchServices tracks running apps by
 * bundle, so while the daemon runs it is "Houston": a Dock or Finder click, a Spotlight
 * launch or a login item sends a reopen event to the daemon instead of starting the
 * app, and a `houston://` link (`houston open`, a browser) is delivered to it as
 * `open-url`. The daemon has no window to show and no chat to open, so all of these
 * did nothing. It keeps getting them even after a window app starts, since the daemon
 * registered first.
 *
 * So the daemon passes each one on to a new instance of the window app (`open -n`):
 * - a reopen starts the app (or, when it is already open, brings its window forward:
 *   the new instance finds the single-instance lock held, which only the window app
 *   takes, hands over its argv as `second-instance`, and quits);
 * - a link goes on the new instance's argv (`--args`), which the window app reads at
 *   launch and in `second-instance` on every platform. Handing it over as an
 *   `open-url` event instead would lose it whenever the app is already open: the new
 *   instance quits on the lock before it listens for links;
 * - a file is opened with the app as usual.
 *
 * Nothing loops back: `open -n` always starts a new process, which LaunchServices
 * doesn't route back to the daemon as a reopen, and the window app never forwards
 * anything to the daemon.
 */

export interface DaemonAppEventsDeps {
  platform: NodeJS.Platform
  /** The daemon's own executable (`process.execPath`). */
  execPath: string
  /** Electron's `app.on`. */
  on: (event: 'activate' | 'open-url' | 'open-file', listener: (event: { preventDefault: () => void }, arg?: string) => void) => void
  /** Run `open` with literal arguments (no shell). */
  run: (file: string, args: string[]) => void
  log: (message: string) => void
  now?: () => number
}

/** A Dock double-click or a repeated launch sends several reopens in a row: start one app. */
export const REOPEN_DEBOUNCE_MS = 2_000

/** The `.app` bundle an executable sits in (`X.app/Contents/MacOS/X`), or null. */
export function appBundleOf(execPath: string): string | null {
  const macos = dirname(execPath)
  const contents = dirname(macos)
  const bundle = dirname(contents)
  if (basename(macos) !== 'MacOS' || basename(contents) !== 'Contents' || !bundle.endsWith('.app')) return null
  return bundle
}

/**
 * Wire the daemon's reopen, link and file events to launch the window app. Does
 * nothing off macOS (other platforms start a new process per launch or link, which
 * the daemon never sees) or outside an app bundle (a development run).
 */
export function wireDaemonAppEvents(deps: DaemonAppEventsDeps): boolean {
  if (deps.platform !== 'darwin') return false
  const bundle = appBundleOf(deps.execPath)
  if (!bundle) return false
  const now = deps.now ?? Date.now
  let lastReopen = -Infinity
  const launch = (extra: string[], what: string): void => {
    deps.log(`schedule daemon: ${what}; opening the Houston app`)
    deps.run('/usr/bin/open', ['-n', '-a', bundle, ...extra])
  }
  deps.on('activate', () => {
    const t = now()
    if (t - lastReopen < REOPEN_DEBOUNCE_MS) return
    lastReopen = t
    launch([], 'asked to reopen')
  })
  deps.on('open-url', (event, url) => {
    event.preventDefault()
    // A link always starts with its scheme; never pass on anything that reads as a switch.
    if (typeof url !== 'string' || !/^[a-z][a-z0-9+.-]*:/i.test(url)) return
    launch(['--args', url], 'received a link')
  })
  deps.on('open-file', (event, path) => {
    event.preventDefault()
    // macOS hands over absolute paths; anything else could read as an option to `open`.
    if (typeof path !== 'string' || !path.startsWith('/')) return
    launch([path], 'asked to open a file')
  })
  return true
}

/** The real `open` runner: no shell, errors logged rather than thrown. */
export function runDetached(log: (message: string) => void): (file: string, args: string[]) => void {
  return (file, args) => {
    execFile(file, args, { timeout: 30_000 }, (err) => {
      if (err) log(`schedule daemon: couldn't open the Houston app: ${err.message}`)
    })
  }
}
