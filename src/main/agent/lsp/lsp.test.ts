import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConnectionClosedError,
  encodeMessage,
  JsonRpcConnection,
  MessageDecoder,
  RequestTimeoutError,
  ResponseError
} from './jsonrpc'
import { LspClient, type LspSpawn } from './client'
import { LspManager } from './manager'
import { newDiagnostics, lspEditDiagnostics, formatEditDiagnostics } from './diagnostics'
import { afterWrite, captureBeforeWrite } from './writeSeam'
import { resolveServer, serverRegistry, specForFile, rootUsesLanguage, BUILTIN_SERVERS } from './servers'
import type { LspServerConfig } from '@shared/types'

const FIXTURE = resolve(__dirname, '../../test/fake-lsp-server.mjs')

/** Spawn the fake server directly with node (no sandbox in unit tests), with extra env. */
function fakeSpawn(extra: Record<string, string> = {}): LspSpawn {
  return (server) =>
    spawn(server.path, server.args, { env: { ...process.env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] })
}

const FAKE_SERVER: LspServerConfig = {
  id: 'fake',
  command: process.execPath,
  args: [FIXTURE],
  extensions: ['fk'],
  rootMarkers: ['fake.json']
}

let root: string
const managers: LspManager[] = []

function makeManager(extra: Record<string, string> = {}, deps: Partial<ConstructorParameters<typeof LspManager>[0]> = {}): LspManager {
  const m = new LspManager({ spawn: fakeSpawn(extra), sandboxed: () => true, launchable: () => true, env: {}, ...deps })
  m.configure({ lspServers: [FAKE_SERVER] })
  managers.push(m)
  return m
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'houston-lsp-')))
})

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stopAll()))
  rmSync(root, { recursive: true, force: true })
})

describe('Content-Length framing', () => {
  it('decodes messages split at any byte, including inside a multi-byte character', () => {
    const msgs = [
      { jsonrpc: '2.0' as const, id: 1, result: 'héllo ✓ 世界' },
      { jsonrpc: '2.0' as const, method: 'note', params: { a: 1 } }
    ]
    const bytes = Buffer.concat(msgs.map(encodeMessage))
    for (const step of [1, 2, 3, 7, bytes.length]) {
      const dec = new MessageDecoder()
      const out = []
      for (let i = 0; i < bytes.length; i += step) out.push(...dec.push(bytes.subarray(i, i + step)))
      expect(out).toEqual(msgs)
    }
  })

  it('accepts a Content-Type header and header names in any case', () => {
    const body = Buffer.from('{"jsonrpc":"2.0","id":3,"result":null}')
    const frame = Buffer.concat([
      Buffer.from(`content-type: application/vscode-jsonrpc; charset=utf-8\r\nCONTENT-LENGTH: ${body.length}\r\n\r\n`),
      body
    ])
    expect(new MessageDecoder().push(frame)).toEqual([{ jsonrpc: '2.0', id: 3, result: null }])
  })

  it('rejects a frame without a Content-Length and an oversized one', () => {
    expect(() => new MessageDecoder().push(Buffer.from('X-Foo: 1\r\n\r\n{}'))).toThrow(/Content-Length/)
    expect(() => new MessageDecoder().push(Buffer.from('Content-Length: 999999999999\r\n\r\n'))).toThrow(/too large/)
  })
})

