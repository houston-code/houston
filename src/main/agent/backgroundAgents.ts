import { systemNoteMessage, type ChatMessage } from '@shared/agent'

/**
 * Subagents dispatched with `background: true`: the dispatch call returns at once with
 * an id, the agent works on while the main agent continues, and its report comes back
 * later, at the next step as a Houston note or through `wait_for(id)`.
 *
 * One registry per run. A background agent never outlives its run: Stop aborts it (its
 * signal follows the run's), the run's end stops any still going ({@link stop}), and a
 * turn that would end with one still working waits for it first, so its work is never
 * dropped unreported. It shares the run's budget and cost ceiling because it is an
 * ordinary dispatch (runDispatch) started without awaiting it.
 */

/** Most background agents one run may have working at once. */
export const MAX_BACKGROUND_AGENTS = 4
/** How long a stopped run waits for its background agents to wind down. */
export const SETTLE_MS = 2_000

export interface BackgroundAgent {
  /** The id the model waits on (`bg1`, `bg2`, ...). */
  id: string
  /** The dispatch tool call it belongs to; its record streams under this call. */
  callId: string
  label: string
  writable: boolean
  done: boolean
  /** Its report (what a foreground dispatch would have returned), once done. */
  result?: string
  /** Whether the model has been given the report. */
  delivered: boolean
}

export class BackgroundAgents {
  private readonly agents = new Map<string, BackgroundAgent>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly listeners = new Set<() => void>()
  private seq = 0
  private readonly controller = new AbortController()

  constructor(parent: AbortSignal) {
    if (parent.aborted) this.controller.abort()
    else parent.addEventListener('abort', () => this.controller.abort(), { once: true })
  }

  /** The signal background agents run under: aborted on Stop and when the run ends. */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** How many are still working. */
  get workingCount(): number {
    return this.running.size
  }

  /**
   * Start one. `run` is the dispatch itself; whatever it resolves (or throws) becomes
   * the report. `onSettled` runs once it is done, before listeners are told. Returns the
   * new agent, or a refusal to hand back as the tool result.
   */
  start(
    input: { callId: string; label: string; writable: boolean },
    run: (signal: AbortSignal) => Promise<string>,
    onSettled?: (agent: BackgroundAgent) => void
  ): BackgroundAgent | { refused: string } {
    if (this.controller.signal.aborted) return { refused: 'The turn is ending, so no background agent can start now.' }
    if (this.running.size >= MAX_BACKGROUND_AGENTS) {
      return {
        refused: `${MAX_BACKGROUND_AGENTS} background agents are already working (${[...this.running.keys()].join(', ')}). Wait for one with wait_for, or dispatch this one without background.`
      }
    }
    const agent: BackgroundAgent = { id: `bg${++this.seq}`, ...input, done: false, delivered: false }
    this.agents.set(agent.id, agent)
    const settle = (result: string): void => {
      agent.done = true
      agent.result = result
      this.running.delete(agent.id)
      try {
        onSettled?.(agent)
      } finally {
        for (const fn of [...this.listeners]) fn()
      }
    }
    const p = Promise.resolve()
      .then(() => run(this.controller.signal))
      .then(
        (result) => settle(result),
        (e: unknown) => settle(`[background agent failed: ${e instanceof Error ? e.message : String(e)}]`)
      )
    this.running.set(agent.id, p)
    return agent
  }

  get(id: string): BackgroundAgent | undefined {
    return this.agents.get(id)
  }

  /** Whether this dispatch call started a background agent that is still working. */
  isWorkingCall(callId: string): boolean {
    for (const a of this.agents.values()) if (a.callId === callId && !a.done) return true
    return false
  }

  /** Any agent whose report the model hasn't had yet (working, or done but not told). */
  hasUndelivered(): boolean {
    for (const a of this.agents.values()) if (!a.delivered) return true
    return false
  }

  /** The finished agents not yet told, marked told. */
  takeFinished(): BackgroundAgent[] {
    const out: BackgroundAgent[] = []
    for (const a of this.agents.values()) {
      if (a.done && !a.delivered) {
        a.delivered = true
        out.push(a)
      }
    }
    return out
  }

  /** Mark one agent's report told (wait_for returned it). */
  markDelivered(id: string): void {
    const a = this.agents.get(id)
    if (a) a.delivered = true
  }

  /** Resolve once every working agent is done, or `signal` aborts. */
  async waitAll(signal: AbortSignal): Promise<void> {
    while (this.running.size > 0 && !signal.aborted) {
      const aborted = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      await Promise.race([Promise.all([...this.running.values()]), aborted])
    }
  }

  /** Be told whenever an agent finishes; returns an unsubscribe function. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Stop every agent still working (the run is ending). */
  stop(): void {
    this.controller.abort()
  }

  /**
   * Stop every agent and give them up to `ms` to wind down, so each one's record ends
   * (as stopped) before the run's last event rather than after it.
   */
  async settle(ms = SETTLE_MS): Promise<void> {
    this.stop()
    if (this.running.size === 0) return
    const timeout = new AbortController()
    const t = setTimeout(() => timeout.abort(), ms)
    t.unref?.()
    try {
      await this.waitAll(timeout.signal)
    } finally {
      clearTimeout(t)
    }
  }
}

/** What the dispatch call returns for a background start. */
export function backgroundStartedText(a: BackgroundAgent): string {
  return (
    `Started background agent ${a.id} ("${a.label}"). It works on its own while you continue: ` +
    `its report arrives as a Houston note when it finishes, or call wait_for({ id: "${a.id}" }) to wait for it. ` +
    (a.writable ? "Don't edit the files it is working on until it reports. " : '') +
    'If you end your turn while it is still working, Houston waits for it and gives you its report first.'
  )
}

/** One finished agent's report, as wait_for returns it or a note carries it. */
export function backgroundReportText(a: BackgroundAgent): string {
  return `Background agent ${a.id} ("${a.label}") has finished. Its report:\n\n${a.result ?? '[no report]'}`
}

/** The note that hands finished background agents' reports to the model. */
export function backgroundAgentsNote(agents: BackgroundAgent[]): ChatMessage | null {
  if (agents.length === 0) return null
  return systemNoteMessage(
    `${agents.length === 1 ? 'A background agent you started has' : 'Background agents you started have'} finished.\n\n${agents
      .map(backgroundReportText)
      .join('\n\n')}`
  )
}
