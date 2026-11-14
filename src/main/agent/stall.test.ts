import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@shared/agent'
import {
  StallDetector,
  callSignature,
  commandFailureOf,
  errorSignature,
  failedCallKey,
  resolveStallThresholds,
  DEFAULT_STALL_THRESHOLDS,
  SILENT_CHECK_IN,
  SILENT_ITERATION_LIMIT,
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
    expect(resolveStallThresholds({ repeatErrorLimit: 2 }).repeatErrorLimit).toBe(2)
  })
})

describe('StallDetector — repeated calls', () => {
  it('nudges once at the repeat limit, then stops on persistence', () => {
    const d = new StallDetector(thresholds({ repeatCallLimit: 3 }))
    const obs = { calls: [call('read_file', { path: 'a' })], errors: [] }
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
    const a = { calls: [call('read_file', { path: 'a' })], errors: [] }
    const b = { calls: [call('read_file', { path: 'b' })], errors: [] }
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
      errors: []
    }
    const reordered = {
      calls: [call('grep', { q: 'x' }, 'c3'), call('read_file', { path: 'a' }, 'c4')],
      errors: []
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
    const obs = (i: number): { calls: ToolCall[]; errors: string[] } => ({
      calls: [call('run_shell', { command: `x${i}` })],
      errors: [errorSignature('Error: permission denied')]
    })
    expect(d.observe(obs(0)).kind).toBe('ok')
    expect(d.observe(obs(1)).kind).toBe('ok')
    const nudge = d.observe(obs(2))
    expect(nudge.kind).toBe('nudge')
    if (nudge.kind === 'nudge') expect(nudge.message).toMatch(/same error/i)
  })

  it('stops when the same error persists past the nudge', () => {
    const d = new StallDetector(thresholds({ repeatErrorLimit: 3, repeatCallLimit: 99 }))
    const fail = (i: number): { calls: ToolCall[]; errors: string[] } => ({
      calls: [call('run_shell', { cmd: `try-${i}` })], // vary calls so only the error repeats
      errors: ['Error: ENOENT no such file']
    })
    expect(d.observe(fail(0)).kind).toBe('ok')
    expect(d.observe(fail(1)).kind).toBe('ok')
    expect(d.observe(fail(2)).kind).toBe('nudge')
    expect(d.observe(fail(3)).kind).toBe('ok') // reset window
    expect(d.observe(fail(4)).kind).toBe('ok')
    expect(d.observe(fail(5)).kind).toBe('stop')
  })

  it('does not nudge when errors differ each time', () => {
    const d = new StallDetector(thresholds({ repeatErrorLimit: 3 }))
    for (let i = 0; i < 5; i++) {
      const r = d.observe({
        calls: [call('run_shell', { command: `x${i}` })],
        errors: [errorSignature(`fail ${i}`)]
      })
      // The calls also differ each turn, so neither repeat trips.
      expect(r.kind).toBe('ok')
    }
  })
})

describe('StallDetector — healthy runs', () => {
  it('never fires when the model makes varied tool calls', () => {
    const d = new StallDetector()
    for (let i = 0; i < 20; i++) {
      const r = d.observe({ calls: [call('edit_file', { path: `f${i}` })], errors: [] })
      expect(r.kind).toBe('ok')
    }
  })

  it('never fires on long read-only investigation (no no-progress rule)', () => {
    // Regression for the removed no-progress rule: many distinct read-only turns
    // with no file mutation are legitimate investigation and must never stall.
    const d = new StallDetector()
    for (let i = 0; i < 30; i++) {
      const r = d.observe({ calls: [call('read_file', { path: `f${i}` })], errors: [] })
      expect(r.kind).toBe('ok')
    }
  })
})

describe('commandFailureOf', () => {
  it('reads a non-zero exit from run_shell output', () => {
    const f = commandFailureOf(call('run_shell', { command: 'npm test' }), 'FAIL a.test.ts\n[exit code: 1]')
    expect(f).toMatchObject({ command: 'npm test', exitCode: 1 })
  })
  it('ignores a pass, a kill, a background start, and other tools', () => {
    expect(commandFailureOf(call('run_shell', { command: 'ls' }), 'a\n[exit code: 0]')).toBeNull()
    expect(commandFailureOf(call('run_shell', { command: 'sleep 9' }), '[exit code: killed]')).toBeNull()
    expect(commandFailureOf(call('run_shell', { command: 'dev', background: true }), '[exit code: 1]')).toBeNull()
    expect(commandFailureOf(call('read_file', { path: 'a' }), '[exit code: 1]')).toBeNull()
  })
})

