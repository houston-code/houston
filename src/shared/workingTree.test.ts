import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff, untrackedToFileDiff, totalStat } from './workingTree'

describe('parseUnifiedDiff', () => {
  it('returns [] for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([])
  })

  it('parses a modified file with add/del counts and the hunk header', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index 1234567..89abcde 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,4 @@',
      ' const a = 1',
      '-const b = 2',
      '+const b = 3',
      '+const c = 4',
      ' export { a }',
      ''
    ].join('\n')
    const [f] = parseUnifiedDiff(diff)
    expect(f.path).toBe('src/foo.ts')
    expect(f.status).toBe('modified')
    expect(f.added).toBe(2)
    expect(f.removed).toBe(1)
    expect(f.hunks).toHaveLength(1)
    expect(f.hunks[0].header).toBe('@@ -1,3 +1,4 @@')
    // The trailing newline must not introduce a spurious empty context line.
    expect(f.hunks[0].lines.at(-1)).toEqual({ type: 'ctx', text: 'export { a }' })
    expect(f.hunks[0].lines.filter((l) => l.type === 'ctx')).toHaveLength(2)
  })

  it('marks a new file (--- /dev/null) as added', () => {
    const diff = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      'index 0000000..3b18e51',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world'
    ].join('\n')
    const [f] = parseUnifiedDiff(diff)
    expect(f.status).toBe('added')
    expect(f.path).toBe('new.txt')
    expect(f.added).toBe(2)
    expect(f.removed).toBe(0)
  })

  it('marks a removed file (+++ /dev/null) as deleted', () => {
    const diff = [
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      'index 3b18e51..0000000',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye'
    ].join('\n')
    const [f] = parseUnifiedDiff(diff)
    expect(f.status).toBe('deleted')
    expect(f.path).toBe('gone.txt')
    expect(f.removed).toBe(1)
  })

  it('captures a rename with both paths', () => {
    const diff = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 92%',
      'rename from old.ts',
      'rename to new.ts',
      'index 1234567..89abcde 100644',
      '--- a/old.ts',
      '+++ b/new.ts',
      '@@ -1,2 +1,2 @@',
      ' line one',
      '-old line',
      '+new line'
    ].join('\n')
    const [f] = parseUnifiedDiff(diff)
    expect(f.status).toBe('renamed')
    expect(f.oldPath).toBe('old.ts')
    expect(f.path).toBe('new.ts')
    expect(f.added).toBe(1)
    expect(f.removed).toBe(1)
  })

  it('flags a binary change and recovers the path from the diff --git header', () => {
    const diff = [
      'diff --git a/img.png b/img.png',
      'index 1234567..89abcde 100644',
      'Binary files a/img.png and b/img.png differ'
    ].join('\n')
    const [f] = parseUnifiedDiff(diff)
    expect(f.binary).toBe(true)
    expect(f.note).toBe('Binary file')
    expect(f.path).toBe('img.png')
    expect(f.added).toBe(0)
  })

  it('parses multiple files in one diff', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-one',
      '+ONE',
      'diff --git a/b.txt b/b.txt',
      '--- a/b.txt',
      '+++ b/b.txt',
      '@@ -1 +1 @@',
      '-two',
      '+TWO'
    ].join('\n')
    const files = parseUnifiedDiff(diff)
    expect(files.map((f) => f.path)).toEqual(['a.txt', 'b.txt'])
    expect(files.every((f) => f.added === 1 && f.removed === 1)).toBe(true)
  })
})

describe('untrackedToFileDiff', () => {
  it('renders text content as an all-additions diff', () => {
    const f = untrackedToFileDiff('notes.md', 'line 1\nline 2\nline 3')
    expect(f.status).toBe('untracked')
    expect(f.added).toBe(3)
    expect(f.removed).toBe(0)
    expect(f.hunks).toHaveLength(1)
    expect(f.hunks[0].header).toBe('@@ -0,0 +1,3 @@')
    expect(f.hunks[0].lines.every((l) => l.type === 'add')).toBe(true)
  })

  it('shows a note for binary, oversized, unreadable, and empty files', () => {
    expect(untrackedToFileDiff('x.bin', null, { binary: true })).toMatchObject({
      binary: true,
      note: 'Binary file',
      hunks: []
    })
    expect(untrackedToFileDiff('big.log', null, { tooLargeKb: 512 }).note).toBe(
      'Large file (512 KB) — not shown'
    )
    expect(untrackedToFileDiff('x', null, { unreadable: true }).note).toBe('Could not read file')
    expect(untrackedToFileDiff('empty.txt', '').note).toBe('Empty file')
  })
})

describe('totalStat', () => {
  it('sums added/removed across files', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/a.txt b/a.txt',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,1 +1,2 @@',
        ' keep',
        '+new'
      ].join('\n')
    )
    files.push(untrackedToFileDiff('u.txt', 'x\ny'))
    expect(totalStat(files)).toEqual({ added: 3, removed: 0 })
  })
})
