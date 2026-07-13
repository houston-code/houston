import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@shared/agent'
import {
  StallDetector,
  callSignature,
  errorSignature,
  isMutatingKind,
  resolveStallThresholds,
  DEFAULT_STALL_THRESHOLDS,
  type StallThresholds
} from './stall'

const call = (name: string, args: Record<string, unknown> = {}, id = 'c'): ToolCall => ({
  id,
  name,
  arguments: args
})

const thresholds = (over: Partial<StallThresholds> = {}): StallThresholds => ({
  ...DEFAULT_STALL_THRESHOLDS,
  ...over
})

describe('callSignature', () => {
  it('is stable regardless of argument key order', () => {
    expect(callSignature(call('read_file', { a: 1, b: 2 }))).toBe(
      callSignature(call('read_file', { b: 2, a: 1 }))
    )
  })

  it('differs by tool name and by argument value', () => {
    expect(callSignature(call('read_file', { path: 'a' }))).not.toBe(
      callSignature(call('read_file', { path: 'b' }))
    )
    expect(callSignature(call('read_file', { path: 'a' }))).not.toBe(
      callSignature(call('grep', { path: 'a' }))
    )
  })

  it('sorts nested object keys too', () => {
    expect(callSignature(call('t', { x: { p: 1, q: 2 } }))).toBe(
      callSignature(call('t', { x: { q: 2, p: 1 } }))
    )
  })
})

describe('errorSignature', () => {
  it('strips the Error: prefix and collapses whitespace', () => {
    expect(errorSignature('Error:   no such\n  file')).toBe('no such file')
  })
  it('caps very long errors so their tail cannot defeat matching', () => {
    const long = 'x'.repeat(500)
    expect(errorSignature(long).length).toBe(200)
  })
  it('collapses two spellings of the same failure to one signature', () => {
    expect(errorSignature('Error: boom')).toBe(errorSignature('boom'))
  })
})

describe('isMutatingKind', () => {
  it('treats write and shell as mutating; others as not', () => {
    expect(isMutatingKind('write')).toBe(true)
    expect(isMutatingKind('shell')).toBe(true)
    expect(isMutatingKind('read')).toBe(false)
    expect(isMutatingKind('network')).toBe(false)
    expect(isMutatingKind('mcp')).toBe(false)
    expect(isMutatingKind(undefined)).toBe(false)
  })
})

describe('resolveStallThresholds', () => {
  it('falls back to defaults for undefined/invalid values', () => {
    expect(resolveStallThresholds()).toEqual(DEFAULT_STALL_THRESHOLDS)
    expect(resolveStallThresholds({ repeatCallLimit: 0 }).repeatCallLimit).toBe(
      DEFAULT_STALL_THRESHOLDS.repeatCallLimit
    )
    expect(resolveStallThresholds({ repeatCallLimit: 1 }).repeatCallLimit).toBe(
      DEFAULT_STALL_THRESHOLDS.repeatCallLimit
    )
  })
  it('accepts and floors valid overrides (min 2)', () => {
    expect(resolveStallThresholds({ repeatCallLimit: 5.9 }).repeatCallLimit).toBe(5)
    expect(resolveStallThresholds({ noProgressLimit: 2 }).noProgressLimit).toBe(2)
  })
})

describe('StallDetector — repeated calls', () => {
  it('nudges once at the repeat limit, then stops on persistence', () => {
    const d = new StallDetector(thresholds({ repeatCallLimit: 3 }))
    const obs = { calls: [call('read_file', { path: 'a' })], errors: [], mutated: false }
    expect(d.observe(obs).kind).toBe('ok') // 1
    expect(d.observe(obs).kind).toBe('ok') // 2
    const nudge = d.observe(obs) // 3 → nudge
    expect(nudge.kind).toBe('nudge')
    if (nudge.kind === 'nudge') expect(nudge.message).toMatch(/repeating the same tool call/i)
    // Counters reset after the nudge, so it takes another full window to stop.
    expect(d.observe(obs).kind).toBe('ok') // 1 (post-reset)
    expect(d.observe(obs).kind).toBe('ok') // 2
    expect(d.observe(obs).kind).toBe('stop') // 3 → stop
  })

  it('resets the tally when the call pattern changes', () => {
    const d = new StallDetector(thresholds({ repeatCallLimit: 3 }))
    const a = { calls: [call('read_file', { path: 'a' })], errors: [], mutated: false }
    const b = { calls: [call('read_file', { path: 'b' })], errors: [], mutated: false }
    expect(d.observe(a).kind).toBe('ok')
    expect(d.observe(a).kind).toBe('ok')
    expect(d.observe(b).kind).toBe('ok') // different — resets
    expect(d.observe(b).kind).toBe('ok')
    expect(d.observe(b).kind).toBe('nudge') // three b's in a row
  })

  it('matches a repeated multi-call batch regardless of order', () => {
    const d = new StallDetector(thresholds({ repeatCallLimit: 2 }))
    const first = {
      calls: [call('read_file', { path: 'a' }, 'c1'), call('grep', { q: 'x' }, 'c2')],
      errors: [],
      mutated: false
    }
    const reordered = {
      calls: [call('grep', { q: 'x' }, 'c3'), call('read_file', { path: 'a' }, 'c4')],
      errors: [],
      mutated: false
    }
    expect(d.observe(first).kind).toBe('ok')
    expect(d.observe(reordered).kind).toBe('nudge')
  })
})

