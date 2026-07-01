import { describe, it, expect } from 'vitest'
import type { ToolCall } from '@shared/agent'
import { isParallelizableRead, partitionCalls } from './scheduling'

const call = (id: string, name: string): ToolCall => ({ id, name, arguments: {} })

describe('isParallelizableRead', () => {
  it('parallelizes plain reads', () => {
    expect(isParallelizableRead('read', null, false)).toBe(true)
    expect(isParallelizableRead('read', 'allow', false)).toBe(true)
  })

  it('never parallelizes side-effecting kinds', () => {
    for (const kind of ['write', 'shell', 'network', 'mcp'] as const) {
      expect(isParallelizableRead(kind, null, false)).toBe(false)
    }
  })

  it('does not parallelize a read gated by a deny/ask rule', () => {
    expect(isParallelizableRead('read', 'deny', false)).toBe(false)
    expect(isParallelizableRead('read', 'ask', false)).toBe(false)
  })

  it('does not parallelize a read wrapped by a hook', () => {
    expect(isParallelizableRead('read', null, true)).toBe(false)
  })
})

describe('partitionCalls', () => {
  // Treat calls named 'read*' as parallelizable for these pure tests.
  const isParallel = (c: ToolCall): boolean => c.name.startsWith('read')

  it('parallelizes only the contiguous LEADING run of reads', () => {
    const calls = [
      call('c0', 'read_file'),
      call('c1', 'write_file'),
      call('c2', 'read_file'),
      call('c3', 'run_shell')
    ]
    const { parallel, sequential } = partitionCalls(calls, isParallel)
    // Only c0 leads; c2 follows the write so it stays sequential (intra-turn
    // causality — the read after a write must observe the write).
    expect(parallel.map((p) => p.call.id)).toEqual(['c0'])
    expect(sequential.map((s) => s.call.id)).toEqual(['c1', 'c2', 'c3'])
  })

  it('sends a read that follows a write to the sequential group (read-after-write)', () => {
    const calls = [call('w0', 'write_file'), call('r0', 'read_file')]
    const { parallel, sequential } = partitionCalls(calls, isParallel)
    // No leading reads → empty parallel group; the read runs after the write.
    expect(parallel).toHaveLength(0)
    expect(sequential.map((s) => s.call.id)).toEqual(['w0', 'r0'])
  })

  it('tags each call with its original index', () => {
    const calls = [call('c0', 'read_file'), call('c1', 'read_file'), call('c2', 'write_file')]
    const { parallel, sequential } = partitionCalls(calls, isParallel)
    expect(parallel).toEqual([
      { call: calls[0], index: 0 },
      { call: calls[1], index: 1 }
    ])
    expect(sequential).toEqual([{ call: calls[2], index: 2 }])
  })

  it('keeps the parallel group contiguous from the start and sequential in order', () => {
    const calls = [
      call('r0', 'read_file'),
      call('r1', 'read_file'),
      call('w0', 'write_file'),
      call('r2', 'read_file'),
      call('s0', 'run_shell')
    ]
    const { parallel, sequential } = partitionCalls(calls, isParallel)
    expect(parallel.map((p) => p.call.id)).toEqual(['r0', 'r1'])
    // Everything from the first write on, including the later read, stays in order.
    expect(sequential.map((s) => s.call.id)).toEqual(['w0', 'r2', 's0'])
  })

  it('handles an all-reads turn (sequential empty)', () => {
    const calls = [call('r0', 'read_file'), call('r1', 'read_file')]
    const { parallel, sequential } = partitionCalls(calls, isParallel)
    expect(parallel).toHaveLength(2)
    expect(sequential).toHaveLength(0)
  })

  it('handles an all-encumbered turn (parallel empty)', () => {
    const calls = [call('w0', 'write_file'), call('s0', 'run_shell')]
    const { parallel, sequential } = partitionCalls(calls, isParallel)
    expect(parallel).toHaveLength(0)
    expect(sequential).toHaveLength(2)
  })

  it('sends a leading encumbered call and following reads all to sequential', () => {
    const calls = [call('w0', 'write_file'), call('r0', 'read_file'), call('r1', 'read_file')]
    const { parallel, sequential } = partitionCalls(calls, isParallel)
    expect(parallel).toHaveLength(0)
    expect(sequential.map((s) => s.call.id)).toEqual(['w0', 'r0', 'r1'])
  })
})
