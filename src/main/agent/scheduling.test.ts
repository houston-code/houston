import { describe, it, expect } from 'vitest'
import { isParallelizableRead } from './scheduling'

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
