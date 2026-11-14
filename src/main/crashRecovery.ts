import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { log } from './logger'

/**
 * Keeping a window usable when its renderer dies, and leaving a trace when it does.
 *
 * A renderer that crashed (`render-process-gone`) or hung (`unresponsive`) used to
 * leave a blank or frozen window and nothing in the log. The window now logs the event
 * and reloads its page. A reloaded page re-adopts any run still going in the main
 * process and replays what streamed since the last save (see the agent replay handler
 * in ipc.ts), so a run keeps going through a renderer crash. A page that crashes over
 * and over is not reloaded in a loop: past {@link RELOAD_LIMIT} reloads in
 * {@link RELOAD_WINDOW_MS} the window is left as it is, and the log says why.
 *
 * Crash dumps are written by Electron's crash reporter with uploading off, so they
 * stay on this computer (see {@link startLocalCrashReporter}).
 */

/** How many automatic reloads one window gets within {@link RELOAD_WINDOW_MS}. */
export const RELOAD_LIMIT = 3
export const RELOAD_WINDOW_MS = 60_000
/** How long a renderer may stay unresponsive before it is restarted. */
export const UNRESPONSIVE_GRACE_MS = 15_000

/** Allows a reload unless `limit` already happened inside the last `windowMs`. */
export function createReloadGuard(
  limit = RELOAD_LIMIT,
  windowMs = RELOAD_WINDOW_MS,
  now: () => number = Date.now
): () => boolean {
  const recent: number[] = []
  return () => {
    const t = now()
    while (recent.length && t - recent[0] >= windowMs) recent.shift()
    if (recent.length >= limit) return false
    recent.push(t)
    return true
  }
}

/** The parts of a BrowserWindow this needs, so tests can drive it with a fake. */
export interface CrashWatchedWindow {
  isDestroyed(): boolean
  on(event: 'unresponsive' | 'responsive', listener: () => void): unknown
  webContents: {
    on(
      event: 'render-process-gone',
      listener: (event: unknown, details: { reason: string; exitCode: number }) => void
    ): unknown
    isDestroyed(): boolean
    reload(): void
    forcefullyCrashRenderer(): void
  }
}

export interface CrashWatchDeps {
  allowReload?: () => boolean
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

/**
 * Log a renderer crash or hang on `win` and bring the page back. A crash reloads at
 * once; a hang gets {@link UNRESPONSIVE_GRACE_MS} to recover on its own, then its
 * renderer is restarted, which reports as a crash and reloads through the same path.
 */
export function watchRendererCrashes(win: CrashWatchedWindow, deps: CrashWatchDeps = {}): void {
  const allowReload = deps.allowReload ?? createReloadGuard()
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  let hangTimer: unknown

  const alive = (): boolean => !win.isDestroyed() && !win.webContents.isDestroyed()

  win.webContents.on('render-process-gone', (_event, details) => {
    if (hangTimer !== undefined) {
      clearTimer(hangTimer)
      hangTimer = undefined
    }
    log.error(`renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`)
    // A clean exit is the page going away on purpose (the window is closing).
    if (details.reason === 'clean-exit' || !alive()) return
    if (!allowReload()) {
      log.error(
        `renderer crashed ${RELOAD_LIMIT} times within ${RELOAD_WINDOW_MS / 1000}s; not reloading it again. ` +
          'Reopen the window or restart Houston.'
      )
      return
    }
    log.info('reloading the window after its renderer process went away')
    win.webContents.reload()
  })

  win.on('unresponsive', () => {
    log.warn('renderer is not responding')
    if (hangTimer !== undefined) return
    hangTimer = setTimer(() => {
      hangTimer = undefined
      if (!alive()) return
      log.error(`renderer still not responding after ${UNRESPONSIVE_GRACE_MS / 1000}s; restarting it`)
      // Ends the hung process; render-process-gone then reloads the page (guarded).
      win.webContents.forcefullyCrashRenderer()
    }, UNRESPONSIVE_GRACE_MS)
  })

  win.on('responsive', () => {
    if (hangTimer === undefined) return
    clearTimer(hangTimer)
    hangTimer = undefined
    log.info('renderer is responding again')
  })
}

/** The part of Electron's crashReporter this uses. */
export interface CrashReporterLike {
  start(options: { uploadToServer: boolean; compress?: boolean }): void
}

/**
 * Start Electron's crash reporter so a crash leaves a minidump, with uploading off:
 * the dump is written to this computer's crash-dump folder and sent nowhere. Never
 * throws; a reporter that won't start just leaves no dumps.
 */
export function startLocalCrashReporter(reporter: CrashReporterLike): void {
  try {
    reporter.start({ uploadToServer: false })
  } catch (e) {
    log.warn(`could not start the local crash reporter: ${(e as Error)?.message ?? String(e)}`)
  }
}

/** How far back Report an Issue looks for crash dumps. */
export const RECENT_DUMP_MS = 14 * 24 * 60 * 60 * 1000
export const MAX_LISTED_DUMPS = 5

interface DumpFs {
  readdir(dir: string): { name: string; isDirectory(): boolean; isFile(): boolean }[]
  mtimeMs(path: string): number
}

const realFs: DumpFs = {
  readdir: (dir) => readdirSync(dir, { withFileTypes: true }),
  mtimeMs: (p) => statSync(p).mtimeMs
}

/**
 * The file names (never paths) of the newest crash dumps written in the last
 * {@link RECENT_DUMP_MS}, newest first, at most {@link MAX_LISTED_DUMPS}. Crashpad keeps
 * them one folder down (`completed`, `pending`, `new`), so that level is searched too.
 * Missing or unreadable folders read as none.
 */
export function recentCrashDumps(dir: string, now: number = Date.now(), fs: DumpFs = realFs): string[] {
  const found: { name: string; at: number }[] = []
  const scan = (folder: string, depth: number): void => {
    let entries: ReturnType<DumpFs['readdir']>
    try {
      entries = fs.readdir(folder)
    } catch {
      return
    }
    for (const e of entries) {
      const path = join(folder, e.name)
      if (e.isDirectory() && depth < 1) scan(path, depth + 1)
      else if (e.isFile() && e.name.toLowerCase().endsWith('.dmp')) {
        try {
          const at = fs.mtimeMs(path)
          if (now - at <= RECENT_DUMP_MS) found.push({ name: e.name, at })
        } catch {
          // Gone between the listing and the stat.
        }
      }
    }
  }
  scan(dir, 0)
  return found
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_LISTED_DUMPS)
    .map((d) => d.name)
}