describe('JsonRpcConnection', () => {
  function pair(): { conn: JsonRpcConnection; toClient: PassThrough; fromClient: PassThrough; sent: () => unknown[] } {
    const toClient = new PassThrough()
    const fromClient = new PassThrough()
    const dec = new MessageDecoder()
    const received: unknown[] = []
    fromClient.on('data', (c: Buffer) => received.push(...dec.push(c)))
    return { conn: new JsonRpcConnection(toClient, fromClient), toClient, fromClient, sent: () => received }
  }

  it('matches responses to requests by id and surfaces error answers', async () => {
    const { conn, toClient } = pair()
    const a = conn.request('a', {})
    const b = conn.request('b', {})
    toClient.write(encodeMessage({ jsonrpc: '2.0', id: 2, error: { code: -1, message: 'nope' } }))
    toClient.write(encodeMessage({ jsonrpc: '2.0', id: 1, result: 42 }))
    await expect(a).resolves.toBe(42)
    await expect(b).rejects.toBeInstanceOf(ResponseError)
  })

  it('times out a request and cancels it on the server', async () => {
    const { conn, sent } = pair()
    await expect(conn.request('slow', {}, 20)).rejects.toBeInstanceOf(RequestTimeoutError)
    await new Promise((r) => setTimeout(r, 5))
    expect(sent()).toContainEqual({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 1 } })
  })

  it('answers a server request it has no handler for, so the server never waits', async () => {
    const { toClient, sent } = pair()
    toClient.write(encodeMessage({ jsonrpc: '2.0', id: 'x', method: 'window/unknown', params: {} }))
    await new Promise((r) => setTimeout(r, 5))
    expect(sent()).toContainEqual(expect.objectContaining({ id: 'x', error: expect.objectContaining({ code: -32601 }) }))
  })

  it('skips a frame whose body is not a JSON object instead of throwing', async () => {
    const { conn, toClient } = pair()
    const p = conn.request('a', {})
    for (const body of ['null', '42', '"text"', '[]']) {
      toClient.write(Buffer.from(`Content-Length: ${body.length}\r\n\r\n${body}`, 'utf8'))
    }
    toClient.write(encodeMessage({ jsonrpc: '2.0', id: 1, result: 'ok' }))
    await expect(p).resolves.toBe('ok')
    expect(conn.isClosed).toBe(false)
  })

  it('fails open requests when the stream ends or desynchronizes', async () => {
    const { conn, toClient } = pair()
    const p = conn.request('a', {})
    toClient.write(Buffer.from('garbage\r\n\r\n'))
    await expect(p).rejects.toBeInstanceOf(ConnectionClosedError)
    expect(conn.isClosed).toBe(true)
  })
})

describe('server registry', () => {
  it('lets a user entry replace a built-in by id and claim extensions first', () => {
    const reg = serverRegistry([{ id: 'typescript', command: 'my-ts', extensions: ['ts'] }])
    expect(reg.filter((s) => s.id === 'typescript')).toHaveLength(1)
    expect(specForFile(reg, '/x/a.ts')?.user).toBe(true)
    expect(specForFile(reg, '/x/a.tsx')).toBeNull() // the built-in that covered .tsx was replaced
  })

  it('drops malformed user entries', () => {
    const reg = serverRegistry([{ id: '', command: 'x', extensions: ['a'] }, { id: 'y', command: '', extensions: ['b'] }] as LspServerConfig[])
    expect(reg).toHaveLength(BUILTIN_SERVERS.length)
  })

  it("prefers the workspace's node_modules/.bin over PATH for Node-based servers", () => {
    const ts = BUILTIN_SERVERS.find((s) => s.id === 'typescript')!
    const local = join(root, 'node_modules', '.bin', 'typescript-language-server')
    const exists = (p: string): boolean => p === local || p === '/usr/bin/typescript-language-server'
    const r = resolveServer(ts, { roots: [root], exists, env: { PATH: '/usr/bin' }, platform: 'darwin' })
    expect(r).toMatchObject({ path: local, source: 'workspace' })
    const r2 = resolveServer(ts, { roots: [], exists, env: { PATH: '/usr/bin' }, platform: 'darwin' })
    expect(r2).toMatchObject({ path: '/usr/bin/typescript-language-server', source: 'path' })
  })

  it("on Windows, picks npm's sh shim over the .cmd that Git Bash can't run", () => {
    const ts = BUILTIN_SERVERS.find((s) => s.id === 'typescript')!
    const bin = join(root, 'node_modules', '.bin', 'typescript-language-server')
    const exists = (p: string): boolean => p === bin || p === `${bin}.cmd`
    expect(resolveServer(ts, { roots: [root], exists, env: { PATH: '' }, platform: 'win32' })?.path).toBe(bin)
    const cmdOnly = (p: string): boolean => p === `${bin}.cmd`
    expect(resolveServer(ts, { roots: [root], exists: cmdOnly, env: { PATH: '' }, platform: 'win32' })).toBeNull()
  })

  it('detects a project by root marker or, for some languages, a top-level file', () => {
    const py = BUILTIN_SERVERS.find((s) => s.id === 'python')!
    const go = BUILTIN_SERVERS.find((s) => s.id === 'go')!
    expect(rootUsesLanguage(py, root)).toBe(false)
    writeFileSync(join(root, 'main.py'), '')
    expect(rootUsesLanguage(py, root)).toBe(true)
    writeFileSync(join(root, 'main.go'), '')
    expect(rootUsesLanguage(go, root)).toBe(false) // Go needs go.mod
  })
})

