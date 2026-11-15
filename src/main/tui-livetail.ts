/**
 * A running shell command's output under /verbose. The loop sends the tail of the
 * output so far (bounded, so its first line may be cut) on each `tool_progress`, each
 * replacing the last; line mode can only append, so this works out which complete
 * lines are new since the previous tail and prints just those.
 */
export class LiveTail {
  /** Per call: the complete lines of the last tail seen. */
  private readonly seen = new Map<string, string[]>()

  /** The complete lines in `tail` that weren't in the call's previous one. */
  next(callId: string, tail: string): string[] {
    const parts = tail.replace(/\r\n/g, '\n').split('\n')
    // The text after the last newline is a line still being written: wait for its end.
    const complete = parts.slice(0, -1)
    const prev = this.seen.get(callId) ?? []
    this.seen.set(callId, complete)
    return complete.slice(overlap(prev, complete))
  }

  /** Whether any output of this call was shown live. */
  streamed(callId: string): boolean {
    return (this.seen.get(callId)?.length ?? 0) > 0
  }

  forget(callId: string): void {
    this.seen.delete(callId)
  }
}

/**
 * How many leading lines of `next` the end of `prev` already covered. The window
 * slides as output grows, so `next` starts somewhere inside `prev`; its first line can
 * be the cut-off end of a line `prev` held whole. Zero when nothing lines up (a gap
 * longer than the window): then every line is new.
 */
function overlap(prev: string[], next: string[]): number {
  for (let k = Math.min(prev.length, next.length); k > 0; k--) {
    const start = prev.length - k
    if (!prev[start].endsWith(next[0])) continue
    let same = true
    for (let i = 1; i < k; i++) {
      if (prev[start + i] !== next[i]) {
        same = false
        break
      }
    }
    if (same) return k
  }
  return 0
}