/** The longest renderer error message or stack kept in the log. */
export const MAX_RENDERER_ERROR_CHARS = 8_000
/** How many renderer errors one window may log per minute; the rest are counted, not logged. */
export const RENDERER_ERROR_LIMIT = 30

export type RendererErrorKind = 'error' | 'unhandledrejection' | 'boundary'

/** A renderer error as it arrives over IPC: untrusted, so every field is checked. */
export function parseRendererError(
  raw: unknown
): { kind: RendererErrorKind; message: string; stack?: string; componentStack?: string } | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.kind !== 'error' && r.kind !== 'unhandledrejection' && r.kind !== 'boundary') return null
  if (typeof r.message !== 'string') return null
  const cap = (v: unknown): string | undefined =>
    typeof v === 'string' && v ? v.slice(0, MAX_RENDERER_ERROR_CHARS) : undefined
  const stack = cap(r.stack)
  const componentStack = cap(r.componentStack)
  return {
    kind: r.kind,
    message: r.message.slice(0, MAX_RENDERER_ERROR_CHARS) || '(no message)',
    ...(stack ? { stack } : {}),
    ...(componentStack ? { componentStack } : {})
  }
}

/**
 * Logs renderer errors sent over IPC, keyed by the sending window, at most
 * {@link RENDERER_ERROR_LIMIT} a minute per window so a render loop that throws on
 * every frame can't fill the log. The logger's secret redaction runs on every line.
 */
export function createRendererErrorLogger(now: () => number = Date.now): (senderId: number, raw: unknown) => void {
  const windows = new Map<number, { start: number; count: number; dropped: number }>()
  return (senderId, raw) => {
    const err = parseRendererError(raw)
    if (!err) return
    const t = now()
    let w = windows.get(senderId)
    if (!w || t - w.start >= 60_000) {
      if (w?.dropped) log.warn(`renderer ${senderId}: ${w.dropped} more error(s) not logged`)
      w = { start: t, count: 0, dropped: 0 }
      windows.set(senderId, w)
    }
    if (w.count >= RENDERER_ERROR_LIMIT) {
      w.dropped++
      return
    }
    w.count++
    const detail = [err.stack, err.componentStack && `component stack:${err.componentStack}`].filter(Boolean).join('\n')
    log.error(`renderer ${err.kind}: ${err.message}${detail ? `\n${detail}` : ''}`)
  }
}