describe('LspClient against a fake server', () => {
  const clients: LspClient[] = []
  afterEach(() => clients.splice(0).forEach((c) => c.kill()))
  function client(extra: Record<string, string> = {}, maxOpenDocuments?: number): LspClient {
    const spec = serverRegistry([FAKE_SERVER])[0]
    const c = new LspClient({ server: resolveServer(spec)!, roots: [root], spawn: fakeSpawn(extra), maxOpenDocuments })
    clients.push(c)
    return c
  }

  it('initializes, syncs documents, and settles diagnostics for the current version', async () => {
    const c = client()
    await c.start()
    expect(c.state).toBe('ready')
    expect(c.serverCapabilities).toMatchObject({ renameProvider: true })
    const file = join(root, 'a.fk')
    writeFileSync(file, 'ok\nERROR here\n')
    let mark = c.diagnosticsMark(file)
    let v = await c.sync(file)
    expect(v).toBe(1)
    const first = await c.waitForDiagnostics(file, { mark, version: v, settleMs: 30 })
    expect(first?.map((d) => d.range.start.line)).toEqual([1])

    // A change bumps the version and the settled list is about the new text.
    mark = c.diagnosticsMark(file)
    v = await c.sync(file, 'ok\nfine\nWARN\n')
    expect(v).toBe(2)
    const second = await c.waitForDiagnostics(file, { mark, version: v, settleMs: 30 })
    expect(second).toEqual([expect.objectContaining({ severity: 2 })])
    // Same text again: no change sent, version unchanged.
    expect(await c.sync(file, 'ok\nfine\nWARN\n')).toBe(2)
    await c.stop()
    expect(c.state).toBe('stopped')
  })

  it('gives up waiting when the server stays silent', async () => {
    const c = client({ FAKE_LSP_SILENT: '1' })
    await c.start()
    const file = join(root, 'a.fk')
    writeFileSync(file, 'ERROR\n')
    const mark = c.diagnosticsMark(file)
    const v = await c.sync(file)
    expect(await c.waitForDiagnostics(file, { mark, version: v, timeoutMs: 80 })).toBeNull()
    await c.stop()
  })

  it('accepts diagnostics without a version once they postdate the change', async () => {
    const c = client({ FAKE_LSP_NO_VERSION: '1' })
    await c.start()
    const file = join(root, 'a.fk')
    writeFileSync(file, 'ERROR\n')
    const mark = c.diagnosticsMark(file)
    const v = await c.sync(file)
    expect(await c.waitForDiagnostics(file, { mark, version: v, settleMs: 20 })).toHaveLength(1)
    await c.stop()
  })

  it('notices a crash: state goes dead with a reason, and waiters are released', async () => {
    const c = client({ FAKE_LSP_CRASH_ON: 'textDocument/didChange' })
    await c.start()
    const file = join(root, 'a.fk')
    writeFileSync(file, 'one\n')
    await c.sync(file)
    const mark = c.diagnosticsMark(file)
    const v = await c.sync(file, 'two\n')
    const res = await c.waitForDiagnostics(file, { mark, version: v, timeoutMs: 5000 })
    expect(res).toBeNull()
    expect(c.state).toBe('dead')
    expect(c.deathReason).toMatch(/exited|closed|ended/)
    await expect(c.request('textDocument/hover', {})).rejects.toThrow(/not running/)
  })

  it('kills the whole process tree, not just the sandbox shell', async () => {
    const spec = serverRegistry([FAKE_SERVER])[0]
    const killTree = vi.fn((p: ChildProcess) => {
      p.kill('SIGKILL')
    })
    const c = new LspClient({ server: resolveServer(spec)!, roots: [root], spawn: fakeSpawn(), killTree })
    clients.push(c)
    await c.start()
    c.kill()
    expect(killTree).toHaveBeenCalledTimes(1)
    expect(c.state).toBe('stopped')
  })

  it('reports a server that fails to initialize', async () => {
    const c = client({ FAKE_LSP_CRASH_ON: 'initialize' })
    await expect(c.start()).rejects.toThrow()
    expect(c.state).toBe('dead')
  })

  it('closes the least recently used document past the open-document cap', async () => {
    const c = client({}, 2)
    await c.start()
    const files = ['a', 'b', 'c'].map((n) => join(root, `${n}.fk`))
    for (const f of files) {
      writeFileSync(f, f)
      await c.sync(f)
    }
    expect(files.map((f) => c.isOpen(f))).toEqual([false, true, true])
    await c.stop()
  })
})

