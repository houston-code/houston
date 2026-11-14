import { describe, expect, it, vi } from 'vitest'
import { USER_SUBAGENT_STOP, canStopSubagent, isUserSubagentStop, registerSubagentStop, stopSubagent } from './subagentStops'

describe('subagent stop handles', () => {
  it('stops a registered agent once, then forgets it', () => {
    const stop = vi.fn()
    registerSubagentStop('run-a', 'sa1', stop)
    expect(canStopSubagent('run-a', 'sa1')).toBe(true)
    expect(stopSubagent('run-a', 'sa1')).toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stopSubagent('run-a', 'sa1')).toBe(false)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  // Record ids restart at sa1 in every run, so the run id is part of the name.
  it('keys by run, so the same record id in another run is a different agent', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = registerSubagentStop('run-a', 'sa1', a)
    const offB = registerSubagentStop('run-b', 'sa1', b)
    expect(stopSubagent('run-b', 'sa1')).toBe(true)
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
    offA()
    offB()
  })

  it('unregisters when the agent ends, and an old unregister never drops a newer handle', () => {
    const first = vi.fn()
    const off = registerSubagentStop('run-c', 'sa1', first)
    off()
    expect(stopSubagent('run-c', 'sa1')).toBe(false)
    const second = vi.fn()
    const offSecond = registerSubagentStop('run-c', 'sa1', second)
    off()
    expect(canStopSubagent('run-c', 'sa1')).toBe(true)
    offSecond()
    expect(canStopSubagent('run-c', 'sa1')).toBe(false)
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
  })

  it('reports an unknown agent as not stoppable', () => {
    expect(stopSubagent('run-none', 'sa9')).toBe(false)
  })

  // A nested agent's signal links to its parent's; the user's stop reason carries down,
  // while Stop and a run's end abort with another reason.
  it("tells a user's stop, passed down linked signals, from any other abort", () => {
    const run = new AbortController()
    const parentOwn = new AbortController()
    const parent = AbortSignal.any([run.signal, parentOwn.signal])
    const child = AbortSignal.any([parent, new AbortController().signal])
    parentOwn.abort(USER_SUBAGENT_STOP)
    expect(isUserSubagentStop(child.reason)).toBe(true)

    const run2 = new AbortController()
    const other = AbortSignal.any([run2.signal, new AbortController().signal])
    run2.abort()
    expect(other.aborted).toBe(true)
    expect(isUserSubagentStop(other.reason)).toBe(false)
  })
})
