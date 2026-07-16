import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, realpathSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diffStat } from '@shared/diff'
import { MAX_PREVIEW_DIFF_LINES, previewWrite } from './writePreview'

let workspace: string
const roots = (): string[] => [workspace]
const write = (rel: string, content: string): void => writeFileSync(join(workspace, rel), content)

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'houston-preview-')))
})
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('previewWrite: write_file', () => {
  it('diffs an overwrite against what the file actually holds', async () => {
    // The bug this closes: without the file's current contents, an overwrite that
    // changes one line renders as if every line were new.
    write('a.ts', 'const a = 1\nconst b = 2\nconst c = 3\n')
    const p = await previewWrite('write_file', { path: 'a.ts', content: 'const a = 1\nconst b = 99\nconst c = 3\n' }, roots())
    expect(p).toHaveLength(1)
    expect(p?.[0].path).toBe('a.ts')
    expect(p?.[0].created).toBeUndefined()
    // One line changed, not four.
    expect(diffStat(p![0].diff)).toEqual({ added: 1, removed: 1 })
  })

  it('marks a genuinely new file as created, with every line an addition', async () => {
    const p = await previewWrite('write_file', { path: 'new.ts', content: 'a\nb\n' }, roots())
    expect(p?.[0].created).toBe(true)
    // 3, not 2: a trailing newline yields a final empty line, which is how diffLines
    // has always split text and how the existing edit/write diffs already render.
    expect(diffStat(p![0].diff)).toEqual({ added: 3, removed: 0 })
  })

  it('returns null without content to write', async () => {
    expect(await previewWrite('write_file', { path: 'a.ts' }, roots())).toBeNull()
  })
})

describe('previewWrite: edit_file', () => {
  it('previews the resolved edit against the file', async () => {
    write('a.ts', 'one two three\n')
    const p = await previewWrite('edit_file', { path: 'a.ts', old_string: 'two', new_string: 'TWO' }, roots())
    expect(diffStat(p![0].diff)).toEqual({ added: 1, removed: 1 })
    expect(p![0].diff.find((l) => l.type === 'add')?.text).toBe('one TWO three')
  })

  it('returns null when the edit will not apply, rather than inventing a diff', async () => {
    write('a.ts', 'one two three\n')
    expect(await previewWrite('edit_file', { path: 'a.ts', old_string: 'nowhere', new_string: 'x' }, roots())).toBeNull()
  })

  it('returns null for a file that does not exist', async () => {
    expect(await previewWrite('edit_file', { path: 'nope.ts', old_string: 'a', new_string: 'b' }, roots())).toBeNull()
  })
})

describe('previewWrite: multi_edit', () => {
  it('applies edits in order so the preview is the real combined result', async () => {
    // Each edit sees the previous one's output — a per-edit preview would be wrong.
    write('m.ts', 'a\n')
    const p = await previewWrite(
      'multi_edit',
      {
        path: 'm.ts',
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'b', new_string: 'c' }
        ]
      },
      roots()
    )
    expect(p).toHaveLength(1)
    expect(p![0].diff.find((l) => l.type === 'add')?.text).toBe('c')
  })

  it('previews several edits to one file as a single diff', async () => {
    write('m.ts', 'one\ntwo\nthree\n')
    const p = await previewWrite(
      'multi_edit',
      {
        path: 'm.ts',
        edits: [
          { old_string: 'one', new_string: '1' },
          { old_string: 'three', new_string: '3' }
        ]
      },
      roots()
    )
    expect(diffStat(p![0].diff)).toEqual({ added: 2, removed: 2 })
  })

  it('returns null when any edit in the sequence will not apply', async () => {
    write('m.ts', 'a\n')
    const p = await previewWrite(
      'multi_edit',
      { path: 'm.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'zzz', new_string: 'y' }] },
      roots()
    )
    expect(p).toBeNull()
  })

  it('returns null on a malformed edits list', async () => {
    write('m.ts', 'a\n')
    expect(await previewWrite('multi_edit', { path: 'm.ts', edits: [] }, roots())).toBeNull()
    expect(await previewWrite('multi_edit', { path: 'm.ts', edits: ['nope'] }, roots())).toBeNull()
  })
})

describe('previewWrite: apply_patch', () => {
  it('previews every file in the envelope, tagging adds and deletes', async () => {
    write('keep.ts', 'const a = 1\nconst b = 2\n')
    write('gone.ts', 'delete me\n')
    const patch = [
      '*** Begin Patch',
      '*** Add File: new.ts',
      '+export const x = 1',
      '*** Update File: keep.ts',
      ' const a = 1',
      '-const b = 2',
      '+const b = 3',
      '*** Delete File: gone.ts',
      '*** End Patch'
    ].join('\n')

    const p = await previewWrite('apply_patch', { patch }, roots())
    expect(p?.map((f) => f.path)).toEqual(['new.ts', 'keep.ts', 'gone.ts'])

    expect(p![0].created).toBe(true)
    expect(diffStat(p![0].diff)).toEqual({ added: 1, removed: 0 })

    expect(p![1].created).toBeUndefined()
    expect(diffStat(p![1].diff)).toEqual({ added: 1, removed: 1 })

    expect(p![2].deleted).toBe(true)
    expect(diffStat(p![2].diff)).toEqual({ added: 0, removed: 2 })
  })

  it('previews a move as the destination carrying the edit, noting its origin', async () => {
    write('old.ts', 'const a = 1\n')
    const patch = [
      '*** Begin Patch',
      '*** Update File: old.ts',
      '*** Move to: new.ts',
      '-const a = 1',
      '+const a = 2',
      '*** End Patch'
    ].join('\n')
    const p = await previewWrite('apply_patch', { patch }, roots())
    expect(p).toHaveLength(1)
    expect(p![0].path).toBe('new.ts')
    expect(p![0].renamedFrom).toBe('old.ts')
    expect(diffStat(p![0].diff)).toEqual({ added: 1, removed: 1 })
  })

  it('returns null for a malformed patch instead of throwing', async () => {
    expect(await previewWrite('apply_patch', { patch: 'not a patch' }, roots())).toBeNull()
    expect(await previewWrite('apply_patch', {}, roots())).toBeNull()
  })

  it('returns null when an update targets a missing file', async () => {
    const patch = ['*** Begin Patch', '*** Update File: nope.ts', '-a', '+b', '*** End Patch'].join('\n')
    expect(await previewWrite('apply_patch', { patch }, roots())).toBeNull()
  })
})

