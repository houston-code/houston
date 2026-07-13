/**
 * Multi-line composer accumulation for the readline-based input. A logical
 * message can span several physical lines: a trailing backslash continues onto
 * the next line, and an open code fence keeps reading until it closes — so pasting
 * or typing a fenced snippet doesn't submit at the first newline.
 *
 * Pure and testable: the driver feeds physical lines from readLine and submits
 * when `push` returns the assembled text. (Full bracketed-paste capture needs the
 * raw-mode composer and is a separate, manual-verify step.)
 */
export class ComposerBuffer {
  private lines: string[] = []

  /**
   * Feed one physical line. Returns the assembled multi-line text when the message
   * is complete, or null to keep reading (a continuation is pending).
   */
  push(line: string): string | null {
    // Normalize a CRLF tail so a piped `\r\n` stream doesn't defeat the trailing
    // backslash check below (an interactive TTY already strips the `\r`).
    const clean = line.replace(/\r$/, '')
    // A trailing backslash means "continue on the next line" — drop the backslash.
    // A doubled backslash at the end is a literal, not a continuation.
    const continued = /(^|[^\\])\\$/.test(clean)
    this.lines.push(continued ? clean.slice(0, -1) : clean)
    if (continued) return null
    if (this.inOpenFence()) return null
    return this.flush()
  }

  /** True while a continuation is pending (used to pick the continuation prompt). */
  get pending(): boolean {
    return this.lines.length > 0
  }

  /**
   * True when the pending continuation is an unclosed code fence (vs a trailing
   * backslash). The driver uses this to hint how to submit, so a stray/opening
   * ```/``~~~`` can't silently trap the composer with no way out but Ctrl-C.
   */
  get inFence(): boolean {
    return this.inOpenFence()
  }

  /** Assemble and reset — used on completion, or to submit what's buffered at EOF. */
  flush(): string {
    const text = this.lines.join('\n')
    this.lines = []
    return text
  }

  /** Whether the accumulated lines are currently inside an unclosed ``` / ~~~ fence. */
  private inOpenFence(): boolean {
    const fences = this.lines.filter((l) => /^\s{0,3}(```|~~~)/.test(l)).length
    return fences % 2 === 1
  }
}
