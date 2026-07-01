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

  it('splits reads into the parallel group and the rest into sequential', () => {
    const calls = [
      call('c0', 'read_file'),
      call('c1', 'write_file'),
      call('c2', 'read_file'),
      call('c3', 'run_shell')
    ]
    const { parallel, sequential } = partitionCalls(calls, isParallel)
    expect(parallel.map((p) => p.call.id)).toEqual(['c0', 'c2'])
    expect(sequential.map((s) => s.call.id)).toEqual(['c1', 'c3'])
  })

  it('tags each call with its original index', () => {
    const calls = [call('c0', 'write_file'), call('c1', 'read_file'), call('c2', 'read_file')]
    const { parallel, sequential } = partitionCalls(calls, isParallel)
    expect(parallel).toEqual([
      { call: calls[1], index: 1 },
      { call: calls[2], index: 2 }
    ])
    expect(sequential).toEqual([{ call: calls[0], index: 0 }])
  })

  it('preserves the original relative order within the sequential group', () => {
    const calls = [
      call('w0', 'write_file'),
      call('r0', 'read_file'),
      call('s0', 'run_shell'),
      call('w1', 'write_file')
    ]
    const { sequential } = partitionCalls(calls, isParallel)
    expect(sequential.map((s) => s.call.id)).toEqual(['w0', 's0', 'w1'])
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
})
