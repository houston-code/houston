import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getTool, builtinToolset, type ToolContext } from '../tools'
import { LspManager } from './manager'
import { applyTextEdits, hoverText, locateSymbol, renameHunks, workspaceEditFiles, LSP_TOOL_NAMES } from './tools'
import { parsePatch } from '../apply-patch'
import { toUri } from './uri'
import { resolveEdit } from '../edit-match'
import type { LspServerConfig } from '@shared/types'

const FIXTURE = resolve(__dirname, '../../test/fake-lsp-server.mjs')
const FAKE: LspServerConfig = { id: 'fake', command: process.execPath, args: [FIXTURE], extensions: ['fk'] }

let root: string
let outside: string
let manager: LspManager

function makeManager(env: Record<string, string> = {}): LspManager {
  const m = new LspManager({
    spawn: (server) => spawn(server.path, server.args, { env: { ...process.env, ...env }, stdio: 'pipe' }),
    sandboxed: () => true,
    launchable: () => true,
    env: {}
  })
  m.configure({ lspServers: [FAKE] })
  return m
}

const ctx = (): ToolContext => ({ workspace: root, roots: [root], allowNetwork: false, lsp: manager })
const tool = (name: string) => getTool(name)!
/** Open a file in the fake server, which only knows files it has been sent. */
async function open(name: string): Promise<void> {
  const abs = join(root, name)
  await (await manager.clientFor(abs, [root]))!.sync(abs)
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'houston-lsptools-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'houston-lsptools-out-')))
  manager = makeManager()
  writeFileSync(join(root, 'a.fk'), 'function greet() {}\nconst x = greet()\n')
  writeFileSync(join(root, 'b.fk'), 'greet()\ngreet()\n')
})

