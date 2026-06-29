import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_PREVIEW_TEXT_BYTES } from '@shared/files'
import { listDirectory, readWorkspaceFile } from './fileTree'

/**
 * `listDirectory` walks the real filesystem (it backs the user-gesture Files
 * panel, not an agent tool), so these exercise it against a scratch workspace.
 */
describe('listDirectory', () => {
  let root: string

  beforeEach(() => {
    // realpath so macOS's /var -> /private/var symlink doesn't trip containment.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'houston-files-')))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'index.ts'), 'export {}')
    writeFileSync(join(root, 'README.md'), '# hi')
    writeFileSync(join(root, '.gitignore'), 'node_modules')
    mkdirSync(join(root, 'node_modules'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('lists a directory level with folders first, then files, alphabetically', async () => {
    const entries = await listDirectory(root, '')
    // Directories come first, sorted; then files. (Dotfile-vs-letter ordering is
    // ICU-collation dependent, so assert the grouping, not its internal order.)
    expect(entries.slice(0, 2).map((e) => e.name)).toEqual(['node_modules', 'src'])
    expect(entries.slice(0, 2).every((e) => e.isDirectory)).toBe(true)
    expect(entries.slice(2).map((e) => e.name).sort()).toEqual(['.gitignore', 'README.md'])
    expect(entries.slice(2).every((e) => !e.isDirectory)).toBe(true)
    expect(entries.find((e) => e.name === 'src')).toMatchObject({ isDirectory: true, path: 'src' })
    expect(entries.find((e) => e.name === 'README.md')).toMatchObject({
      isDirectory: false,
      path: 'README.md'
    })
  })

  it('lists a subdirectory by its workspace-relative path', async () => {
    const entries = await listDirectory(root, 'src')
    expect(entries).toEqual([{ name: 'index.ts', path: 'src/index.ts', isDirectory: false }])
  })

  it('returns [] for a path that escapes the workspace', async () => {
    expect(await listDirectory(root, '..')).toEqual([])
    expect(await listDirectory(root, '../..')).toEqual([])
  })

  it('returns [] for a missing workspace or unreadable directory', async () => {
    expect(await listDirectory('', '')).toEqual([])
    expect(await listDirectory(root, 'does/not/exist')).toEqual([])
  })

  it('classifies a symlink to a directory as expandable', async () => {
    symlinkSync(join(root, 'src'), join(root, 'link-to-src'))
    const entries = await listDirectory(root, '')
    expect(entries.find((e) => e.name === 'link-to-src')).toMatchObject({ isDirectory: true })
  })
})

describe('readWorkspaceFile', () => {
  let root: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'houston-read-')))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns text content for a text file', async () => {
    writeFileSync(join(root, 'a.ts'), 'export const x = 1\n')
    const r = await readWorkspaceFile(root, 'a.ts')
    expect(r).toEqual({ kind: 'text', text: 'export const x = 1\n', truncated: false, bytes: 19 })
  })

  it('flags truncation for a file past the preview cap', async () => {
    writeFileSync(join(root, 'big.txt'), 'a'.repeat(MAX_PREVIEW_TEXT_BYTES + 1000))
    const r = await readWorkspaceFile(root, 'big.txt')
    expect(r.kind).toBe('text')
    if (r.kind === 'text') {
      expect(r.truncated).toBe(true)
      expect(r.text.length).toBe(MAX_PREVIEW_TEXT_BYTES)
      expect(r.bytes).toBe(MAX_PREVIEW_TEXT_BYTES + 1000)
    }
  })

  it('detects a binary file by a NUL byte', async () => {
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0x41, 0x00, 0x42, 0x43]))
    const r = await readWorkspaceFile(root, 'blob.bin')
    expect(r).toEqual({ kind: 'binary', bytes: 4 })
  })

  it('returns an image as a base64 attachment', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    writeFileSync(join(root, 'pic.png'), bytes)
    const r = await readWorkspaceFile(root, 'pic.png')
    expect(r).toEqual({
      kind: 'image',
      image: { mediaType: 'image/png', data: bytes.toString('base64') },
      bytes: 4
    })
  })

  it('errors for a path that escapes the workspace', async () => {
    const r = await readWorkspaceFile(root, '../secret')
    expect(r).toEqual({ kind: 'error', message: 'Path is outside the workspace.' })
  })

  it('errors for a missing file, a directory, and an empty path', async () => {
    mkdirSync(join(root, 'dir'))
    expect((await readWorkspaceFile(root, 'nope.txt')).kind).toBe('error')
    expect(await readWorkspaceFile(root, 'dir')).toMatchObject({ kind: 'error' })
    expect(await readWorkspaceFile(root, '')).toEqual({ kind: 'error', message: 'No file selected.' })
  })
})
