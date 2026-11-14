/**
 * Run a terminal client's exit cleanup when the process is told to stop by a signal.
 *
 * The terminal clients (TUI, headless, ACP) tear down in a `finally` block, which a
 * signal skips: Node's default for SIGHUP, SIGTERM, and SIGINT is to exit on the spot.
 * Background shells are spawned in their own process group, so they never see the
 * terminal's hangup either, and a closed terminal or a `kill` of `houston -p` would
 * leave a dev server holding its port. {@link installSignalCleanup} closes that gap:
 * the first listed signal runs the same cleanup the `finally` does (exactly once,
 * shared with the normal path), then exits with the conventional `128 + n`.
 */

export type CleanupSignal = 'SIGHUP' | 'SIGINT' | 'SIGTERM'

/** POSIX signal numbers, for the `128 + n` exit status a shell reports for a signal. */
export const SIGNAL_NUMBERS: Record<CleanupSignal, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }

/** The slice of `process` this needs, so tests can drive it with a fake. */
export interface SignalProcess {
  on(signal: CleanupSignal, listener: () => void): unknown
  removeListener(signal: CleanupSignal, listener: () => void): unknown
  exit(code: number): void
}

/** Longest a signal waits on cleanup before exiting anyway (a wedged MCP server or language server). */
export const SIGNAL_CLEANUP_TIMEOUT_MS = 5_000

export interface SignalCleanup {
  /**
   * Run the cleanup, once: every later call (and a signal arriving meanwhile) gets the
   * same promise. The entry's `finally` awaits this.
   */
  run(): Promise<void>
  /** Stop listening for the signals (after a normal exit's cleanup). Idempotent. */
  dispose(): void
}

export function installSignalCleanup(
  cleanup: () => void | Promise<void>,
  opts: {
    signals: CleanupSignal[]
    proc?: SignalProcess
    timeoutMs?: number
    onSignal?: (signal: CleanupSignal) => void
    /**
     * Extra work for the signal path only, after the cleanup: what the host would
     * otherwise do once the entry returns (a signal never returns to it).
     */
    beforeSignalExit?: () => void | Promise<unknown>
  }
): SignalCleanup {
  const proc = opts.proc ?? (process as unknown as SignalProcess)
  const timeoutMs = opts.timeoutMs ?? SIGNAL_CLEANUP_TIMEOUT_MS
  let running: Promise<void> | null = null
  let exiting = false
  const listeners: Array<[CleanupSignal, () => void]> = []

  const run = (): Promise<void> => {
    if (!running) {
      running = (async () => {
        try {
          await cleanup()
        } catch {
          // A failed step must not keep the rest of the exit from happening.
        }
      })()
    }
    return running
  }

  const dispose = (): void => {
    for (const [sig, fn] of listeners.splice(0)) proc.removeListener(sig, fn)
  }

  for (const sig of opts.signals) {
    const code = 128 + SIGNAL_NUMBERS[sig]
    const fn = (): void => {
      // A second signal while cleanup is still running: the user means it, go now.
      if (exiting) {
        proc.exit(code)
        return
      }
      exiting = true
      opts.onSignal?.(sig)
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      })
      const work = (async () => {
        await run()
        try {
          await opts.beforeSignalExit?.()
        } catch {
          // Exiting regardless: there is no one left to report it to.
        }
      })()
      void Promise.race([work, deadline]).then(() => {
        if (timer) clearTimeout(timer)
        dispose()
        proc.exit(code)
      })
    }
    listeners.push([sig, fn])
    proc.on(sig, fn)
  }

  return { run, dispose }
}
