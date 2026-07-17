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

  it('rejects an empty Move to destination (rather than silently dropping the rename)', () => {
    expect(() =>
      parsePatch(wrap('*** Update File: old.ts', '*** Move to:   ', ' a', '-b', '+B'))
    ).toThrow(/Move to: missing destination/)
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

const diff = (...body: string[]): string => body.join('\n')

describe('parsePatch — unified diff / git diff', () => {
  it('parses a git-diff modification', () => {
    const ops = parsePatch(
      diff(
        'diff --git a/x.ts b/x.ts',
        'index e69de29..1111111 100644',
        '--- a/x.ts',
        '+++ b/x.ts',
        '@@ -1,3 +1,3 @@',
        ' keep',
        '-old line',
        '+new line',
        ' tail'
      )
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

  it('parses a plain unified diff with no git header', () => {
    const ops = parsePatch(diff('--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '-a', '+b'))
    expect(ops).toEqual([
      { type: 'update', path: 'x.ts', moveTo: undefined, hunks: [{ oldText: 'a', newText: 'b' }] }
    ])
  })

  it('parses a file addition (--- /dev/null)', () => {
    const ops = parsePatch(
      diff(
        'diff --git a/new.ts b/new.ts',
        'new file mode 100644',
        'index 0000000..2222222',
        '--- /dev/null',
        '+++ b/new.ts',
        '@@ -0,0 +1,2 @@',
        '+line one',
        '+line two'
      )
    )
    expect(ops).toEqual([{ type: 'add', path: 'new.ts', content: 'line one\nline two' }])
  })

  it('parses a file deletion (+++ /dev/null)', () => {
    const ops = parsePatch(
      diff('--- a/gone.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-line one', '-line two')
    )
    expect(ops).toEqual([{ type: 'delete', path: 'gone.ts' }])
  })

  it('detects a deletion from the git "deleted file mode" header', () => {
    const ops = parsePatch(
      diff(
        'diff --git a/gone.ts b/gone.ts',
        'deleted file mode 100644',
        '--- a/gone.ts',
        '+++ b/gone.ts',
        '@@ -1 +0,0 @@',
        '-x'
      )
    )
    expect(ops).toEqual([{ type: 'delete', path: 'gone.ts' }])
  })

  it('maps a rename with content changes to a Move', () => {
    const ops = parsePatch(
      diff(
        'diff --git a/old.ts b/new.ts',
        'similarity index 90%',
        'rename from old.ts',
        'rename to new.ts',
        '--- a/old.ts',
        '+++ b/new.ts',
        '@@ -1 +1 @@',
        '-a',
        '+b'
      )
    )
    expect(ops).toEqual([
      {
        type: 'update',
        path: 'old.ts',
        moveTo: 'new.ts',
        hunks: [{ oldText: 'a', newText: 'b' }]
      }
    ])
  })

  it('maps a 100%-similar rename (no hunks) to a Move', () => {
    const ops = parsePatch(
      diff(
        'diff --git a/old.ts b/new.ts',
        'similarity index 100%',
        'rename from old.ts',
        'rename to new.ts'
      )
    )
    expect(ops).toEqual([{ type: 'update', path: 'old.ts', moveTo: 'new.ts', hunks: [] }])
  })

  it('consumes hunks by line count, so a removed "--- " line is content not a header', () => {
    // The removed source line is literally "-- x"; its diff form "--- x" collides
    // with a file header. Count-driven consumption keeps it as removed content.
    const ops = parsePatch(diff('--- a/x.ts', '+++ b/x.ts', '@@ -1,2 +1,1 @@', ' keep', '--- x'))
    expect(ops).toEqual([
      {
        type: 'update',
        path: 'x.ts',
        moveTo: undefined,
        hunks: [{ oldText: 'keep\n-- x', newText: 'keep' }]
      }
    ])
  })

  it('parses multiple files in one diff', () => {
    const ops = parsePatch(
      diff(
        '--- a/one.ts',
        '+++ b/one.ts',
        '@@ -1 +1 @@',
        '-x',
        '+X',
        '--- a/two.ts',
        '+++ b/two.ts',
        '@@ -1 +1 @@',
        '-y',
        '+Y'
      )
    )
    expect(ops.map((o) => [o.type, o.path])).toEqual([
      ['update', 'one.ts'],
      ['update', 'two.ts']
    ])
  })

  it('splits multiple hunks in one file', () => {
    const ops = parsePatch(
      diff('--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '-a', '+A', '@@ -5 +5 @@', '-b', '+B')
    )
    const op = ops[0]
    expect(op.type).toBe('update')
    if (op.type === 'update') expect(op.hunks).toHaveLength(2)
  })

  it('ignores a "\\ No newline at end of file" marker', () => {
    const ops = parsePatch(
      diff('--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '-a', '\\ No newline at end of file', '+b')
    )
    expect(ops).toEqual([
      { type: 'update', path: 'x.ts', moveTo: undefined, hunks: [{ oldText: 'a', newText: 'b' }] }
    ])
  })

  it('strips a trailing tab timestamp from ---/+++ paths', () => {
    const ops = parsePatch(
      diff(
        '--- a/src/x.ts\t2026-01-01 12:00:00.000000000 +0000',
        '+++ b/src/x.ts\t2026-01-01 12:00:01.000000000 +0000',
        '@@ -1 +1 @@',
        '-a',
        '+b'
      )
    )
    expect(ops[0]).toMatchObject({ type: 'update', path: 'src/x.ts' })
  })

  it('tolerates CRLF', () => {
    const patch = ['--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '-a', '+b'].join('\r\n')
    expect(parsePatch(patch)).toEqual([
      { type: 'update', path: 'x.ts', moveTo: undefined, hunks: [{ oldText: 'a', newText: 'b' }] }
    ])
  })

  it('rejects a zero-context (-U0) insertion the text matcher cannot locate', () => {
    expect(() =>
      parsePatch(diff('--- a/x.ts', '+++ b/x.ts', '@@ -2,0 +3 @@', '+inserted'))
    ).toThrow(/no context or removed lines/)
  })

  it('rejects a malformed hunk header', () => {
    expect(() => parsePatch(diff('--- a/x.ts', '+++ b/x.ts', '@@ nonsense @@', ' a'))).toThrow(
      /malformed hunk header/
    )
  })

  it('rejects a "--- " header with no matching "+++ "', () => {
    // A `diff --git` line makes it parse as a unified diff; the missing +++ then throws.
    expect(() =>
      parsePatch(diff('diff --git a/x.ts b/x.ts', '--- a/x.ts', '@@ -1 +1 @@', '-a'))
    ).toThrow(/must be followed by a "\+\+\+ "/)
  })
})
