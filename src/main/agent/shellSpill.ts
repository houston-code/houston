import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { getUserDataDir } from '../userData'

/**
 * Full run_shell output, kept on disk when the tool result had to be clamped.
 *
 * The result the model sees keeps the head and tail of a long output and drops the
 * middle, which is right for the context window but leaves the dropped part
 * unrecoverable: rerunning a slow build or a flaky test to see line 4000 is the only
 * way back today. So when a result is clamped, the whole output (secrets redacted, as
 * in every other place output is written) goes to a file in the app's data directory,
 * one folder per run, and the result names the file and its line count. The model
 * reads parts of it back with run_shell (`sed -n`, `grep -n`); the sandbox reads
 * everywhere, and the file sits outside the project, so nothing lands in the repo.
 *
 * Bounded three ways: each spill is cut at {@link SPILL_MAX_BYTES}, a run stops
 * spilling once it has written {@link SPILL_RUN_MAX_BYTES}, and run folders older
 * than {@link SPILL_MAX_AGE_MS} (or beyond the newest {@link SPILL_KEEP_RUNS}) are
 * removed when a new run first spills.
 */

/** Most bytes of output collected (and written) per command. */
export const SPILL_MAX_BYTES = 8 * 1024 * 1024
/** Most bytes one run writes across all its spills. */
export const SPILL_RUN_MAX_BYTES = 64 * 1024 * 1024
/** Run folders older than this are pruned. */
export const SPILL_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** At most this many run folders are kept. */
export const SPILL_KEEP_RUNS = 20

/** Collects a command's streamed output up to {@link SPILL_MAX_BYTES}. */
export class OutputTee {
  private readonly parts: string[] = []
  private bytes = 0
  /** True once output past the cap was dropped. */
  overflowed = false

  constructor(private readonly max = SPILL_MAX_BYTES) {}

  push(chunk: string): void {
    if (this.overflowed) return
    const size = Buffer.byteLength(chunk, 'utf8')
    if (this.bytes + size > this.max) {
      // Keep what fits, at a character boundary.
      const room = this.max - this.bytes
      this.parts.push(Buffer.from(chunk, 'utf8').subarray(0, room).toString('utf8').replace(/�$/, ''))
      this.bytes = this.max
      this.overflowed = true
      return
    }
    this.parts.push(chunk)
    this.bytes += size
  }

  text(): string {
    return this.parts.join('')
  }
}

export interface SpillResult {
  path: string
  lines: number
}

/** Where one run's spills go, and how much it has written. Created lazily on the first spill. */
export class ShellSpill {
  private written = 0
  private count = 0
  private prepared: Promise<void> | null = null

  constructor(
    /** The parent folder for every run's spills, e.g. `<userData>/shell-output`. */
    private readonly baseDir: string,
    private readonly runId: string,
    private readonly redact: (text: string) => string,
    private readonly limits = { runMaxBytes: SPILL_RUN_MAX_BYTES, maxAgeMs: SPILL_MAX_AGE_MS, keepRuns: SPILL_KEEP_RUNS },
    private readonly now: () => number = Date.now
  ) {}

  private get runDir(): string {
    // Run ids come from the client; keep only filename-safe characters.
    return join(this.baseDir, this.runId.replace(/[^\w.-]/g, '_').slice(0, 100) || 'run')
  }

  /** Write `output` for this run, or null when the run's budget is spent or the write fails. */
  async spill(output: string, truncatedNote?: string): Promise<SpillResult | null> {
    const text = this.redact(output) + (truncatedNote ? `\n${truncatedNote}\n` : '')
    const size = Buffer.byteLength(text, 'utf8')
    if (this.written + size > this.limits.runMaxBytes) return null
    try {
      this.prepared ??= this.prepare()
      await this.prepared
      const path = join(this.runDir, `shell-${++this.count}.log`)
      await fs.writeFile(path, text, { encoding: 'utf8', mode: 0o600 })
      this.written += size
      const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
      return { path, lines }
    } catch {
      return null
    }
  }

  private async prepare(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 })
    await prune(this.baseDir, this.limits.maxAgeMs, this.limits.keepRuns, this.now())
    await fs.mkdir(this.runDir, { recursive: true, mode: 0o700 })
  }
}

/** Remove run folders past the age limit, then all but the newest `keep`. */
export async function prune(baseDir: string, maxAgeMs: number, keep: number, now: number): Promise<void> {
  let entries: { path: string; mtimeMs: number }[]
  try {
    const names = await fs.readdir(baseDir, { withFileTypes: true })
    entries = await Promise.all(
      names
        .filter((d) => d.isDirectory())
        .map(async (d) => {
          const path = join(baseDir, d.name)
          return { path, mtimeMs: (await fs.stat(path)).mtimeMs }
        })
    )
  } catch {
    return
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const doomed = entries.filter((e, i) => i >= keep || now - e.mtimeMs > maxAgeMs)
  await Promise.all(doomed.map((e) => fs.rm(e.path, { recursive: true, force: true }).catch(() => {})))
}

/**
 * A run's spill under `<userData>/shell-output`, or null where no app data directory
 * is wired (some test and embedding hosts), in which case clamped output isn't kept.
 */
export function runShellSpill(runId: string, redact: (text: string) => string): ShellSpill | null {
  try {
    return new ShellSpill(join(getUserDataDir(), 'shell-output'), runId, redact)
  } catch {
    return null
  }
}

/** The note appended to a clamped run_shell result. */
export function spillNote(r: SpillResult): string {
  return (
    `[full output (${r.lines} line${r.lines === 1 ? '' : 's'}) saved to ${r.path}; ` +
    `read the part you need with run_shell, e.g. sed -n '1000,1200p' or grep -n 'error']`
  )
}
