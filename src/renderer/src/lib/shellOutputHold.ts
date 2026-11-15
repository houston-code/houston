import type { ChatMessage } from '@shared/agent'

/** A finished `!cmd` whose output is still to be added to its chat. */
export interface HeldShellRun {
  conversationId: string
  command: string
  output: string
  exitCode: number
}

/** What adding one to its chat came to (the shape of `recordShellCommand`'s answer). */
export type RecordShellAnswer = { ok: true; messages: ChatMessage[] } | { ok: false; reason: string }

/**
 * The output of `!` commands that finished while their chat's agent was working.
 * Main refuses to add a turn to a chat mid-run (the log on disk is about to be
 * rewritten), so instead of dropping it the output waits here and is added once
 * the turn ends, oldest first, each exactly once.
 */
export class ShellOutputHold {
  private held: HeldShellRun[] = []
  private flushing = false

  hold(run: HeldShellRun): void {
    this.held.push(run)
  }

  /** The chats with output waiting, each once. */
  ids(): string[] {
    return [...new Set(this.held.map((r) => r.conversationId))]
  }

  /** Whether anything is waiting (for `id`, or for any chat). */
  has(id?: string): boolean {
    return id === undefined ? this.held.length > 0 : this.held.some((r) => r.conversationId === id)
  }

  /**
   * Add every held run whose chat isn't running now. One still refused as busy
   * (the next turn started first) stays held, and so does everything after it for
   * that chat, so the order holds; one refused for any other reason (the chat was
   * deleted) is dropped. Resolves with each chat's messages after its last add.
   * A flush while one is going does nothing: the one going sees the same list.
   */
  async flush(
    isRunning: (id: string) => boolean,
    record: (run: HeldShellRun) => Promise<RecordShellAnswer>
  ): Promise<Map<string, ChatMessage[]>> {
    const added = new Map<string, ChatMessage[]>()
    if (this.flushing) return added
    this.flushing = true
    const batch = this.held
    this.held = []
    const keep: HeldShellRun[] = []
    try {
      const blocked = new Set<string>()
      for (const run of batch) {
        if (blocked.has(run.conversationId) || isRunning(run.conversationId)) {
          blocked.add(run.conversationId)
          keep.push(run)
          continue
        }
        let res: RecordShellAnswer
        try {
          res = await record(run)
        } catch {
          res = { ok: false, reason: 'busy' }
        }
        if (res.ok) added.set(run.conversationId, res.messages)
        else if (res.reason === 'busy') {
          blocked.add(run.conversationId)
          keep.push(run)
        }
      }
      return added
    } finally {
      // Anything held while this flush ran goes after what was already waiting.
      this.held = [...keep, ...this.held]
      this.flushing = false
    }
  }
}
