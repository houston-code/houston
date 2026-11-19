import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OutputTee, ShellSpill, prune, spillNote } from './shellSpill'
import { createSecretRedactor } from './redact'

// The runner streams its output the way the real one does (onOutput per chunk) and
// returns it whole, so the clamp in run_shell is the one that drops the middle.
const h = vi.hoisted(() => ({ output: '' }))
vi.mock('../sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sandbox')>()
  return {
    ...actual,
    sandboxAvailable: () => true,
    runSandboxed: async (opts: { onOutput?: (c: string) => void }) => {
      for (let i = 0; i < h.output.length; i += 1000) opts.onOutput?.(h.output.slice(i, i + 1000))
      return { stdout: h.output, stderr: '', exitCode: 0, timedOut: false, sandboxed: true }
    }
  }
})

const { getTool } = await import('./tools')

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'houston-spill-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')

describe('OutputTee', () => {
  it('keeps everything under the cap and marks an overflow', () => {
    const tee = new OutputTee(10)
    tee.push('abcd')
    tee.push('efgh')
    expect(tee.overflowed).toBe(false)
    tee.push('ijkl')
    expect(tee.text()).toBe('abcdefghij')
    expect(tee.overflowed).toBe(true)
    tee.push('more')
    expect(tee.text()).toBe('abcdefghij')
  })
})

describe('ShellSpill', () => {
  it('writes the redacted output with owner-only permissions and counts its lines', async () => {
    const redact = createSecretRedactor(['s3cret-value-123'])
    const spill = new ShellSpill(join(base, 'shell-output'), 'run/1', redact)
    const r = await spill.spill('a\npassword=s3cret-value-123\nc\n')
    expect(r?.lines).toBe(3)
    expect(r?.path).toBe(join(base, 'shell-output', 'run_1', 'shell-1.log'))
    const text = readFileSync(r!.path, 'utf8')
    expect(text).not.toContain('s3cret-value-123')
    if (process.platform !== 'win32') expect(statSync(r!.path).mode & 0o777).toBe(0o600)
  })

  it('stops spilling once the run budget is spent', async () => {
    const spill = new ShellSpill(join(base, 'out'), 'r', (t) => t, { runMaxBytes: 15, maxAgeMs: 1e9, keepRuns: 5 })
    expect(await spill.spill('0123456789')).not.toBeNull()
    expect(await spill.spill('0123456789')).toBeNull()
  })

  it('prunes run folders past the age limit and beyond the newest few', async () => {
    const now = Date.now()
    for (const [name, ageMs] of [['old', 2 * 86_400_000], ['a', 3000], ['b', 2000], ['c', 1000]] as const) {
      mkdirSync(join(base, name))
      const t = (now - ageMs) / 1000
      utimesSync(join(base, name), t, t)
    }
    await prune(base, 86_400_000, 2, now)
    expect(readdirSync(base).sort()).toEqual(['b', 'c'])
  })

  it('names the file and its line count in the note', () => {
    expect(spillNote({ path: '/data/shell-output/r/shell-1.log', lines: 5000 })).toMatch(
      /^\[full output \(5000 lines\) saved to \/data\/shell-output\/r\/shell-1\.log; read the part you need with run_shell/
    )
  })

  it('quotes a path with a space, so a copied command reads it as one word', () => {
    expect(spillNote({ path: "/Lib/Application Support/H/it's/shell-1.log", lines: 1 }, 'darwin')).toContain(
      `saved to '/Lib/Application Support/H/it'\\''s/shell-1.log';`
    )
  })

  it('quotes a POSIX path holding a backslash rather than leaving it to the shell', () => {
    expect(spillNote({ path: '/data/a\\b/shell-1.log', lines: 1 }, 'linux')).toContain(
      `saved to '/data/a\\b/shell-1.log';`
    )
  })

  it('writes a Windows path with forward slashes, double-quoted when it has a space', () => {
    // Git Bash reads an unquoted backslash as an escape: C:\Users\Dev came out as C:UsersDev.
    expect(spillNote({ path: 'C:\\Users\\Dev\\AppData\\Roaming\\Houston\\shell-output\\r\\shell-1.log', lines: 1 }, 'win32')).toContain(
      'saved to C:/Users/Dev/AppData/Roaming/Houston/shell-output/r/shell-1.log;'
    )
    expect(spillNote({ path: 'C:\\Users\\Jane Doe\\AppData\\shell-1.log', lines: 1 }, 'win32')).toContain(
      'saved to "C:/Users/Jane Doe/AppData/shell-1.log";'
    )
  })
})

describe('run_shell spills clamped output', () => {
  it('saves the whole output and points at it when the result is clamped', async () => {
    h.output = lines(5000)
    const spill = new ShellSpill(join(base, 'shell-output'), 'run', (t) => t)
    const out = await getTool('run_shell')!.execute(
      { command: 'make' },
      {
        workspace: base,
        allowNetwork: false,
        shellOutputMaxBytes: 2000,
        spillShellOutput: (o, note) => spill.spill(o, note)
      }
    )
    expect(out).toContain('bytes truncated')
    const m = /saved to (\S+);/.exec(out)
    expect(out).toContain('[full output (5000 lines)')
    expect(readFileSync(m![1], 'utf8')).toBe(h.output)
  })

  it('adds nothing when the output fits', async () => {
    h.output = lines(3)
    const calls: string[] = []
    const out = await getTool('run_shell')!.execute(
      { command: 'ls' },
      {
        workspace: base,
        allowNetwork: false,
        spillShellOutput: async (o) => (calls.push(o), null)
      }
    )
    expect(calls).toEqual([])
    expect(out).not.toContain('full output')
  })
})
