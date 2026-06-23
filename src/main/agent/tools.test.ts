import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTool, toolSchemas, type ToolContext } from './tools'

let workspace: string
let ctx: ToolContext

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'houston-test-')))
  ctx = { workspace, allowNetwork: false }
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

const run = (name: string, args: Record<string, unknown>): Promise<string> =>
  getTool(name)!.execute(args, ctx)

describe('tool registry', () => {
  it('exposes the expected tools', () => {
    expect(toolSchemas().map((t) => t.name).sort()).toEqual([
      'edit_file',
      'glob',
      'list_dir',
      'read_file',
      'run_shell',
      'search_files',
      'todo_write',
      'web_fetch',
      'write_file'
    ])
  })
})

describe('write/read/edit', () => {
  it('writes then reads a file back', async () => {
    await run('write_file', { path: 'a/b.txt', content: 'hello' })
    expect(await run('read_file', { path: 'a/b.txt' })).toBe('hello')
  })

  it('edits an exact string', async () => {
    await run('write_file', { path: 'x.txt', content: 'one two three' })
    await run('edit_file', { path: 'x.txt', old_string: 'two', new_string: 'TWO' })
    expect(await run('read_file', { path: 'x.txt' })).toBe('one TWO three')
  })

  it('rejects an edit when old_string is missing', async () => {
    await run('write_file', { path: 'x.txt', content: 'abc' })
    await expect(run('edit_file', { path: 'x.txt', old_string: 'zzz', new_string: 'q' })).rejects.toThrow(
      /not found/
    )
  })

  it('requires replace_all for ambiguous edits', async () => {
    await run('write_file', { path: 'x.txt', content: 'a a a' })
    await expect(run('edit_file', { path: 'x.txt', old_string: 'a', new_string: 'b' })).rejects.toThrow(
      /occurs 3 times/
    )
    await run('edit_file', { path: 'x.txt', old_string: 'a', new_string: 'b', replace_all: true })
    expect(await run('read_file', { path: 'x.txt' })).toBe('b b b')
  })
})

describe('list and search', () => {
  it('lists directory entries with trailing slash for dirs', async () => {
    await run('write_file', { path: 'dir/file.txt', content: 'x' })
    await run('write_file', { path: 'top.txt', content: 'y' })
    const out = await run('list_dir', { path: '.' })
    expect(out).toContain('dir/')
    expect(out).toContain('top.txt')
  })

  it('searches file contents by regex', async () => {
    await run('write_file', { path: 'src/app.ts', content: 'const answer = 42\n' })
    const out = await run('search_files', { pattern: 'answer = \\d+' })
    expect(out).toContain('src/app.ts:1:')
  })
})

describe('glob', () => {
  it('finds files by recursive pattern', async () => {
    await run('write_file', { path: 'src/a.ts', content: 'x' })
    await run('write_file', { path: 'src/nested/b.ts', content: 'y' })
    await run('write_file', { path: 'src/notes.md', content: 'z' })
    const out = (await run('glob', { pattern: '**/*.ts' })).split('\n')
    expect(out).toContain('src/a.ts')
    expect(out).toContain('src/nested/b.ts')
    expect(out).not.toContain('src/notes.md')
  })

  it('matches the pattern relative to a scoped path', async () => {
    await run('write_file', { path: 'src/top.json', content: '{}' })
    await run('write_file', { path: 'src/deep/inner.json', content: '{}' })
    const out = (await run('glob', { pattern: '*.json', path: 'src' })).split('\n')
    expect(out).toEqual(['src/top.json']) // *.json is shallow; inner.json needs **
  })

  it('skips build dirs and dotfiles', async () => {
    await run('write_file', { path: 'keep.txt', content: 'x' })
    await run('write_file', { path: 'node_modules/pkg/index.txt', content: 'x' })
    await run('write_file', { path: '.secret/hidden.txt', content: 'x' })
    const out = (await run('glob', { pattern: '**/*.txt' })).split('\n')
    expect(out).toEqual(['keep.txt'])
  })

  it('reports when nothing matches', async () => {
    expect(await run('glob', { pattern: '**/*.nope' })).toBe('No files found.')
  })

  it('blocks globbing outside the workspace', async () => {
    await expect(run('glob', { pattern: '*', path: '../..' })).rejects.toThrow(/escapes the workspace/)
  })
})

describe('todo_write', () => {
  it('accepts a valid list and echoes a summary + the rendered list', async () => {
    const out = await run('todo_write', {
      todos: [
        { content: 'Write tests', status: 'in_progress' },
        { content: 'Ship it', status: 'pending' }
      ]
    })
    expect(out).toContain('2 items')
    expect(out).toContain('Write tests')
    expect(out).toContain('Ship it')
  })

  it('reports a cleared list for an empty array', async () => {
    expect(await run('todo_write', { todos: [] })).toContain('Cleared')
  })

  it('rejects an invalid status', async () => {
    await expect(run('todo_write', { todos: [{ content: 'x', status: 'wip' }] })).rejects.toThrow(
      /status must be one of/
    )
  })

  it('is a read-kind tool (no project side effects, never prompts)', () => {
    expect(getTool('todo_write')!.kind).toBe('read')
  })
})

describe('workspace containment', () => {
  it('blocks reads outside the workspace', async () => {
    await expect(run('read_file', { path: '../../../etc/hosts' })).rejects.toThrow(/escapes the workspace/)
  })

  it('blocks writes outside the workspace', async () => {
    await expect(run('write_file', { path: '../escape.txt', content: 'nope' })).rejects.toThrow(
      /escapes the workspace/
    )
  })

  it('blocks absolute paths outside the workspace', async () => {
    writeFileSync(join(tmpdir(), 'outside-target.txt'), 'secret')
    await expect(run('read_file', { path: '/etc/hosts' })).rejects.toThrow(/escapes the workspace/)
  })
})
