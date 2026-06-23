import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { getTool, toolSchemas, type ToolContext } from './tools'
import { registerShell } from './shells'

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
      'dispatch_agent',
      'edit_file',
      'glob',
      'kill_shell',
      'list_dir',
      'read_file',
      'read_shell_output',
      'run_shell',
      'search_files',
      'todo_write',
      'web_fetch',
      'web_search',
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

  it('supports ignore_case and files_with_matches', async () => {
    await run('write_file', { path: 'a.ts', content: 'Hello World\n' })
    expect(await run('search_files', { pattern: 'hello' })).toBe('No matches found.')
    expect(await run('search_files', { pattern: 'hello', ignore_case: true })).toContain('a.ts:1:')
    expect(await run('search_files', { pattern: 'hello', ignore_case: true, files_with_matches: true })).toBe(
      'a.ts'
    )
  })
})

describe('read_file ranges', () => {
  beforeEach(async () => {
    await run('write_file', { path: 'big.txt', content: 'l1\nl2\nl3\nl4\nl5' })
  })

  it('reads a line slice with offset and limit', async () => {
    const out = await run('read_file', { path: 'big.txt', offset: 2, limit: 2 })
    expect(out).toContain('[lines 2-3 of 5]')
    expect(out).toContain('l2\nl3')
    expect(out).not.toContain('l4')
  })

  it('reads from an offset to the end when limit is omitted', async () => {
    const out = await run('read_file', { path: 'big.txt', offset: 4 })
    expect(out).toContain('[lines 4-5 of 5]')
    expect(out.trimEnd().endsWith('l4\nl5')).toBe(true)
  })

  it('reads the whole file when no range is given', async () => {
    expect(await run('read_file', { path: 'big.txt' })).toBe('l1\nl2\nl3\nl4\nl5')
  })

  it('reports an empty range when the offset is past end-of-file', async () => {
    const out = await run('read_file', { path: 'big.txt', offset: 99 })
    expect(out).toContain('[no lines in range')
    expect(out).not.toMatch(/\[lines \d+-\d+ of/) // no reversed range header
  })

  it('reports an empty range for limit 0', async () => {
    expect(await run('read_file', { path: 'big.txt', offset: 2, limit: 0 })).toContain(
      '[no lines in range'
    )
  })
})

describe('read_file images and PDFs', () => {
  // 1x1 transparent PNG.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  )

  it('attaches an image and returns a marker', async () => {
    writeFileSync(join(workspace, 'logo.png'), PNG)
    const images: { mediaType: string; data: string }[] = []
    const out = await getTool('read_file')!.execute(
      { path: 'logo.png' },
      { ...ctx, attachImage: (img) => images.push(img) }
    )
    expect(out).toContain('[image: logo.png')
    expect(images).toHaveLength(1)
    expect(images[0].mediaType).toBe('image/png')
    expect(images[0].data).toBe(PNG.toString('base64'))
  })

  it('attaches a PDF as a document', async () => {
    writeFileSync(join(workspace, 'doc.pdf'), Buffer.from('%PDF-1.4 minimal'))
    const docs: { mediaType: string; data: string }[] = []
    const out = await getTool('read_file')!.execute(
      { path: 'doc.pdf' },
      { ...ctx, attachDocument: (d) => docs.push(d) }
    )
    expect(out).toContain('[pdf: doc.pdf')
    expect(docs).toHaveLength(1)
    expect(docs[0].mediaType).toBe('application/pdf')
  })

  it('notes that an image cannot be shown when attachment is unavailable', async () => {
    writeFileSync(join(workspace, 'logo.png'), PNG)
    // ctx has no attachImage (e.g. a subagent context).
    const out = await run('read_file', { path: 'logo.png' })
    expect(out).toContain('cannot be displayed')
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

describe('web_search', () => {
  it('errors with guidance when no key is configured', async () => {
    await expect(run('web_search', { query: 'anything' })).rejects.toThrow(/No web-search API key/)
  })

  it('requires a query', async () => {
    const withKey: ToolContext = { ...ctx, getSecret: () => 'tvly-x' }
    await expect(getTool('web_search')!.execute({}, withKey)).rejects.toThrow(/query is required/)
  })
})

describe('background shell tools', () => {
  it('run_shell background returns a shell id message', async () => {
    const out = await run('run_shell', { command: 'echo hi', background: true })
    expect(out).toMatch(/Started background shell \w+/)
  })

  it('read_shell_output reports an unknown id', async () => {
    expect(await run('read_shell_output', { shell_id: 'nope' })).toBe('No background shell with id nope.')
  })

  it('kill_shell reports an unknown id', async () => {
    expect(await run('kill_shell', { shell_id: 'nope' })).toBe('No background shell with id nope.')
  })

  // Inject a real (non-sandboxed) child so the tool's output formatting is
  // exercised on every platform, not just where sandbox-exec exists.
  it('read_shell_output formats output and exit code of a finished shell', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("done"); process.exit(0)'])
    const id = registerShell('node', child)
    await new Promise<void>((resolve) => child.on('close', () => resolve()))
    const out = await run('read_shell_output', { shell_id: id })
    expect(out).toContain('done')
    expect(out).toContain('[exited with code 0]')
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
