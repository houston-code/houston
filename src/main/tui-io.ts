import { createInterface as nodeCreateInterface } from 'node:readline'
import type { TuiIo } from './tui'

/**
 * Real terminal I/O for interactive mode (`Houston -i`), backed by node:readline.
 * Split out from index.ts and parameterized so its lifecycle logic — the part
 * that actually prevents visual corruption — is unit-testable with a fake
 * interface, while the pure driver in tui.ts stays terminal-agnostic.
 *
 * Why the pause/resume dance: a readline interface in terminal mode owns the TTY
 * and ECHOES keystrokes the entire time it is resumed — not only while a
 * `question()` is outstanding. The driver streams assistant output with raw
 * `stdout.write` (bypassing readline) between reads, so if the interface were left
 * resumed, anything the user typed mid-stream would be echoed into the middle of
 * that output and readline's next line-refresh would repaint against a drifted
 * cursor. Keeping the interface PAUSED except during an actual read closes that:
 * paused → no keypress processing → no echo, while raw mode (still set) keeps the
 * terminal from echoing either.
 */

/** The slice of a readline Interface this adapter drives (fakeable in tests). */
export interface ReadlineLike {
  question(query: string, cb: (answer: string) => void): void
  pause(): void
  resume(): void
  on(event: string, cb: () => void): void
  close(): void
}

export interface TerminalIoDeps {
  /** Build the readline interface. Defaults to node:readline over stdin/stdout. */
  createInterface?: () => ReadlineLike
  /** Write to the output stream. Defaults to process.stdout.write. */
  write?: (s: string) => void
  /** Discard buffered type-ahead before a sensitive read. Defaults to draining stdin. */
  drainInput?: () => void
}

/**
 * Decide whether to emit ANSI color, honoring the common conventions. Precedence:
 * an explicit opt-out (`NO_COLOR` present at any value, per no-color.org — or
 * `TERM=dumb`) always wins; then `FORCE_COLOR` forces it on even without a TTY;
 * otherwise color requires a TTY. Kept pure for testing.
 */
export function resolveColor(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if ('NO_COLOR' in env) return false
  if (env.TERM === 'dumb') return false
  const force = env.FORCE_COLOR
  if (force !== undefined && force !== '0' && force !== 'false') return true
  return isTTY
}

/** Best-effort discard of bytes already buffered on stdin (type-ahead). */
function defaultDrain(): void {
  const stdin = process.stdin as NodeJS.ReadStream
  while (stdin.read() !== null) {
    /* discard whatever the user typed while output was streaming */
  }
}

export function createTerminalIo(deps: TerminalIoDeps = {}): TuiIo {
  const rl =
    deps.createInterface?.() ??
    (nodeCreateInterface({ input: process.stdin, output: process.stdout }) as unknown as ReadlineLike)
  const write = deps.write ?? ((s: string) => void process.stdout.write(s))
  const drainInput = deps.drainInput ?? defaultDrain

  let pending: ((line: string | null) => void) | null = null
  const settle = (line: string | null): void => {
    if (pending) {
      const resolve = pending
      pending = null
      resolve(line)
    }
  }

  // Start idle → paused, so keystrokes typed before the first read (or while
  // output streams between reads) aren't echoed into the transcript.
  rl.pause()
  // Ctrl-D / closed stdin ends any outstanding read with EOF.
  rl.on('close', () => settle(null))

  return {
    out: write,
    readLine: (prompt, opts) =>
      new Promise<string | null>((resolve) => {
        pending = resolve
        // Drop type-ahead before a security-sensitive prompt so a stray buffered
        // 'y' can't answer an approval the user never actually saw.
        if (opts?.discardPending) drainInput()
        rl.resume()
        rl.question(prompt, (answer) => {
          rl.pause() // back to idle: stop echoing until the next read
          pending = null
          resolve(answer)
        })
      }),
    onInterrupt: (handler) => rl.on('SIGINT', handler),
    cancelRead: () => {
      settle(null)
      rl.pause()
    }
  }
}