describe('LspManager', () => {
  it('starts lazily, reuses the server, and refuses files outside the roots', async () => {
    const m = makeManager()
    const file = join(root, 'a.fk')
    writeFileSync(file, 'x\n')
    expect(m.runningCount()).toBe(0)
    const a = await m.clientFor(file, [root])
    const b = await m.clientFor(file, [root])
    expect(a).not.toBeNull()
    expect(a).toBe(b)
    expect(m.runningCount()).toBe(1)
    const outside = mkdtempSync(join(tmpdir(), 'houston-lsp-out-'))
    try {
      writeFileSync(join(outside, 'b.fk'), '')
      expect(await m.clientFor(join(outside, 'b.fk'), [root])).toBeNull()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
    expect(await m.clientFor(join(root, 'a.txt'), [root])).toBeNull() // no server covers .txt
  })

  it('restarts a crashed server on the next use, up to a crash budget', async () => {
    let now = 0
    const m = makeManager({ FAKE_LSP_CRASH_ON: 'textDocument/didOpen' }, { now: () => now })
    const file = join(root, 'a.fk')
    writeFileSync(file, 'x\n')
    for (let i = 0; i < 3; i++) {
      const c = await m.clientFor(file, [root])
      expect(c).not.toBeNull()
      await c!.sync(file)
      await vi.waitFor(() => expect(c!.state).toBe('dead'))
    }
    // Three crashes inside the window: no fourth start.
    expect(await m.clientFor(file, [root])).toBeNull()
    // Once the window passes, it may try again.
    now += 10 * 60_000
    expect(await m.clientFor(file, [root])).not.toBeNull()
  })

  it('does not count a slow start against the idle timeout', async () => {
    // Initialize takes longer than the idle timeout; the server must still come up.
    const m = makeManager({ FAKE_LSP_INIT_DELAY_MS: '150' }, { idleTimeoutMs: 40 })
    const file = join(root, 'a.fk')
    writeFileSync(file, 'x\n')
    const c = await m.clientFor(file, [root])
    expect(c?.state).toBe('ready')
  })

  it('stops a server after it sits idle', async () => {
    const m = makeManager({}, { idleTimeoutMs: 50 })
    const file = join(root, 'a.fk')
    writeFileSync(file, 'x\n')
    const c = await m.clientFor(file, [root])
    expect(c?.state).toBe('ready')
    await vi.waitFor(() => expect(c?.state).toBe('stopped'), { timeout: 3000 })
    expect(m.runningCount()).toBe(0)
  })

  it('shuts servers down politely: shutdown, then exit', async () => {
    const log = join(root, 'methods.log')
    const m = makeManager({ FAKE_LSP_LOG: log })
    const file = join(root, 'a.fk')
    writeFileSync(file, 'x\n')
    await m.clientFor(file, [root])
    await m.stopAll()
    const methods = readFileSync(log, 'utf8').trim().split('\n')
    expect(methods.slice(0, 2)).toEqual(['initialize', 'initialized'])
    expect(methods.slice(-2)).toEqual(['shutdown', 'exit'])
  })

  it('stays off when disabled, and on an unsandboxed host unless turned on explicitly', async () => {
    const file = join(root, 'a.fk')
    writeFileSync(file, 'x\n')
    const off = makeManager()
    off.configure({ lspEnabled: false, lspServers: [FAKE_SERVER] })
    expect(off.blockedReason()).toBe('disabled')
    expect(await off.clientFor(file, [root])).toBeNull()

    const bare = makeManager({}, { sandboxed: () => false })
    expect(bare.blockedReason()).toBe('unsandboxed')
    expect(await bare.clientFor(file, [root])).toBeNull()
    bare.configure({ lspEnabled: true, lspServers: [FAKE_SERVER] })
    expect(await bare.clientFor(file, [root])).not.toBeNull()

    const cmd = makeManager({}, { launchable: () => false })
    cmd.configure({ lspEnabled: true, lspServers: [FAKE_SERVER] })
    expect(cmd.blockedReason()).toBe('needs-git-bash')

    const killed = makeManager({}, { env: { HOUSTON_LSP: 'off' } })
    killed.configure({ lspEnabled: true, lspServers: [FAKE_SERVER] })
    expect(killed.blockedReason()).toBe('disabled')
  })

  it('offers servers only for workspaces that use the language', () => {
    const m = makeManager()
    expect(m.availableFor([root]).map((s) => s.id)).not.toContain('fake')
    writeFileSync(join(root, 'fake.json'), '{}')
    expect(m.availableFor([root]).map((s) => s.id)).toContain('fake')
  })

  it('keeps open documents in sync with writes and shell changes', async () => {
    const m = makeManager()
    const file = join(root, 'a.fk')
    writeFileSync(file, 'one\n')
    const c = (await m.clientFor(file, [root]))!
    await c.sync(file)
    writeFileSync(file, 'two\n')
    await m.noteWrite(file, [root])
    expect(c.openText(file)).toBe('two\n')
    writeFileSync(file, 'three\n')
    // A shell command only marks the server; the documents are re-read on next use.
    m.noteShell([root])
    expect(c.openText(file)).toBe('two\n')
    expect(await m.clientFor(file, [root])).toBe(c)
    expect(c.openText(file)).toBe('three\n')
    rmSync(file)
    await m.noteWrite(file, [root])
    expect(c.isOpen(file)).toBe(false)
  })
})

describe('post-edit diagnostics', () => {
  it('diffs by problem, not position, and counts duplicates', () => {
    const d = (line: number, message: string, severity = 1) => ({
      range: { start: { line, character: 0 }, end: { line, character: 1 } },
      severity,
      message
    })
    const before = [d(1, 'a'), d(2, 'b')]
    const after = [d(5, 'a'), d(6, 'b'), d(7, 'b'), d(8, 'c')]
    expect(newDiagnostics(before, after).map((x) => [x.range.start.line, x.message])).toEqual([
      [7, 'b'],
      [8, 'c']
    ])
  })

  it('formats errors first and caps warnings', () => {
    const warn = (i: number) => ({ range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } }, severity: 2, message: `w${i}` })
    const block = formatEditDiagnostics({
      server: 'Fake language server',
      rel: 'a.fk',
      fresh: [...Array.from({ length: 8 }, (_, i) => warn(i)), { ...warn(9), severity: 1, message: 'boom' }],
      compared: true,
      preexisting: 2
    })!
    expect(block).toContain('1 new error and 8 new warnings in a.fk after this edit')
    expect(block.split('\n')[3]).toBe('a.fk:10:1 error: boom')
    expect(block).toContain('3 more warnings not shown')
    expect(block).toContain('2 problems from before this edit not shown')
    // Hints and information never count.
    expect(formatEditDiagnostics({ server: 's', rel: 'r', fresh: [{ ...warn(1), severity: 4 }], compared: true })).toBeUndefined()
  })

  it('reports only what the edit introduced, end to end', async () => {
    const m = makeManager()
    const file = join(root, 'a.fk')
    const before = 'ok\nERROR old\n'
    writeFileSync(file, 'ok\nERROR old\nERROR new\nWARN new\n')
    const r = await lspEditDiagnostics({ manager: m, abs: file, rel: 'a.fk', roots: [root], before, settleMs: 30 })
    expect(r.ran).toBe(true)
    expect(r.block).toContain('1 new error and 1 new warning in a.fk after this edit')
    expect(r.block).toContain('a.fk:3:1 error E1: something is broken: ERROR new')
    expect(r.block).not.toContain('ERROR old')
    expect(r.block).toContain('1 problem from before this edit not shown')

    // A follow-up edit that fixes things adds nothing.
    const prev = readFileSync(file, 'utf8')
    writeFileSync(file, 'ok\n')
    const clean = await lspEditDiagnostics({ manager: m, abs: file, rel: 'a.fk', roots: [root], before: prev, settleMs: 30 })
    expect(clean).toMatchObject({ ran: true })
    expect(clean.block).toBeUndefined()
  })

  it('reuses the baseline a read already loaded, so the edit costs one change', async () => {
    const log = join(root, 'methods.log')
    const m = makeManager({ FAKE_LSP_LOG: log })
    const file = join(root, 'a.fk')
    const before = 'ERROR old\n'
    writeFileSync(file, before)
    // A read never starts a server...
    await m.noteRead(file, [root])
    expect(m.runningCount()).toBe(0)
    // ...but warms one that is already running.
    const c = (await m.clientFor(file, [root]))!
    await m.noteRead(file, [root])
    expect(c.isOpen(file)).toBe(true)
    await vi.waitFor(() => expect(c.currentDiagnostics(file)).toHaveLength(1))
    writeFileSync(file, 'ERROR old\nERROR new\n')
    const r = await lspEditDiagnostics({ manager: m, abs: file, rel: 'a.fk', roots: [root], before, settleMs: 20 })
    expect(r.block).toContain('1 new error')
    const methods = readFileSync(log, 'utf8').trim().split('\n')
    expect(methods.filter((x) => x === 'textDocument/didOpen')).toHaveLength(1)
    expect(methods.filter((x) => x === 'textDocument/didChange')).toHaveLength(1)
  })

  it('waits out a stale unversioned publish for the text before the change', async () => {
    const m = makeManager({ FAKE_LSP_STALE: '1', FAKE_LSP_NO_VERSION: '1', FAKE_LSP_DIAG_DELAY_MS: '400' })
    const file = join(root, 'a.fk')
    const before = 'ERROR old\n'
    writeFileSync(file, before)
    const c = (await m.clientFor(file, [root]))!
    await c.sync(file)
    await vi.waitFor(() => expect(c.currentDiagnostics(file)).toHaveLength(1))
    writeFileSync(file, 'ERROR old\nERROR new\n')
    // The stale verdict (one error) lands at once; the real one (two) 400ms later.
    const r = await lspEditDiagnostics({ manager: m, abs: file, rel: 'a.fk', roots: [root], before, settleMs: 50 })
    expect(r.block).toContain('1 new error')
  })

  it('does not take diagnostics published for an older version as current', async () => {
    const m = makeManager({ FAKE_LSP_DIAG_DELAY_MS: '200' })
    const file = join(root, 'a.fk')
    writeFileSync(file, 'ERROR\n')
    const c = (await m.clientFor(file, [root]))!
    await c.sync(file)
    expect(c.currentDiagnostics(file)).toBeUndefined() // nothing published yet
    await vi.waitFor(() => expect(c.currentDiagnostics(file)).toHaveLength(1))
    await c.sync(file, 'clean\n')
    expect(c.currentDiagnostics(file)).toBeUndefined() // the list on hand is about the old text
  })

  it('lists every problem in a new file', async () => {
    const m = makeManager()
    const file = join(root, 'new.fk')
    writeFileSync(file, 'ERROR\n')
    const r = await lspEditDiagnostics({ manager: m, abs: file, rel: 'new.fk', roots: [root], before: null, settleMs: 20 })
    expect(r.block).toContain('1 new error in new.fk')
  })

  it('times out quietly when the server never publishes', async () => {
    const m = makeManager({ FAKE_LSP_SILENT: '1' })
    const file = join(root, 'a.fk')
    writeFileSync(file, 'ERROR\n')
    const r = await lspEditDiagnostics({ manager: m, abs: file, rel: 'a.fk', roots: [root], before: null, timeoutMs: 60 })
    expect(r).toMatchObject({ ran: false, timedOut: true })
    expect(r.block).toBeUndefined()
  })

  it('does nothing for a file no server covers', async () => {
    const m = makeManager()
    const file = join(root, 'a.txt')
    writeFileSync(file, 'ERROR\n')
    expect(await lspEditDiagnostics({ manager: m, abs: file, rel: 'a.txt', roots: [root], before: '' })).toEqual({ ran: false })
  })
})