afterEach(async () => {
  await manager.stopAll()
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('locateSymbol', () => {
  it('finds a whole-word match on the 1-based line, by occurrence', () => {
    const text = 'const width = id + id\nnext'
    expect(locateSymbol(text, 1, 'id')).toEqual({ line: 0, character: 14 })
    expect(locateSymbol(text, 1, 'id', 2)).toEqual({ line: 0, character: 19 })
  })

  it('counts UTF-16 units, as LSP does', () => {
    expect(locateSymbol('const 🙂 = foo', 1, 'foo')).toEqual({ line: 0, character: 11 })
  })

  it('explains a symbol that is not on the line, or a line past the end', () => {
    expect(() => locateSymbol('a\nb', 2, 'zzz')).toThrow(/does not appear on line 2, which reads: b/)
    expect(() => locateSymbol('a', 5, 'a')).toThrow(/outside the file/)
    expect(() => locateSymbol('a a', 1, 'a', 3)).toThrow(/appears 2 times/)
  })
})

describe('navigation tools against a fake server', () => {
  it('are offered only when a server is available', () => {
    const base = { localhostCapture: false, imageGallery: false, spawn: false, scheduler: false, planMode: false }
    const names = (lsp?: boolean) => builtinToolset({ ...base, lsp }).map((t) => t.schema.name)
    expect(names()).not.toContain('lsp_definition')
    expect(names(true)).toEqual(expect.arrayContaining([...LSP_TOOL_NAMES]))
  })

  it('lsp_definition answers with path:line:col and the line', async () => {
    await open('a.fk') // the fake server only knows open files
    const out = await tool('lsp_definition').execute({ path: 'b.fk', line: 2, symbol: 'greet' }, ctx())
    expect(out).toBe('a.fk:1:10  function greet() {}')
  })

  it('lsp_definition follows an import binding through to the declaration', async () => {
    await manager.stopAll()
    manager = makeManager({ FAKE_LSP_DEF_IMPORT: '1' })
    writeFileSync(join(root, 'c.fk'), "import { greet } from './a'\ngreet()\n")
    await open('a.fk')
    const out = await tool('lsp_definition').execute({ path: 'c.fk', line: 2, symbol: 'greet' }, ctx())
    expect(out).toBe('a.fk:1:10  function greet() {}')
  })

  it('lsp_references lists real uses across open files', async () => {
    await open('b.fk')
    const out = await tool('lsp_references').execute({ path: 'a.fk', line: 1, symbol: 'greet' }, ctx())
    expect(out.split('\n')[0]).toBe('4 references:')
    expect(out).toContain('b.fk:2:1  greet()')
  })

  it('lsp_hover returns the server text', async () => {
    const out = await tool('lsp_hover').execute({ path: 'a.fk', line: 2, symbol: 'greet' }, ctx())
    expect(out).toContain('function greet(): void')
  })

  it("read tools carry the server's missing-dependency note", async () => {
    const plain = await tool('lsp_hover').execute({ path: 'a.fk', line: 2, symbol: 'greet' }, ctx())
    expect(plain).not.toContain('note:')
    ;(await manager.clientFor(join(root, 'a.fk'), [root]))!.missingDepsHint = 'fetch them'
    const noted = await tool('lsp_hover').execute({ path: 'a.fk', line: 2, symbol: 'greet' }, ctx())
    expect(noted).toBe(`${plain}\n\n(note: fetch them)`)
    expect(await tool('lsp_document_symbols').execute({ path: 'a.fk' }, ctx())).toContain('(note: fetch them)')
  })

  it('lsp_document_symbols and lsp_workspace_symbols outline with line numbers', async () => {
    expect(await tool('lsp_document_symbols').execute({ path: 'a.fk' }, ctx())).toBe('function greet  (line 1)')
    expect(await tool('lsp_workspace_symbols').execute({ path: 'a.fk', query: 'gre' }, ctx())).toBe('function greet  a.fk:1')
  })

  it('drops locations outside the roots, including through a symlink, and says how many', async () => {
    writeFileSync(join(outside, 'secret.fk'), 'top secret line\n')
    mkdirSync(join(root, 'sub'))
    symlinkSync(outside, join(root, 'sub', 'link'))
    await manager.stopAll()
    manager = makeManager({ FAKE_LSP_OUTSIDE: join(root, 'sub', 'link', 'secret.fk') })
    const out = await tool('lsp_references').execute({ path: 'a.fk', line: 1, symbol: 'greet' }, ctx())
    expect(out).not.toContain('secret')
    expect(out).toContain('1 outside the project not shown')
    await manager.stopAll()
    manager = makeManager({ FAKE_LSP_OUTSIDE: join(outside, 'secret.fk') })
    const def = await tool('lsp_definition').execute({ path: 'a.fk', line: 2, symbol: 'greet' }, ctx())
    expect(def).toContain('a.fk:1:10')
    expect(def).not.toContain(outside)
  })

  it('shows a workspace file whose name starts with dots by its relative path', async () => {
    writeFileSync(join(root, '..gen.fk'), 'greet()\n')
    await open('..gen.fk')
    const out = await tool('lsp_references').execute({ path: 'a.fk', line: 1, symbol: 'greet' }, ctx())
    expect(out).toContain('\n..gen.fk:1:1  greet()')
    expect(out).not.toContain(root)
  })

  it("never quotes a credential file's lines", async () => {
    writeFileSync(join(root, 'id_rsa'), 'PRIVATE KEY MATERIAL\n')
    await manager.stopAll()
    manager = makeManager({ FAKE_LSP_OUTSIDE: join(root, 'id_rsa') })
    const out = await tool('lsp_references').execute({ path: 'a.fk', line: 1, symbol: 'greet' }, ctx())
    expect(out).toContain('id_rsa:1:1')
    expect(out).not.toContain('PRIVATE')
  })

  it('refuses a file outside the roots, and says when no server covers a file', async () => {
    writeFileSync(join(outside, 'x.fk'), 'greet\n')
    await expect(tool('lsp_hover').execute({ path: join(outside, 'x.fk'), line: 1, symbol: 'greet' }, ctx())).rejects.toThrow(
      /escapes the allowed roots/
    )
    writeFileSync(join(root, 'n.txt'), 'greet\n')
    await expect(tool('lsp_hover').execute({ path: 'n.txt', line: 1, symbol: 'greet' }, ctx())).rejects.toThrow(
      /No language server is running for n\.txt/
    )
    await expect(
      tool('lsp_hover').execute({ path: 'a.fk', line: 1, symbol: 'greet' }, { workspace: root, roots: [root], allowNetwork: false })
    ).rejects.toThrow(/not available here/)
  })

  it('lsp_rename applies the server edits as a patch when run directly', async () => {
    await open('b.fk')
    const out = await tool('lsp_rename').execute({ path: 'a.fk', line: 1, symbol: 'greet', new_name: 'hello' }, ctx())
    expect(out).toMatch(/^Renamed "greet" to "hello": 4 edits in 2 files\. Applied patch/)
    expect(readFileSync(join(root, 'a.fk'), 'utf8')).toBe('function hello() {}\nconst x = hello()\n')
    expect(readFileSync(join(root, 'b.fk'), 'utf8')).toBe('hello()\nhello()\n')
  })

  it('lsp_rename materializes into an apply_patch, and refuses edits outside the roots', async () => {
    const m = await tool('lsp_rename').materialize!({ path: 'a.fk', line: 1, symbol: 'greet', new_name: 'hello' }, ctx())
    expect(m.name).toBe('apply_patch')
    expect(parsePatch(String(m.arguments.patch)).map((op) => op.path)).toEqual(['a.fk'])
    writeFileSync(join(outside, 'c.fk'), 'greet\n')
    await manager.stopAll()
    manager = makeManager({ FAKE_LSP_OUTSIDE: join(outside, 'c.fk') })
    await expect(
      tool('lsp_rename').materialize!({ path: 'a.fk', line: 1, symbol: 'greet', new_name: 'hello' }, ctx())
    ).rejects.toThrow(/outside the project.*Nothing was changed/)
    expect(readFileSync(join(outside, 'c.fk'), 'utf8')).toBe('greet\n')
  })
})

describe('rename edits', () => {
  const edit = (line: number, character: number, len: number, newText: string) => ({
    range: { start: { line, character }, end: { line, character: character + len } },
    newText
  })

  it('applies edits bottom-up and rejects overlaps', () => {
    expect(applyTextEdits('ab cd\nab', [edit(0, 0, 2, 'X'), edit(1, 0, 2, 'YY'), edit(0, 3, 2, 'Z')])).toBe('X Z\nYY')
    expect(() => applyTextEdits('abcdef', [edit(0, 0, 4, 'x'), edit(0, 2, 2, 'y')])).toThrow(/overlapping/)
  })

  it('builds hunks that replay to the intended file even among repeated lines', () => {
    const before = ['x = foo', 'pad', 'pad', 'pad', 'pad', 'pad', 'pad', 'pad', 'pad', 'x = foo', 'pad', 'pad', 'pad'].join('\n')
    const edits = [edit(0, 4, 3, 'bar'), edit(9, 4, 3, 'bar')]
    const after = applyTextEdits(before, edits)
    const hunks = renameHunks(before, after, edits)
    // Apply them the way apply_patch does: in order, each located by its text.
    const ops = parsePatch(`*** Begin Patch\n*** Update File: f\n${hunks.join('\n')}\n*** End Patch`)
    let cur = before
    for (const op of ops) {
      if (op.type !== 'update') throw new Error('expected an update')
      for (const h of op.hunks) cur = resolveEdit(cur, h.oldText, h.newText, false).content
    }
    expect(cur).toBe(after)
  })

  it('handles a file of identical lines by widening to a unique hunk', () => {
    const before = 'foo\nfoo\nfoo\nfoo'
    const edits = [edit(2, 0, 3, 'bar')]
    const after = applyTextEdits(before, edits)
    const hunks = renameHunks(before, after, edits)
    const ops = parsePatch(`*** Begin Patch\n*** Update File: f\n${hunks.join('\n')}\n*** End Patch`)
    let cur = before
    for (const op of ops) if (op.type === 'update') for (const h of op.hunks) cur = resolveEdit(cur, h.oldText, h.newText, false).content
    expect(cur).toBe('foo\nfoo\nbar\nfoo')
  })

  it('reads documentChanges and refuses file operations', () => {
    // Built from a platform path: a drive-less file:///w/... URI names no local file on Windows.
    const abs = join(root, 'a.ts')
    const uri = toUri(abs)
    expect(workspaceEditFiles({ documentChanges: [{ textDocument: { uri, version: 1 }, edits: [edit(0, 0, 1, 'x')] }] }).get(abs)).toHaveLength(1)
    expect(() => workspaceEditFiles({ documentChanges: [{ kind: 'rename', oldUri: uri, newUri: toUri(join(root, 'b.ts')) }] })).toThrow(/rename a file/)
    expect(() => workspaceEditFiles({ changes: { 'untitled:1': [edit(0, 0, 1, 'x')] } })).toThrow(/can't edit/)
  })

  it('keeps CRLF line endings through the patch', async () => {
    const m = makeManager()
    try {
      writeFileSync(join(root, 'crlf.fk'), 'function greet() {}\r\ngreet()\r\n')
      const out = await tool('lsp_rename').execute({ path: 'crlf.fk', line: 1, symbol: 'greet', new_name: 'hi' }, { ...ctx(), lsp: m })
      expect(out).toMatch(/Applied patch/)
      expect(readFileSync(join(root, 'crlf.fk'), 'utf8')).toBe('function hi() {}\r\nhi()\r\n')
    } finally {
      await m.stopAll()
    }
  })
})

describe('hoverText', () => {
  it('flattens MarkupContent, MarkedString, and lists of them', () => {
    expect(hoverText({ contents: { kind: 'plaintext', value: 'a' } })).toBe('a')
    expect(hoverText({ contents: [{ language: 'ts', value: 'x: number' }, 'doc'] })).toBe('```ts\nx: number\n```\n\ndoc')
    expect(hoverText(null)).toBe('')
  })
})
