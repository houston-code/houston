import { describe, it, expect } from 'vitest'
import type { ToolCall } from '@shared/agent'
import { callSegments, isParallelizableRead, type CallSegment } from './scheduling'

const call = (id: string, name: string): ToolCall => ({ id, name, arguments: {} })

describe('isParallelizableRead', () => {
  it('parallelizes plain reads', () => {
    expect(isParallelizableRead('read', null, false, false)).toBe(true)
    expect(isParallelizableRead('read', 'allow', false, false)).toBe(true)
  })

  it('never parallelizes side-effecting kinds', () => {
    for (const kind of ['write', 'shell', 'network', 'mcp'] as const) {
      expect(isParallelizableRead(kind, null, false, false)).toBe(false)
    }
  })

  it('does not parallelize a read gated by a deny/ask rule', () => {
    expect(isParallelizableRead('read', 'deny', false, false)).toBe(false)
    expect(isParallelizableRead('read', 'ask', false, false)).toBe(false)
  })

  it('does not parallelize a read wrapped by a hook', () => {
    expect(isParallelizableRead('read', null, true, false)).toBe(false)
  })

  it('does not parallelize a read of a credential file, so it reaches the approval gate', () => {
    expect(isParallelizableRead('read', null, false, true)).toBe(false)
    // Even an allow rule leaves it sequential: the gate is where the allow is honored.
    expect(isParallelizableRead('read', 'allow', false, true)).toBe(false)
  })
})

describe('callSegments', () => {
  // Treat calls named 'read*' as parallelizable for these pure tests.
  const isParallel = (c: ToolCall): boolean => c.name.startsWith('read')
  // A batch as the array of its call ids, a barrier as its lone id.
  const shape = (segments: Iterable<CallSegment>): Array<string | string[]> =>
    [...segments].map((s) => (s.parallel ? s.calls.map((c) => c.call.id) : s.call.call.id))

  it('batches each maximal run of reads between barriers', () => {
    const calls = [
      call('c0', 'read_file'),
      call('c1', 'write_file'),
      call('c2', 'read_file'),
      call('c3', 'run_shell')
    ]
    // c2 follows the write, so it gets a batch of its own AFTER the write (intra-turn
    // causality: the read after a write must observe the write), and the shell call
    // waits for that batch.
    expect(shape(callSegments(calls, isParallel))).toEqual([['c0'], 'c1', ['c2'], 'c3'])
  })

  it('puts a read that follows a write in a batch after the write (read-after-write)', () => {
    const calls = [call('w0', 'write_file'), call('r0', 'read_file')]
    // No leading reads: the write runs alone first, then the read.
    expect(shape(callSegments(calls, isParallel))).toEqual(['w0', ['r0']])
  })

  it('tags each call with its original index', () => {
    const calls = [call('c0', 'read_file'), call('c1', 'read_file'), call('c2', 'write_file'), call('c3', 'read_file')]
    expect([...callSegments(calls, isParallel)]).toEqual([
      {
        parallel: true,
        calls: [
          { call: calls[0], index: 0 },
          { call: calls[1], index: 1 }
        ]
      },
      { parallel: false, call: { call: calls[2], index: 2 } },
      { parallel: true, calls: [{ call: calls[3], index: 3 }] }
    ])
  })

  it('keeps every call exactly once and in its original order', () => {
    const calls = [
      call('r0', 'read_file'),
      call('r1', 'read_file'),
      call('w0', 'write_file'),
      call('r2', 'read_file'),
      call('s0', 'run_shell')
    ]
    expect(shape(callSegments(calls, isParallel))).toEqual([['r0', 'r1'], 'w0', ['r2'], 's0'])
    const flat = [...callSegments(calls, isParallel)].flatMap((s) => (s.parallel ? s.calls : [s.call]))
    expect(flat.map((c) => c.index)).toEqual([0, 1, 2, 3, 4])
  })

  it('gives two concurrent batches around a write: [read, write, read, read]', () => {
    const calls = [call('r0', 'read_file'), call('w0', 'write_file'), call('r1', 'read_file'), call('r2', 'read_file')]
    expect(shape(callSegments(calls, isParallel))).toEqual([['r0'], 'w0', ['r1', 'r2']])
  })

  it('handles an all-reads turn (one batch)', () => {
    const calls = [call('r0', 'read_file'), call('r1', 'read_file')]
    expect(shape(callSegments(calls, isParallel))).toEqual([['r0', 'r1']])
  })

  it('handles an all-encumbered turn (each call alone, no batch)', () => {
    const calls = [call('w0', 'write_file'), call('s0', 'run_shell')]
    expect(shape(callSegments(calls, isParallel))).toEqual(['w0', 's0'])
  })

  it('runs a leading encumbered call alone, then the reads after it as one batch', () => {
    const calls = [call('w0', 'write_file'), call('r0', 'read_file'), call('r1', 'read_file')]
    expect(shape(callSegments(calls, isParallel))).toEqual(['w0', ['r0', 'r1']])
  })

  it('handles an empty turn', () => {
    expect(shape(callSegments([], isParallel))).toEqual([])
  })

  it('classifies lazily: the reads after a barrier are judged only once that segment is requested', () => {
    const calls = [call('r0', 'read_file'), call('w0', 'write_file'), call('r1', 'read_file'), call('r2', 'read_file')]
    const asked: string[] = []
    const segments = callSegments(calls, (c) => {
      asked.push(c.id)
      return isParallel(c)
    })
    // The first batch needs only its own reads and the call that ends it.
    expect(shape([segments.next().value as CallSegment])).toEqual([['r0']])
    expect(asked).toEqual(['r0', 'w0'])
    expect(shape([segments.next().value as CallSegment])).toEqual(['w0'])
    // Nothing after the write is judged before the write has been handed out (run).
    expect(asked).toEqual(['r0', 'w0', 'w0'])
    expect(shape([segments.next().value as CallSegment])).toEqual([['r1', 'r2']])
    expect(asked).toEqual(['r0', 'w0', 'w0', 'r1', 'r2'])
    expect(segments.next().done).toBe(true)
  })

  it('sees a verdict that changed while a barrier ran (a rule its approval added)', () => {
    // Stands in for "Always deny" on the write's prompt adding a deny rule that covers
    // the read after it: by the time that read is classified, it is no longer
    // parallel-safe, so it runs alone through the full gate instead of in a batch.
    const calls = [call('w0', 'write_file'), call('r0', 'read_file'), call('r1', 'read_file')]
    const denied = new Set<string>()
    const seen: Array<string | string[]> = []
    for (const segment of callSegments(calls, (c) => isParallel(c) && !denied.has(c.id))) {
      seen.push(...shape([segment]))
      if (!segment.parallel && segment.call.call.id === 'w0') denied.add('r0')
    }
    expect(seen).toEqual(['w0', 'r0', ['r1']])
  })
})
