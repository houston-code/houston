import { appendFileSync, mkdirSync, statSync, renameSync, existsSync, promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { getUserDataDir } from './userData'

/**
 * Minimal file logger for the main process. Appends timestamped lines to
 * `userData/logs/houston.log` (rotated once at a size cap) so users can share a
 * log when something goes wrong, and uncaught errors leave a trace instead of
 * vanishing. Never throws.
 *
 * Lines are buffered and appended asynchronously, a batch every {@link FLUSH_MS}, so a
 * busy run doesn't block the main process on a disk write per line. An ERROR line, a
 * full buffer, and process exit flush synchronously, so a crash still leaves its last
 * lines on disk. `HOUSTON_LOG_LEVEL` (`debug`, `info`, `warn` or `error`; default
 * `info`) sets the lowest level written.
 */

const MAX_LOG_BYTES = 2_000_000

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

const LEVEL_RANK: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }

/** The lowest level written, from `HOUSTON_LOG_LEVEL`; unset or unknown means INFO. Pure. */
export function minLogLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const v = (env.HOUSTON_LOG_LEVEL ?? '').trim().toUpperCase()
  if (v === 'WARNING') return 'WARN'
  return v in LEVEL_RANK ? (v as LogLevel) : 'INFO'
}

/** Whether a line at `level` is written under `min`. Pure. */
export function shouldLog(level: LogLevel, min: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[min]
}

/** How long lines wait in the buffer before an asynchronous append. */
export const FLUSH_MS = 200
/** Buffered bytes past which the buffer is flushed synchronously at once. */
export const MAX_BUFFERED_BYTES = 256 * 1024

/**
 * Optional secret scrubber applied to every log line. Identity until the app wires the
 * real redactor at startup (see wireAgentHost.ts / the CLI host), so a provider error
 * or diagnostic that happens to carry a key or token never lands in the shared log
 * file. Kept as an injected seam so the logger stays free of the secret store.
 */
let redactor: (message: string) => string = (m) => m

/** Bind the log-line secret redactor. Call once at startup. */
export function configureLogRedactor(fn: (message: string) => string): void {
  redactor = fn
}

/** Format one log line. Pure (time injectable) for testing. */
export function formatLogLine(level: LogLevel, message: string, time: Date = new Date()): string {
  // Collapse newlines so each entry is a single grep-able line.
  return `${time.toISOString()} [${level}] ${message.replace(/\s*\n\s*/g, ' ⏎ ')}`
}

/** Whether the log should roll over before the next write. Pure. */
export function needsRotation(size: number, max: number = MAX_LOG_BYTES): boolean {
  return size > max
}

function stringifyError(e: unknown): string {
  if (e instanceof Error) return e.stack ?? `${e.name}: ${e.message}`
  return typeof e === 'string' ? e : JSON.stringify(e)
}

/** The log file (`<profile>/logs/houston.log`), creating its folder if needed. */
export function logFilePath(): string {
  // Throws if the userData seam isn't wired yet; the caller's catch keeps that
  // silent, preserving the "logging never breaks the app" contract.
  const dir = join(getUserDataDir(), 'logs')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'houston.log')
}

/** Lines not yet on disk, each with the file it belongs in (resolved when it was logged). */
let pending: { path: string; line: string }[] = []
let pendingBytes = 0
let timer: ReturnType<typeof setTimeout> | undefined
/** The asynchronous append in progress, so a sync flush can't interleave with it. */
let writing: Promise<void> | undefined

function rotateIfNeeded(path: string): void {
  try {
    if (existsSync(path) && needsRotation(statSync(path).size)) renameSync(path, `${path}.1`)
  } catch {
    // rotation is best-effort
  }
}

/** Take the buffer, grouped by file in logged order. */
function takePending(): Map<string, string> {
  const byPath = new Map<string, string>()
  for (const { path, line } of pending) byPath.set(path, (byPath.get(path) ?? '') + line)
  pending = []
  pendingBytes = 0
  if (timer) {
    clearTimeout(timer)
    timer = undefined
  }
  return byPath
}

/**
 * Write every buffered line now, synchronously. Called for an ERROR line, a full
 * buffer, and at exit; tests call it before reading the file. Never throws.
 */
export function flushLogSync(): void {
  for (const [path, text] of takePending()) {
    try {
      rotateIfNeeded(path)
      appendFileSync(path, text)
    } catch {
      // Never let logging break the app.
    }
  }
}

function flushAsync(): void {
  timer = undefined
  if (writing) {
    // One append at a time keeps lines in order; try again once this one lands.
    void writing.then(() => schedule())
    return
  }
  const batch = takePending()
  writing = (async () => {
    for (const [path, text] of batch) {
      try {
        rotateIfNeeded(path)
        await fsp.appendFile(path, text)
      } catch {
        // Never let logging break the app.
      }
    }
  })().finally(() => {
    writing = undefined
  })
}

function schedule(): void {
  if (timer || pending.length === 0) return
  timer = setTimeout(flushAsync, FLUSH_MS)
  timer.unref?.()
}

process.once('exit', flushLogSync)

function write(level: LogLevel, message: string): void {
  try {
    if (!shouldLog(level, minLogLevel())) return
    // Redact before formatting so multi-line secrets (e.g. PEM blocks) are matched
    // before newline-collapsing. Inside the try, so a redactor fault can't break logging.
    // Every line at every level passes through here, so the redactor sees all of it.
    const safe = redactor(message)
    const line = `${formatLogLine(level, safe)}\n`
    pending.push({ path: logFilePath(), line })
    pendingBytes += line.length
    if (level === 'ERROR' || pendingBytes > MAX_BUFFERED_BYTES) flushLogSync()
    else schedule()
  } catch {
    // Never let logging break the app.
  }
}

export const log = {
  /** Written only with HOUSTON_LOG_LEVEL=debug. */
  debug: (message: string): void => write('DEBUG', message),
  info: (message: string): void => write('INFO', message),
  warn: (message: string): void => write('WARN', message),
  error: (message: string, err?: unknown): void =>
    write('ERROR', err !== undefined ? `${message}: ${stringifyError(err)}` : message)
}