describe('previewWrite: notebook_edit', () => {
  const NB = JSON.stringify(
    {
      cells: [
        { cell_type: 'markdown', metadata: {}, source: ['# Title'] },
        {
          cell_type: 'code',
          metadata: {},
          source: ['x = 1'],
          outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }],
          execution_count: 4
        }
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5
    },
    null,
    2
  )

  it('diffs the cell view rather than the notebook JSON', async () => {
    write('a.ipynb', NB)
    const p = await previewWrite('notebook_edit', { path: 'a.ipynb', cell: 2, source: 'x = 42' }, roots())
    expect(p).toHaveLength(1)
    const added = p![0].diff.filter((l) => l.type === 'add').map((l) => l.text)
    const removed = p![0].diff.filter((l) => l.type === 'del').map((l) => l.text)
    expect(added).toContain('x = 42')
    expect(removed).toContain('x = 1')
    // The JSON scaffolding a raw diff would be full of never appears.
    expect(p![0].diff.some((l) => l.text.includes('"cell_type"'))).toBe(false)
  })

  it('shows the stale output being dropped when a code cell is rewritten', async () => {
    write('a.ipynb', NB)
    const p = await previewWrite('notebook_edit', { path: 'a.ipynb', cell: 2, source: 'x = 42' }, roots())
    expect(p![0].diff.filter((l) => l.type === 'del').map((l) => l.text)).toContain('  | stdout: 1')
  })

  it('previews an insert and a delete', async () => {
    write('a.ipynb', NB)
    const ins = await previewWrite(
      'notebook_edit',
      { path: 'a.ipynb', cell: 3, mode: 'insert', source: 'z = 3', cell_type: 'code' },
      roots()
    )
    expect(ins![0].diff.filter((l) => l.type === 'add').map((l) => l.text)).toContain('z = 3')

    const del = await previewWrite('notebook_edit', { path: 'a.ipynb', cell: 1, mode: 'delete' }, roots())
    expect(del![0].diff.filter((l) => l.type === 'del').map((l) => l.text)).toContain('# Title')
  })

  it('returns null for an edit the tool would reject anyway', async () => {
    write('a.ipynb', NB)
    expect(await previewWrite('notebook_edit', { path: 'a.ipynb', cell: 99, source: 'x' }, roots())).toBeNull()
    write('bad.ipynb', '{not json')
    expect(await previewWrite('notebook_edit', { path: 'bad.ipynb', cell: 1, source: 'x' }, roots())).toBeNull()
  })
})

describe('previewWrite: bounds and safety', () => {
  it('caps a huge diff and flags it as truncated', async () => {
    const big = Array.from({ length: MAX_PREVIEW_DIFF_LINES * 3 }, (_, i) => `line ${i}`).join('\n')
    const p = await previewWrite('write_file', { path: 'big.ts', content: big }, roots())
    expect(p![0].diff.length).toBe(MAX_PREVIEW_DIFF_LINES)
    expect(p![0].truncated).toBe(true)
  })

  it('does not flag a diff that fits', async () => {
    const p = await previewWrite('write_file', { path: 'small.ts', content: 'a\nb\n' }, roots())
    expect(p![0].truncated).toBeUndefined()
  })

  it('returns null for a path that escapes the workspace, never previewing outside it', async () => {
    expect(await previewWrite('write_file', { path: '../outside.ts', content: 'x' }, roots())).toBeNull()
  })

  it('returns null for tools it does not model', async () => {
    expect(await previewWrite('run_shell', { command: 'ls' }, roots())).toBeNull()
    expect(await previewWrite('read_file', { path: 'a.ts' }, roots())).toBeNull()
  })

  it('never writes anything — a preview is a read', async () => {
    write('a.ts', 'original\n')
    await previewWrite('write_file', { path: 'a.ts', content: 'replaced\n' }, roots())
    await previewWrite('edit_file', { path: 'a.ts', old_string: 'original', new_string: 'x' }, roots())
    expect(readFileSync(join(workspace, 'a.ts'), 'utf8')).toBe('original\n')
  })
})

// End-to-end guard for the bug: the preview must contain the change, whatever the
// file's size. Previously the line budget was spent on untouched context and the
// approval card showed a diff with nothing in it.
describe('previewWrite — a change late in a long file', () => {
  it('shows the edit, not 400 lines of context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'houston-preview-late-'))
    const file = join(dir, 'long.ts')
    const before = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n')
    writeFileSync(file, before)

    const preview = await previewWrite(
      'edit_file',
      { path: file, old_string: 'line 500', new_string: 'line 500 CHANGED' },
      [dir]
    )
    expect(preview).not.toBeNull()
    const diff = preview![0].diff
    const changes = diff.filter((l) => l.type === 'add' || l.type === 'del')
    expect(changes.some((l) => l.text.includes('CHANGED'))).toBe(true)
    expect(preview![0].truncated).toBeFalsy() // it fits now: the file was folded away
    expect(diff.some((l) => l.type === 'skip')).toBe(true)
  })
})