describe('errorSignature: failed edits', () => {
  it('collapses retries whose closest-match hint shifts', () => {
    const a = failedCallKey(
      call('edit_file', { path: 'src/a.ts' }),
      'Error: old_string was not found in the file. The closest match is line 11 (90% similar):\n11 | x'
    )
    const b = failedCallKey(
      call('edit_file', { path: 'src/a.ts' }),
      'Error: old_string was not found in the file. The closest match is lines 11-12 (95% similar):\n11 | y'
    )
    const other = failedCallKey(
      call('edit_file', { path: 'src/b.ts' }),
      'Error: old_string was not found in the file. The closest match is line 3 (80% similar):\n3 | z'
    )
    expect(errorSignature(a)).toBe(errorSignature(b))
    expect(errorSignature(a)).not.toBe(errorSignature(other))
  })
})

describe('StallDetector: windowed loops', () => {
  const testFail = (out = 'FAIL sum.test.ts > adds\nexpected 3, got 4\nDuration 1.2s'): {
    command: string
    exitCode: number
    output: string
  } => ({ command: 'npm test', exitCode: 1, output: `${out}\n[exit code: 1]` })

  it('nudges when a command keeps failing the same way between edits', () => {
    const d = new StallDetector()
    const results: string[] = []
    for (let i = 0; i < 3; i++) {
      results.push(d.observe({ calls: [call('edit_file', { path: 'a.ts', n: i })], errors: [], changed: true }).kind)
      results.push(
        d.observe({
          calls: [call('run_shell', { command: 'npm test' })],
          errors: [],
          changed: true,
          // Timings differ run to run; the failure is the same.
          commandFailures: [testFail(`FAIL sum.test.ts > adds\nexpected 3, got 4\nDuration ${i + 1}.0s`)]
        }).kind
      )
    }
    expect(results.slice(0, 5)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
    expect(results[5]).toBe('nudge')
  })

  it('does not nudge when the failure changes between runs (progress)', () => {
    const d = new StallDetector()
    for (let i = 0; i < 6; i++) {
      d.observe({ calls: [call('edit_file', { path: 'a.ts', n: i })], errors: [], changed: true })
      const r = d.observe({
        calls: [call('run_shell', { command: 'npm test' })],
        errors: [],
        changed: true,
        commandFailures: [testFail(`Tests ${6 - i} failed`)]
      })
      expect(r.kind).toBe('ok')
    }
  })

  it('catches an A/B/A/B re-read with nothing changed', () => {
    const d = new StallDetector()
    const a = call('read_file', { path: 'a.ts' })
    const b = call('read_file', { path: 'b.ts' })
    const kinds = [a, b, a, b, a].map((c) => d.observe({ calls: [c], errors: [], reads: [c], changed: false }).kind)
    expect(kinds).toEqual(['ok', 'ok', 'ok', 'ok', 'nudge'])
  })

  it('does not count re-reads separated by a change', () => {
    const d = new StallDetector()
    const a = call('read_file', { path: 'a.ts' })
    for (let i = 0; i < 6; i++) {
      expect(d.observe({ calls: [a], errors: [], reads: [a], changed: false }).kind).toBe('ok')
      expect(d.observe({ calls: [call('edit_file', { path: 'a.ts', n: i })], errors: [], changed: true }).kind).toBe('ok')
    }
  })

  it('catches the same error coming back with other calls in between', () => {
    const d = new StallDetector()
    const err = failedCallKey(call('edit_file', { path: 'a.ts' }), 'Error: old_string was not found in the file.')
    const kinds = [0, 1, 2, 3, 4].map((i) =>
      d.observe({ calls: [call('edit_file', { path: 'a.ts', n: i })], errors: i % 2 === 0 ? [err] : [] }).kind
    )
    expect(kinds).toEqual(['ok', 'ok', 'ok', 'ok', 'nudge'])
  })

  it('nudges when a file keeps going back to an earlier version', () => {
    const d = new StallDetector()
    const edit = (i: number, reverts: string[] = []): string =>
      d.observe({ calls: [call('edit_file', { path: 'a.ts', n: i })], errors: [], changed: true, reverts }).kind
    expect(edit(0)).toBe('ok')
    expect(edit(1, ['a.ts'])).toBe('ok') // one undo is normal
    expect(edit(2)).toBe('ok')
    expect(edit(3, ['a.ts'])).toBe('nudge')
  })

  it('stops when the loop persists after the nudge', () => {
    const d = new StallDetector()
    const a = call('read_file', { path: 'a.ts' })
    const b = call('read_file', { path: 'b.ts' })
    const seq = [a, b, a, b, a, b, a, b, a, b].map((c) => d.observe({ calls: [c], errors: [], reads: [c] }).kind)
    expect(seq).toContain('nudge')
    expect(seq.at(-1)).toBe('stop')
  })
})

describe('StallDetector silent-run check-in', () => {
  // Each iteration a different read, so none of the stall checks can trip.
  const quiet = (i: number, over: { spoke?: boolean; wrote?: boolean } = { spoke: false }) => ({
    calls: [call('run_shell', { command: `git log -${i}` })],
    errors: [],
    changed: true,
    ...over
  })

  it('asks for a status update after a long run of silent tool calls, and only then', () => {
    const d = new StallDetector()
    for (let i = 1; i < SILENT_ITERATION_LIMIT; i++) expect(d.observe(quiet(i))).toEqual({ kind: 'ok' })
    expect(d.observe(quiet(SILENT_ITERATION_LIMIT))).toEqual({ kind: 'nudge', message: SILENT_CHECK_IN, checkIn: true })
    // The count starts over after the check-in.
    expect(d.observe(quiet(SILENT_ITERATION_LIMIT + 1))).toEqual({ kind: 'ok' })
  })

  it('never stops the run, however long the silence lasts', () => {
    const d = new StallDetector()
    const kinds = new Set<string>()
    for (let i = 1; i <= SILENT_ITERATION_LIMIT * 3; i++) kinds.add(d.observe(quiet(i)).kind)
    expect(kinds).toEqual(new Set(['ok', 'nudge']))
  })

  it('starts the count over when the model says something, writes a file, or ends with text', () => {
    for (const reset of [{ spoke: true }, { spoke: false, wrote: true }]) {
      const d = new StallDetector()
      for (let i = 1; i < SILENT_ITERATION_LIMIT; i++) d.observe(quiet(i))
      expect(d.observe(quiet(100, reset))).toEqual({ kind: 'ok' })
      for (let i = 1; i < SILENT_ITERATION_LIMIT; i++) expect(d.observe(quiet(200 + i)).kind).toBe('ok')
    }
    const d = new StallDetector()
    for (let i = 1; i < SILENT_ITERATION_LIMIT; i++) d.observe(quiet(i))
    expect(d.observe({ calls: [], errors: [], spoke: true })).toEqual({ kind: 'ok' })
    expect(d.observe(quiet(500)).kind).toBe('ok')
  })

  it('is off for a caller that does not report speech (a subagent)', () => {
    const d = new StallDetector()
    for (let i = 1; i <= SILENT_ITERATION_LIMIT * 2; i++) {
      expect(d.observe({ calls: [call('run_shell', { command: `ls ${i}` })], errors: [] })).toEqual({ kind: 'ok' })
    }
  })

  it('lets a real stall win, and a check-in does not count toward stopping', () => {
    const d = new StallDetector()
    for (let i = 1; i < SILENT_ITERATION_LIMIT; i++) d.observe(quiet(i))
    // The same failing call three times in a row: a stall, reported as one (not a check-in).
    const same = { calls: [call('read_file', { path: 'gone.ts' })], errors: ['Error: ENOENT gone.ts'], spoke: false }
    d.observe(same)
    d.observe(same)
    const first = d.observe(same)
    expect(first.kind).toBe('nudge')
    expect(first.kind === 'nudge' && first.checkIn).toBeUndefined()
    // A later check-in doesn't escalate; only the stall persisting does.
    const d2 = new StallDetector()
    for (let i = 1; i <= SILENT_ITERATION_LIMIT; i++) d2.observe(quiet(i))
    d2.observe(same)
    d2.observe(same)
    expect(d2.observe(same).kind).toBe('nudge')
  })
})
