import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getUserDataDir } from './userData'

/**
 * Minimal file logger for the main process. Appends timestamped lines to
 * `userData/logs/houston.log` (rotated once at a size cap) so users can share a
 * log when something goes wrong, and uncaught errors leave a trace instead of
 * vanishing. Never throws.
 */

const MAX_LOG_BYTES = 2_000_000

export type LogLevel = 'INFO' | 'WARN' | 'ERROR'

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

function logFilePath(): string {
  // Throws if the userData seam isn't wired yet; the caller's catch keeps that
  // silent, preserving the "logging never breaks the app" contract.
  const dir = join(getUserDataDir(), 'logs')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'houston.log')
}

function write(level: LogLevel, message: string): void {
  try {
    // Redact before formatting so multi-line secrets (e.g. PEM blocks) are matched
    // before newline-collapsing. Inside the try, so a redactor fault can't break logging.
    const safe = redactor(message)
    const path = logFilePath()
    try {
      if (existsSync(path) && needsRotation(statSync(path).size)) renameSync(path, `${path}.1`)
    } catch {
      // rotation is best-effort
    }
    appendFileSync(path, `${formatLogLine(level, safe)}\n`)
  } catch {
    // Never let logging break the app.
  }
}

export const log = {
  info: (message: string): void => write('INFO', message),
  warn: (message: string): void => write('WARN', message),
  error: (message: string, err?: unknown): void =>
    write('ERROR', err !== undefined ? `${message}: ${stringifyError(err)}` : message)
}
