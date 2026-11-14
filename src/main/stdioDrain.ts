import type { Writable } from 'node:stream'

/**
 * Wait until everything already written to `stream` has been handed to the OS.
 *
 * Writes to a pipe are asynchronous on macOS (and to any pipe on Windows), so a
 * `process.exit` right after a large write drops whatever is still queued: a
 * headless answer piped into another program lost everything past the first 64 KB.
 * An empty write's callback runs once every earlier write has flushed. A stream
 * that errored or closed (the reader went away) resolves at once, and `timeoutMs`
 * bounds the wait for a reader that stopped reading without closing.
 *
 * Dependency-free so the light CLI entry can import it.
 */
export function drainStream(stream: Writable, timeoutMs = 10_000): Promise<void> {
  if (stream.destroyed || stream.writableEnded || stream.writableLength === 0) return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      stream.off('error', finish)
      stream.off('close', finish)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
    stream.once('error', finish)
    stream.once('close', finish)
    try {
      // The class's own write, past any instance override: ACP mode points
      // process.stdout.write at stderr to keep the protocol channel clean.
      const write = (Object.getPrototypeOf(stream) as Writable).write as (chunk: string, cb: () => void) => boolean
      write.call(stream, '', () => finish())
    } catch {
      finish()
    }
  })
}

/** Flush stdout and stderr before the process exits. */
export async function drainStdio(timeoutMs?: number): Promise<void> {
  await Promise.all([drainStream(process.stdout, timeoutMs), drainStream(process.stderr, timeoutMs)])
}
