import { describe, expect, it } from 'vitest'
import { parsePatch } from './apply-patch'

const wrap = (...body: string[]): string => ['*** Begin Patch', ...body, '*** End Patch'].join('\n')

describe('parsePatch', () => {
  it('parses an Add File op', () => {
    const ops = parsePatch(wrap('*** Add File: a/new.ts', '+line one', '+line two'))
    expect(ops).toEqual([{ type: 'add', path: 'a/new.ts', content: 'line one\nline two' }])
  })

  it('parses a Delete File op', () => {
    expect(parsePatch(wrap('*** Delete File: gone.ts'))).toEqual([{ type: 'delete', path: 'gone.ts' }])
  })

  it('parses an Update File op with a context hunk', () => {
    const ops = parsePatch(
      wrap('*** Update File: x.ts', '@@', ' keep', '-old line', '+new line', ' tail')
    )
    expect(ops).toEqual([
      {
        type: 'update',
        path: 'x.ts',
        moveTo: undefined,
        hunks: [{ oldText: 'keep\nold line\ntail', newText: 'keep\nnew line\ntail' }]
      }
    ])
  })

  it('parses a Move (rename)', () => {
    const ops = parsePatch(
      wrap('*** Update File: old.ts', '*** Move to: new.ts', ' a', '-b', '+B')
    )
    expect(ops[0]).toMatchObject({ type: 'update', path: 'old.ts', moveTo: 'new.ts' })
  })

  it('splits multiple hunks on @@', () => {
    const ops = parsePatch(
      wrap('*** Update File: x.ts', '@@', ' a', '-b', '+B', '@@', ' c', '-d', '+D')
    )
    const op = ops[0]
    expect(op.type).toBe('update')
    if (op.type === 'update') expect(op.hunks).toHaveLength(2)
  })

  it('parses several files in one envelope', () => {
    const ops = parsePatch(
      wrap('*** Add File: a.ts', '+x', '*** Delete File: b.ts', '*** Update File: c.ts', ' p', '-q', '+Q')
    )
    expect(ops.map((o) => o.type)).toEqual(['add', 'delete', 'update'])
  })

  it('tolerates CRLF and surrounding blank lines', () => {
    const patch = ['', '*** Begin Patch', '*** Delete File: g.ts', '*** End Patch', ''].join('\r\n')
    expect(parsePatch(patch)).toEqual([{ type: 'delete', path: 'g.ts' }])
  })

  it('rejects a missing envelope', () => {
    expect(() => parsePatch('*** Add File: a\n+x')).toThrow(/must start with/)
  })

  it('rejects an update hunk with nothing to anchor on', () => {
    expect(() => parsePatch(wrap('*** Update File: x.ts', '+only an addition'))).toThrow(
      /no context or removed lines/
    )
  })

  it('rejects an unexpected line', () => {
    expect(() => parsePatch(wrap('garbage line'))).toThrow(/Unexpected line/)
  })
})
