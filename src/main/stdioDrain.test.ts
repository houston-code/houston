import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { buildSync } from 'esbuild'
import { drainStream } from './stdioDrain'

describe('drainStream', () => {
  it('resolves at once for a stream with nothing queued', async () => {
    await drainStream(new PassThrough())
  })

  /** A stream that takes `ms` to flush each chunk, recording what it flushed. */
  function slowStream(ms: number) {
    const flushed: string[] = []
    const stream = new Writable({
      write(chunk, _enc, cb) {
        setTimeout(() => {
          flushed.push(String(chunk))
          cb()
        }, ms)
      }
    })
    return { stream, flushed }
  }

  it('waits until queued writes are flushed', async () => {
    const { stream, flushed } = slowStream(5)
    stream.write('a')
    stream.write('b')
    await drainStream(stream)
    expect(flushed.slice(0, 2)).toEqual(['a', 'b'])
  })

  it('bypasses an instance write override (ACP points stdout.write at stderr)', async () => {
    const { stream, flushed } = slowStream(5)
    stream.write('queued')
    const redirected: unknown[] = []
    stream.write = ((chunk: unknown) => {
      redirected.push(chunk)
      return true
    }) as typeof stream.write
    await drainStream(stream)
    expect(flushed[0]).toBe('queued')
    expect(redirected).toEqual([])
  })

  it('gives up on a reader that never reads, after the timeout', async () => {
    const stuck = new Writable({ write() {} })
    stuck.write('x')
    await drainStream(stuck, 20)
  })

  it('resolves when the stream errors (the reader went away)', async () => {
    const s = new Writable({ write() {} })
    s.on('error', () => {})
    s.write('x')
    const done = drainStream(s)
    s.destroy(new Error('EPIPE'))
    await done
  })

  it('delivers every byte written to a pipe before the process exits', async () => {
    // The exit path as the CLI runs it, in a real child whose stdout is a pipe: on
    // macOS a bare process.exit here delivered only the first 64 KB.
    const dir = mkdtempSync(join(tmpdir(), 'houston-drain-'))
    try {
      const bundle = join(dir, 'drain.cjs')
      buildSync({
        entryPoints: [join(__dirname, 'stdioDrain.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: bundle,
        logLevel: 'silent'
      })
      const size = 1_000_000
      const script = `
        const { drainStdio } = require(process.argv[1])
        process.stdout.write('x'.repeat(${size}) + '\\n')
        process.stderr.write('e'.repeat(${size}) + '\\n')
        void drainStdio().finally(() => process.exit(0))
      `
      const child = spawn(process.execPath, ['-e', script, bundle], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = 0
      let err = 0
      child.stdout.on('data', (d: Buffer) => (out += d.length))
      child.stderr.on('data', (d: Buffer) => (err += d.length))
      const code = await new Promise<number | null>((r) => child.on('close', r))
      expect(code).toBe(0)
      expect(out).toBe(size + 1)
      expect(err).toBe(size + 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