describe('StallDetector — repeated errors', () => {
  it('nudges on the same error signature repeating (call-repeat rule disabled)', () => {
    // Raise the call-repeat limit out of the way so this isolates the error rule;
    // vary the command each turn so it's the shared *error* that trips, not the call.
    const d = new StallDetector(thresholds({ repeatErrorLimit: 3, repeatCallLimit: 99 }))
    const obs = (i: number): { calls: ToolCall[]; errors: string[]; mutated: boolean } => ({
      calls: [call('run_shell', { command: `x${i}` })],
      errors: [errorSignature('Error: permission denied')],
      mutated: false
    })
    expect(d.observe(obs(0)).kind).toBe('ok')
    expect(d.observe(obs(1)).kind).toBe('ok')
    const nudge = d.observe(obs(2))
    expect(nudge.kind).toBe('nudge')
    if (nudge.kind === 'nudge') expect(nudge.message).toMatch(/same error/i)
  })

  it('does not nudge when errors differ each time', () => {
    const d = new StallDetector(thresholds({ repeatErrorLimit: 3 }))
    for (let i = 0; i < 5; i++) {
      const r = d.observe({
        calls: [call('run_shell', { command: `x${i}` })],
        errors: [errorSignature(`fail ${i}`)],
        mutated: false
      })
      // The calls also differ each turn, so neither repeat trips.
      expect(r.kind).toBe('ok')
    }
  })
})

describe('StallDetector — no progress', () => {
  it('nudges after N consecutive non-mutating turns and resets on a mutation', () => {
    const d = new StallDetector(thresholds({ noProgressLimit: 3, repeatCallLimit: 99 }))
    // Vary the calls so the repeated-call rule never fires; only no-progress can.
    const read = (p: string): { calls: ToolCall[]; errors: string[]; mutated: boolean } => ({
      calls: [call('read_file', { path: p })],
      errors: [],
      mutated: false
    })
    expect(d.observe(read('a')).kind).toBe('ok') // 1
    expect(d.observe(read('b')).kind).toBe('ok') // 2
    expect(d.observe(read('c')).kind).toBe('nudge') // 3 → nudge
    // A mutating turn clears the no-progress counter.
    expect(
      d.observe({ calls: [call('edit_file', { path: 'a' })], errors: [], mutated: true }).kind
    ).toBe('ok')
    expect(d.observe(read('d')).kind).toBe('ok') // 1 again
    expect(d.observe(read('e')).kind).toBe('ok') // 2
    expect(d.observe(read('f')).kind).toBe('stop') // 3 → stop (already nudged)
  })
})

describe('StallDetector — interactive no-progress', () => {
  const read = (p: string): { calls: ToolCall[]; errors: string[]; mutated: boolean } => ({
    calls: [call('read_file', { path: p })],
    errors: [],
    mutated: false
  })

  it('nudges once but never hard-stops read-only work when a user is watching', () => {
    const d = new StallDetector(thresholds({ noProgressLimit: 3, repeatCallLimit: 99 }), {
      interactive: true
    })
    expect(d.observe(read('a')).kind).toBe('ok') // 1
    expect(d.observe(read('b')).kind).toBe('ok') // 2
    expect(d.observe(read('c')).kind).toBe('nudge') // 3 → single corrective nudge
    // Past the nudge, more read-only turns must NOT stop the run — the user is
    // present and this is legitimate investigation. It stays quiet indefinitely.
    for (let i = 0; i < 12; i++) {
      expect(d.observe(read(`x${i}`)).kind).toBe('ok')
    }
  })

  it('still stops on the stronger repeated-call stall even when interactive', () => {
    const d = new StallDetector(thresholds({ repeatCallLimit: 3 }), { interactive: true })
    const same = { calls: [call('read_file', { path: 'a' })], errors: [], mutated: false }
    expect(d.observe(same).kind).toBe('ok') // 1
    expect(d.observe(same).kind).toBe('ok') // 2
    expect(d.observe(same).kind).toBe('nudge') // 3 → nudge
    expect(d.observe(same).kind).toBe('ok') // reset window
    expect(d.observe(same).kind).toBe('ok')
    expect(d.observe(same).kind).toBe('stop') // repeats past the nudge → stop
  })

  it('still stops on the stronger repeated-error stall even when interactive', () => {
    const d = new StallDetector(thresholds({ repeatErrorLimit: 3, repeatCallLimit: 99 }), {
      interactive: true
    })
    const fail = (i: number): { calls: ToolCall[]; errors: string[]; mutated: boolean } => ({
      calls: [call('run_shell', { cmd: `try-${i}` })], // vary calls so only the error repeats
      errors: ['Error: ENOENT no such file'],
      mutated: false
    })
    expect(d.observe(fail(0)).kind).toBe('ok')
    expect(d.observe(fail(1)).kind).toBe('ok')
    expect(d.observe(fail(2)).kind).toBe('nudge')
    expect(d.observe(fail(3)).kind).toBe('ok')
    expect(d.observe(fail(4)).kind).toBe('ok')
    expect(d.observe(fail(5)).kind).toBe('stop')
  })

  it('keeps the no-progress stop for headless runs (interactive not set)', () => {
    const d = new StallDetector(thresholds({ noProgressLimit: 3, repeatCallLimit: 99 }))
    expect(d.observe(read('a')).kind).toBe('ok')
    expect(d.observe(read('b')).kind).toBe('ok')
    expect(d.observe(read('c')).kind).toBe('nudge')
    expect(d.observe(read('d')).kind).toBe('ok')
    expect(d.observe(read('e')).kind).toBe('ok')
    expect(d.observe(read('f')).kind).toBe('stop') // headless still stops
  })
})

describe('StallDetector — healthy runs', () => {
  it('never fires when the model makes varied, mutating progress', () => {
    const d = new StallDetector()
    for (let i = 0; i < 20; i++) {
      const r = d.observe({
        calls: [call('edit_file', { path: `f${i}` })],
        errors: [],
        mutated: true
      })
      expect(r.kind).toBe('ok')
    }
  })
})
