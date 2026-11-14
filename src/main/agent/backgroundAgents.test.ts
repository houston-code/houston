import { describe, expect, it } from 'vitest'
import { SYSTEM_NOTE_PREFIX } from '@shared/agent'
import {
  BackgroundAgents,
  MAX_BACKGROUND_AGENTS,
  backgroundAgentsNote,
  backgroundReportText,
  backgroundStartedText,
  type BackgroundAgent
} from './backgroundAgents'

/** A dispatch the test finishes by hand. */
function gate(): { run: (signal: AbortSignal) => Promise<string>; finish: (s: string) => void; seen: AbortSignal[] } {
  let finish: (s: string) => void = () => {}
  const seen: AbortSignal[] = []
  return {
    run: (signal) => {
      seen.push(signal)
      return new Promise<string>((resolve) => {
        finish = resolve
        signal.addEventListener('abort', () => resolve('[aborted]'), { once: true })
      })
    },
    finish: (s) => finish(s),
    seen
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('BackgroundAgents', () => {
  it('starts an agent with an id, and records its report once it finishes', async () => {
    const reg = new BackgroundAgents(new AbortController().signal)
    const g = gate()
    const settled: string[] = []
    const changes: number[] = []
    reg.onChange(() => changes.push(reg.workingCount))
    const a = reg.start({ callId: 'd1', label: 'Find auth', writable: false }, g.run, (x) => settled.push(x.id)) as BackgroundAgent
    expect(a.id).toBe('bg1')
    await flush()
    expect(reg.workingCount).toBe(1)
    expect(reg.isWorkingCall('d1')).toBe(true)
    expect(reg.hasUndelivered()).toBe(true)
    expect(reg.takeFinished()).toEqual([])
    g.finish('auth is in src/auth.ts')
    await flush()
    expect(settled).toEqual(['bg1'])
    expect(changes).toEqual([0])
    expect(reg.isWorkingCall('d1')).toBe(false)
    const done = reg.takeFinished()
    expect(done.map((x) => [x.id, x.result])).toEqual([['bg1', 'auth is in src/auth.ts']])
    // Told once.
    expect(reg.takeFinished()).toEqual([])
    expect(reg.hasUndelivered()).toBe(false)
  })

  it('turns a dispatch that throws into a report saying so', async () => {
    const reg = new BackgroundAgents(new AbortController().signal)
    reg.start({ callId: 'd1', label: 'x', writable: false }, () => Promise.reject(new Error('provider down')))
    await flush()
    await flush()
    expect(reg.takeFinished()[0]?.result).toBe('[background agent failed: provider down]')
  })

  it(`refuses a start past ${MAX_BACKGROUND_AGENTS} working, and frees the slot when one finishes`, async () => {
    const reg = new BackgroundAgents(new AbortController().signal)
    const gates = Array.from({ length: MAX_BACKGROUND_AGENTS }, () => gate())
    for (const [i, g] of gates.entries()) reg.start({ callId: `d${i}`, label: `a${i}`, writable: false }, g.run)
    await flush()
    const refused = reg.start({ callId: 'dx', label: 'one too many', writable: false }, gate().run)
    expect(refused).toEqual({ refused: expect.stringMatching(/^4 background agents are already working \(bg1, bg2, bg3, bg4\)/) })
    gates[0]!.finish('ok')
    await flush()
    expect('id' in reg.start({ callId: 'dy', label: 'now fits', writable: false }, gate().run)).toBe(true)
  })

  it("follows the run's abort, and stops everything when the run ends", async () => {
    const run = new AbortController()
    const reg = new BackgroundAgents(run.signal)
    const g = gate()
    reg.start({ callId: 'd1', label: 'x', writable: false }, g.run)
    await flush()
    run.abort()
    await flush()
    expect(g.seen[0]!.aborted).toBe(true)
    expect(reg.takeFinished()[0]?.result).toBe('[aborted]')
    // Nothing new starts once the run is over.
    expect(reg.start({ callId: 'd2', label: 'late', writable: false }, gate().run)).toEqual({
      refused: expect.stringMatching(/turn is ending/)
    })

    const reg2 = new BackgroundAgents(new AbortController().signal)
    const g2 = gate()
    reg2.start({ callId: 'd1', label: 'x', writable: false }, g2.run)
    await flush()
    reg2.stop()
    await flush()
    expect(g2.seen[0]!.aborted).toBe(true)
  })

  it('waits for every working agent, or until the signal aborts', async () => {
    const reg = new BackgroundAgents(new AbortController().signal)
    const a = gate()
    const b = gate()
    reg.start({ callId: 'd1', label: 'a', writable: false }, a.run)
    reg.start({ callId: 'd2', label: 'b', writable: false }, b.run)
    await flush()
    let waited = false
    const p = reg.waitAll(new AbortController().signal).then(() => (waited = true))
    a.finish('a done')
    await flush()
    expect(waited).toBe(false)
    b.finish('b done')
    await p
    expect(reg.workingCount).toBe(0)

    const c = gate()
    reg.start({ callId: 'd3', label: 'c', writable: false }, c.run)
    await flush()
    const stop = new AbortController()
    const q = reg.waitAll(stop.signal)
    stop.abort()
    await q
    expect(reg.workingCount).toBe(1)
  })

  it('marks one delivered for wait_for, leaving others for the note', async () => {
    const reg = new BackgroundAgents(new AbortController().signal)
    reg.start({ callId: 'd1', label: 'a', writable: false }, async () => 'A')
    reg.start({ callId: 'd2', label: 'b', writable: false }, async () => 'B')
    await flush()
    await flush()
    reg.markDelivered('bg1')
    expect(reg.takeFinished().map((x) => x.id)).toEqual(['bg2'])
  })
})

describe('background agent texts', () => {
  const agent = (over: Partial<BackgroundAgent> = {}): BackgroundAgent => ({
    id: 'bg1',
    callId: 'd1',
    label: 'Find auth',
    writable: false,
    done: true,
    result: 'It is in src/auth.ts.',
    delivered: false,
    ...over
  })

  it('tells the model how the report comes back, and warns off shared files for a writable one', () => {
    expect(backgroundStartedText(agent())).toMatch(/^Started background agent bg1 \("Find auth"\)\..*wait_for\(\{ id: "bg1" \}\)/)
    expect(backgroundStartedText(agent())).not.toMatch(/Don't edit/)
    expect(backgroundStartedText(agent({ writable: true }))).toMatch(/Don't edit the files it is working on/)
  })

  it('hands reports over as one Houston note', () => {
    expect(backgroundAgentsNote([])).toBeNull()
    const one = backgroundAgentsNote([agent()])!
    expect(one.content.startsWith(SYSTEM_NOTE_PREFIX)).toBe(true)
    expect(one.content).toContain('A background agent you started has finished.')
    expect(one.content).toContain(backgroundReportText(agent()))
    const two = backgroundAgentsNote([agent(), agent({ id: 'bg2', label: 'Docs', result: 'Done.' })])!
    expect(two.content).toContain('Background agents you started have finished.')
    expect(two.content).toContain('Background agent bg2 ("Docs") has finished. Its report:\n\nDone.')
  })
})
