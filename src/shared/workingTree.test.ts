import { describe, expect, it } from 'vitest'
import {
  dequote,
  parseUnifiedDiff,
  untrackedToFileDiff,
  totalStat,
  workingTreeToText,
  type WorkingTreeChanges
} from './workingTree'
import { fileDiffSignature } from './changes'

describe('parseUnifiedDiff', () => {
  it('counts removed and added lines whose text looks like a file header', () => {
    // A removed "-- comment" is "--- comment" in the diff; an added "++ x" is "+++ x".
    const diff = [
      'diff --git a/q.sql b/q.sql',
      'index 1111111..2222222 100644',
      '--- a/q.sql',
      '+++ b/q.sql',
      '@@ -1,3 +1,3 @@',
      ' select 1;',
      '--- old comment',
      '+-- new comment',
      '+++ incremented',
      '-++ gone',
      ' select 2;',
      'diff --git a/next.txt b/next.txt',
      '--- a/next.txt',
      '+++ b/next.txt',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      ''
    ].join('\n')
    const [sql, next] = parseUnifiedDiff(diff)
    expect(sql).toMatchObject({ path: 'q.sql', oldPath: 'q.sql', status: 'modified', added: 2, removed: 2 })
    expect(sql.hunks[0].lines.map((l) => `${l.type}:${l.text}`)).toEqual([
      'ctx:select 1;',
      'del:-- old comment',
      'add:-- new comment',
      'add:++ incremented',
      'del:++ gone',
      'ctx:select 2;'
    ])
    // The next file's real headers are still read as headers.
    expect(next).toMatchObject({ path: 'next.txt', status: 'modified', added: 1, removed: 1 })
  })

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

  it('notes why a rename, a mode change, or an empty file has no lines to show', () => {
    const diff = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to new.ts',
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
      'diff --git a/empty.txt b/empty.txt',
      'new file mode 100644',
      'index 0000000..e69de29',
      'diff --git a/edited.ts b/edited.ts',
      'old mode 100644',
      'new mode 100755',
      '--- a/edited.ts',
      '+++ b/edited.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b'
    ].join('\n')
    const [renamed, mode, empty, edited] = parseUnifiedDiff(diff)
    expect(renamed).toMatchObject({ status: 'renamed', oldPath: 'old.ts', path: 'new.ts', note: 'Renamed, no content changes' })
    expect(mode).toMatchObject({ status: 'modified', path: 'run.sh', note: 'Only the file mode changed' })
    expect(empty).toMatchObject({ status: 'added', path: 'empty.txt', note: 'Empty file' })
    // A mode change alongside an edit still shows the edit.
    expect(edited.note).toBeUndefined()
    expect(edited.hunks).toHaveLength(1)
    expect(Object.keys(mode)).not.toContain('_modeChanged')
  })

  it('decodes the octal escapes git writes for a non-ASCII name', () => {
    const diff = [
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
      'index 1234567..89abcde 100644',
      '--- "a/caf\\303\\251.txt"',
      '+++ "b/caf\\303\\251.txt"',
      '@@ -1 +1 @@',
      '-old',
      '+new'
    ].join('\n')
    const [f] = parseUnifiedDiff(diff)
    expect(f.path).toBe('café.txt')
    const [bin] = parseUnifiedDiff(
      ['diff --git "a/\\346\\227\\245\\346\\234\\254.png" "b/\\346\\227\\245\\346\\234\\254.png"', 'Binary files differ'].join('\n')
    )
    expect(bin.path).toBe('日本.png')
  })

  it('undoes every escape in a quoted path', () => {
    expect(dequote('"tab\\there"')).toBe('tab\there')
    expect(dequote('"a\\"q\\\\b"')).toBe('a"q\\b')
    expect(dequote('"na\\303\\257ve\\nx"')).toBe('naïve\nx')
    expect(dequote('plain.txt')).toBe('plain.txt')
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

describe('parseUnifiedDiff final-newline markers', () => {
  const parse = (...hunk: string[]) =>
    parseUnifiedDiff(['diff --git a/f b/f', '--- a/f', '+++ b/f', '@@ -1,2 +1,2 @@', ...hunk].join('\n'))[0]

  it('records which side of a hunk lacks a final newline, adding no line for the marker', () => {
    const added = parse(' a', '-b', '\\ No newline at end of file', '+b')
    expect(added.hunks[0]).toMatchObject({ oldNoEol: true })
    expect(added.hunks[0].newNoEol).toBeUndefined()
    expect(added.hunks[0].lines).toHaveLength(3)
    expect(added).toMatchObject({ added: 1, removed: 1 })

    const removed = parse(' a', '-b', '+b', '\\ No newline at end of file')
    expect(removed.hunks[0]).toMatchObject({ newNoEol: true })
    expect(removed.hunks[0].oldNoEol).toBeUndefined()
  })

  it('changes the file signature when only the final newline differs', () => {
    const added = parse(' a', '-b', '\\ No newline at end of file', '+b')
    const removed = parse(' a', '-b', '+b', '\\ No newline at end of file')
    expect(fileDiffSignature(added)).not.toBe(fileDiffSignature(removed))
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

  it('counts lines the way git does when the file ends in a newline', () => {
    // Most files end in "\n"; it terminates the last line rather than adding a blank one.
    const f = untrackedToFileDiff('notes.md', 'line 1\nline 2\n')
    expect(f.added).toBe(2)
    expect(f.hunks[0].header).toBe('@@ -0,0 +1,2 @@')
    expect(f.hunks[0].lines.map((l) => l.text)).toEqual(['line 1', 'line 2'])
  })

  it('shows a note for binary, oversized, unreadable, and empty files', () => {
    expect(untrackedToFileDiff('x.bin', null, { binary: true })).toMatchObject({
      binary: true,
      note: 'Binary file',
      hunks: []
    })
    expect(untrackedToFileDiff('big.log', null, { tooLargeKb: 512 }).note).toBe(
      'Large file (512 KB), not shown'
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

describe('workingTreeToText', () => {
  const change = (over: Partial<WorkingTreeChanges> = {}): WorkingTreeChanges => ({
    isRepo: true,
    branch: 'main',
    files: [],
    added: 0,
    removed: 0,
    ...over
  })

  it('renders per-file headers, status, and hunk lines with +/-/space prefixes', () => {
    const changes = change({
      files: parseUnifiedDiff(
        [
          'diff --git a/src/foo.ts b/src/foo.ts',
          '--- a/src/foo.ts',
          '+++ b/src/foo.ts',
          '@@ -1,2 +1,2 @@',
          ' keep',
          '-old',
          '+new',
          ''
        ].join('\n')
      )
    })
    const text = workingTreeToText(changes)
    expect(text).toContain('diff --git a/src/foo.ts b/src/foo.ts')
    expect(text).toContain('modified: src/foo.ts')
    expect(text).toContain('@@ -1,2 +1,2 @@')
    expect(text).toContain(' keep')
    expect(text).toContain('-old')
    expect(text).toContain('+new')
  })

  it('marks untracked files and shows a note instead of hunks when present', () => {
    const changes = change({
      files: [untrackedToFileDiff('a.bin', null, { binary: true })]
    })
    const text = workingTreeToText(changes)
    expect(text).toContain('new file: a.bin')
    expect(text).toContain('(Binary file)')
  })

  it('uses the old path in the diff header for a rename', () => {
    const changes = change({
      files: [{ path: 'new.ts', oldPath: 'old.ts', status: 'renamed', hunks: [], added: 0, removed: 0, binary: false }]
    })
    expect(workingTreeToText(changes)).toContain('diff --git a/old.ts b/new.ts')
  })
})
