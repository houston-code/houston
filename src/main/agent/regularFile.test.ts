import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { isNotRegularFileError, openRegularFile, readRegularFile } from './regularFile'
import { getTool, staleWriteRefusal, type ToolContext } from './tools'
import { FileReadTracker } from './readCache'
import { previewWrite } from './writePreview'
import { checkpointFileCount, clearCheckpoints, flushCheckpoints, recordOriginal } from './checkpoints'

// FIFOs are POSIX only; Windows has none, and there the helper reads like fs does.
const posix = process.platform !== 'win32'

let ws: string
let fifos: string[]

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'houston-regular-')))
  fifos = []
})

afterEach(async () => {
  // A read that did block on a FIFO (the bug) would pin a threadpool thread for the
  // rest of the run: open the write end once so it sees EOF and lets go.
  for (const f of fifos) {
    try {
      closeSync(openSync(f, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK))
    } catch {
      // no reader waiting
    }
  }
  await flushCheckpoints()
  clearCheckpoints()
  rmSync(ws, { recursive: true, force: true })
})

function mkfifo(rel: string): string {
  const p = join(ws, rel)
  execFileSync('mkfifo', [p])
  fifos.push(p)
  return p
}

/** `p`, or a rejection naming the hang when it takes longer than a blocked read would let go. */
async function promptly<T>(p: Promise<T>, ms = 2000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const hang = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`hung for ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([p, hang])
  } finally {
    clearTimeout(timer)
  }
}

/** The outcome of `p`: its value, or the message it rejected with, so a hang is distinguishable. */
async function settle(p: Promise<unknown>): Promise<string> {
  try {
    return `ok: ${String(await promptly(p))}`
  } catch (e) {
    return `error: ${(e as Error).message}`
  }
}

describe('readRegularFile', () => {
  it('reads a regular file, also through a symlink', async () => {
    writeFileSync(join(ws, 'a.txt'), 'hello')
    symlinkSync(join(ws, 'a.txt'), join(ws, 'link'))
    expect((await readRegularFile(join(ws, 'a.txt'))).toString()).toBe('hello')
    expect((await readRegularFile(join(ws, 'link'))).toString()).toBe('hello')
  })

  it('reports a missing file as ENOENT and a directory as EISDIR, like fs.readFile', async () => {
    await expect(readRegularFile(join(ws, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readRegularFile(ws)).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it.skipIf(!posix)('refuses a FIFO at once instead of blocking until a writer appears', async () => {
    const fifo = mkfifo('pipe')
    const err = await promptly(readRegularFile(fifo, 'pipe')).catch((e: unknown) => e)
    expect(isNotRegularFileError(err)).toBe(true)
    expect((err as Error).message).toMatch(/^pipe is a FIFO \(named pipe\), not a regular file/)
  })

  it.skipIf(!posix)('refuses a symlink to a character device instead of reading it forever', async () => {
    symlinkSync('/dev/zero', join(ws, 'zero'))
    const err = await promptly(readRegularFile(join(ws, 'zero'))).catch((e: unknown) => e)
    expect(isNotRegularFileError(err)).toBe(true)
    expect((err as Error).message).toMatch(/a character device/)
  })

  it.skipIf(!posix)('hands back an open handle only for a regular file', async () => {
    writeFileSync(join(ws, 'a.txt'), 'x')
    const fh = await openRegularFile(join(ws, 'a.txt'))
    expect((await fh.stat()).isFile()).toBe(true)
    await fh.close()
    await expect(promptly(openRegularFile(mkfifo('p2')))).rejects.toThrow(/FIFO/)
  })
})

describe.skipIf(!posix)('file tools on a FIFO or device', () => {
  let ctx: ToolContext
  beforeEach(() => {
    ctx = { workspace: ws, allowNetwork: false, fileTracker: new FileReadTracker() }
  })
  const run = (name: string, args: Record<string, unknown>): Promise<string> => getTool(name)!.execute(args, ctx)

  it('read_file refuses a FIFO and a symlink to one, promptly', async () => {
    const fifo = mkfifo('pipe')
    symlinkSync(fifo, join(ws, 'link.txt'))
    expect(await settle(run('read_file', { path: 'pipe' }))).toMatch(/^error: pipe is not a regular file/)
    expect(await settle(run('read_file', { path: 'link.txt' }))).toMatch(/^error: link\.txt is not a regular file/)
  })

  it('read_file refuses a FIFO named like a notebook, image, or PDF', async () => {
    for (const name of ['n.ipynb', 'i.png', 'd.pdf']) {
      mkfifo(name)
      expect(await settle(run('read_file', { path: name }))).toMatch(/^error: .* is not a regular file/)
    }
  })

  it('write_file reaches the FIFO refusal instead of hanging on the read before it', async () => {
    const fifo = mkfifo('pipe')
    expect(await settle(run('write_file', { path: 'pipe', content: 'x' }))).toMatch(/not a regular file/)
    expect(await promptly(staleWriteRefusal('write_file', { path: 'pipe' }, [ws], ctx.fileTracker))).toBeNull()
    expect(existsSync(fifo)).toBe(true)
  })

  it('edit_file, multi_edit, notebook_edit, and apply_patch refuse a FIFO promptly', async () => {
    mkfifo('pipe')
    mkfifo('nb.ipynb')
    expect(await settle(run('edit_file', { path: 'pipe', old_string: 'a', new_string: 'b' }))).toMatch(
      /^error: pipe is a FIFO/
    )
    expect(
      await settle(run('multi_edit', { path: 'pipe', edits: [{ old_string: 'a', new_string: 'b' }] }))
    ).toMatch(/^error: pipe is a FIFO/)
    expect(await settle(run('notebook_edit', { path: 'nb.ipynb', cell: 1, source: 'x' }))).toMatch(
      /^error: nb\.ipynb is a FIFO/
    )
    const patch = '*** Begin Patch\n*** Update File: pipe\n@@\n-a\n+b\n*** End Patch'
    expect(await settle(run('apply_patch', { patch }))).toMatch(/^error: Update File: pipe is a FIFO/)
  })

  it('the write preview and the checkpoint snapshot skip a FIFO instead of blocking', async () => {
    mkfifo('pipe')
    expect(await settle(previewWrite('edit_file', { path: 'pipe', old_string: 'a', new_string: 'b' }, [ws]))).toBe(
      'ok: null'
    )
    expect(await settle(recordOriginal('run-fifo', [ws], 'pipe'))).toBe('ok: undefined')
    expect(checkpointFileCount('run-fifo')).toBe(1)
  })

  it('still reads and edits a regular file through a symlink inside the project', async () => {
    writeFileSync(join(ws, 'real.txt'), 'one two\n')
    symlinkSync(join(ws, 'real.txt'), join(ws, 'alias.txt'))
    expect(await run('read_file', { path: 'alias.txt' })).toBe('1\tone two')
    await run('edit_file', { path: 'alias.txt', old_string: 'two', new_string: 'TWO' })
    expect(readFileSync(join(ws, 'real.txt'), 'utf8')).toBe('one TWO\n')
  })

  it('still refuses a symlink that leaves the project before looking at what it names', async () => {
    symlinkSync('/dev/zero', join(ws, 'out'))
    // /dev is outside the roots: containment refuses it first, as before.
    expect(await settle(run('edit_file', { path: 'out', old_string: 'a', new_string: 'b' }))).toMatch(/^error: /)
    expect(await settle(run('read_file', { path: 'out' }))).toMatch(/^error: /)
  })
})