describe('write seam', () => {
  const target = (name: string, deleted = false) => ({ rel: name, abs: join(root, name), deleted })

  it('captures the baseline only for covered files, and nothing when diagnostics are off', async () => {
    const m = makeManager()
    writeFileSync(join(root, 'a.fk'), 'before')
    writeFileSync(join(root, 'b.txt'), 'before')
    const got = await captureBeforeWrite(m, [target('a.fk'), target('b.txt'), target('new.fk')], [root], undefined)
    expect([...got.entries()]).toEqual([
      [join(root, 'a.fk'), 'before'],
      [join(root, 'new.fk'), null]
    ])
    expect((await captureBeforeWrite(m, [target('a.fk')], [root], false)).size).toBe(0)
  })

  it('leaves credential files out, since a diagnostic can quote their content', async () => {
    const m = new LspManager({ sandboxed: () => true, launchable: () => true, env: {} })
    m.configure({ lspServers: [{ ...FAKE_SERVER, extensions: ['fk', 'env', 'pem'] }] })
    writeFileSync(join(root, 'key.pem'), 'secret')
    const got = await captureBeforeWrite(m, [target('key.pem'), target('a.fk')], [root], undefined)
    expect([...got.keys()]).toEqual([join(root, 'a.fk')])
  })

  it('falls back to the command-line checker only when diagnosticsOnSave is explicitly on', async () => {
    const m = makeManager()
    writeFileSync(join(root, 'b.txt'), 'x')
    const checker = vi.fn(async () => ({ ran: true, block: '\n\n[diagnostics: eslint reported problems]' }))
    const base = { manager: m, targets: [target('b.txt')], roots: [root], workspace: root, before: new Map(), checker }
    expect(await afterWrite({ ...base, diagnosticsOnSave: undefined })).toBe('')
    expect(checker).not.toHaveBeenCalled()
    expect(await afterWrite({ ...base, diagnosticsOnSave: true })).toContain('eslint')
    expect(await afterWrite({ ...base, diagnosticsOnSave: false })).toBe('')
    expect(checker).toHaveBeenCalledTimes(1)
  })

  it('uses the language server for covered files and skips the checker when it answered', async () => {
    const m = makeManager()
    const file = join(root, 'a.fk')
    writeFileSync(file, 'ok\n')
    const before = await captureBeforeWrite(m, [target('a.fk')], [root], true)
    writeFileSync(file, 'ok\nERROR\n')
    const checker = vi.fn(async () => ({ ran: true, block: 'CHECKER' }))
    const out = await afterWrite({
      manager: m,
      targets: [target('a.fk')],
      roots: [root],
      workspace: root,
      before,
      diagnosticsOnSave: true,
      checker
    })
    expect(out).toContain('1 new error in a.fk')
    expect(checker).not.toHaveBeenCalled()
  })

  it('syncs every target, including deleted ones, even with diagnostics off', async () => {
    const noteWrite = vi.fn(async () => {})
    await afterWrite({
      manager: { noteWrite, clientFor: async () => null },
      targets: [target('a.fk'), target('gone.fk', true)],
      roots: [root],
      workspace: root,
      before: new Map(),
      diagnosticsOnSave: false
    })
    expect(noteWrite).toHaveBeenCalledTimes(2)
    expect(existsSync(join(root, 'gone.fk'))).toBe(false)
  })
})
