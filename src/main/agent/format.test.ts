import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxRunResult } from '../sandbox'
import { FORMATTERS, formatterFor, hasBinary, formatFile } from './format'

describe('format: extension → formatter mapping', () => {
  it('maps web/text extensions to prettier', () => {
    for (const ext of ['js', 'ts', 'tsx', 'json', 'css', 'md', 'yaml']) {
      expect(FORMATTERS[ext]?.[0].bin).toBe('prettier')
    }
  })

  it('maps gofmt / rustfmt / python formatters', () => {
    expect(FORMATTERS.go?.[0].bin).toBe('gofmt')
    expect(FORMATTERS.rs?.[0].bin).toBe('rustfmt')
    expect(FORMATTERS.py?.map((f) => f.bin)).toEqual(['ruff', 'black'])
  })

  it('builds the right argv per formatter', () => {
    expect(FORMATTERS.ts[0].args('/a/b.ts')).toEqual(['--write', '/a/b.ts'])
    expect(FORMATTERS.go[0].args('/a/b.go')).toEqual(['-w', '/a/b.go'])
    expect(FORMATTERS.rs[0].args('/a/b.rs')).toEqual(['/a/b.rs'])
    expect(FORMATTERS.py[0].args('/a/b.py')).toEqual(['format', '/a/b.py']) // ruff
    expect(FORMATTERS.py[1].args('/a/b.py')).toEqual(['-q', '/a/b.py']) // black
  })

  it('is case-insensitive on the extension', () => {
    const f = formatterFor('README.MD', { env: { PATH: '/b' }, exists: (p) => p === '/b/prettier' })
    expect(f?.bin).toBe('prettier')
  })

  it('returns null for unmapped extensions', () => {
    const opts = { env: { PATH: '/b' }, exists: () => true }
    expect(formatterFor('a.bin', opts)).toBeNull()
    expect(formatterFor('a.exe', opts)).toBeNull()
    expect(formatterFor('noext', opts)).toBeNull()
  })
})

describe('format: binary gating', () => {
  it('hasBinary finds a binary on PATH', () => {
    const has = hasBinary('prettier', {
      env: { PATH: '/opt/tools:/usr/bin' },
      exists: (p) => p === '/opt/tools/prettier'
    })
    expect(has).toBe(true)
  })

  it('hasBinary checks the standard install dirs too', () => {
    expect(
      hasBinary('gofmt', { env: { PATH: '' }, exists: (p) => p === '/opt/homebrew/bin/gofmt' })
    ).toBe(true)
  })

  it('hasBinary is false when the binary is absent everywhere', () => {
    expect(hasBinary('rustfmt', { env: { PATH: '/x:/y' }, exists: () => false })).toBe(false)
  })

  it('hasBinary rejects path-like names', () => {
    expect(hasBinary('../evil', { exists: () => true })).toBe(false)
    expect(hasBinary('/abs/bin', { exists: () => true })).toBe(false)
    expect(hasBinary('', { exists: () => true })).toBe(false)
  })

  it('formatterFor prefers ruff but falls back to black', () => {
    expect(formatterFor('a.py', { env: { PATH: '' }, exists: () => false })).toBeNull()
    expect(formatterFor('a.py', { env: { PATH: '/b' }, exists: (p) => p === '/b/black' })?.bin).toBe(
      'black'
    )
    expect(
      formatterFor('a.py', { env: { PATH: '/b' }, exists: (p) => p.endsWith('/ruff') })?.bin
    ).toBe('ruff')
  })

  it('formatterFor returns null when no mapped binary is installed', () => {
    expect(formatterFor('a.ts', { env: { PATH: '/b' }, exists: () => false })).toBeNull()
  })
})

describe('formatFile gating (no formatter actually invoked)', () => {
  let ws: string
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'houston-fmt-'))
  })
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true })
  })

  const okResult: SandboxRunResult = {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    sandboxed: true
  }

  it('no-ops (without running) when no binary is present', async () => {
    writeFileSync(join(ws, 'a.ts'), 'const x=1')
    let ran = false
    const res = await formatFile('a.ts', {
      workspace: ws,
      roots: [ws],
      hasBin: () => false,
      run: async () => {
        ran = true
        return okResult
      }
    })
    expect(res.formatted).toBe(false)
    expect(ran).toBe(false)
  })

  it('no-ops for an unmapped extension', async () => {
    writeFileSync(join(ws, 'a.bin'), 'x')
    let ran = false
    const res = await formatFile('a.bin', {
      workspace: ws,
      roots: [ws],
      hasBin: () => true,
      run: async () => {
        ran = true
        return okResult
      }
    })
    expect(res.formatted).toBe(false)
    expect(ran).toBe(false)
  })

  it('no-ops for a path that escapes the allowed roots', async () => {
    let ran = false
    const res = await formatFile('../../etc/hosts', {
      workspace: ws,
      roots: [ws],
      hasBin: () => true,
      run: async () => {
        ran = true
        return okResult
      }
    })
    expect(res.formatted).toBe(false)
    expect(ran).toBe(false)
  })

  it('no-ops when the file does not exist', async () => {
    let ran = false
    const res = await formatFile('ghost.ts', {
      workspace: ws,
      roots: [ws],
      hasBin: () => true,
      run: async () => {
        ran = true
        return okResult
      }
    })
    expect(res.formatted).toBe(false)
    expect(ran).toBe(false)
  })

  it('runs the formatter (sandboxed, no network) when binary present + path in roots', async () => {
    writeFileSync(join(ws, 'a.ts'), 'const x=1')
    let captured: { command: string; allowNetwork: boolean; roots?: string[] } | null = null
    const res = await formatFile('a.ts', {
      workspace: ws,
      roots: [ws],
      hasBin: (b) => b === 'prettier',
      run: async (opts) => {
        captured = { command: opts.command, allowNetwork: opts.allowNetwork, roots: opts.roots }
        return okResult
      }
    })
    expect(res.formatted).toBe(true)
    expect(res.bin).toBe('prettier')
    expect(res.exitCode).toBe(0)
    expect(captured).not.toBeNull()
    expect(captured!.allowNetwork).toBe(false)
    expect(captured!.command).toContain('prettier')
    expect(captured!.command).toContain('--write')
    expect(captured!.command).toContain(join(ws, 'a.ts'))
    expect(captured!.roots).toEqual([ws])
  })

  it('quotes paths with spaces safely', async () => {
    writeFileSync(join(ws, 'a b.ts'), 'const x=1')
    let cmd = ''
    await formatFile('a b.ts', {
      workspace: ws,
      roots: [ws],
      hasBin: (b) => b === 'prettier',
      run: async (opts) => {
        cmd = opts.command
        return okResult
      }
    })
    expect(cmd).toContain(`'${join(ws, 'a b.ts')}'`)
  })
})

// Real end-to-end pass through the actual Seatbelt sandbox runner. Skipped unless
// gofmt is installed AND we're on macOS (sandbox-exec) — the spec requires the
// exec test not to depend on any formatter being present.
const gofmtPresent = hasBinary('gofmt')
const canExec = gofmtPresent && process.platform === 'darwin'
describe.skipIf(!canExec)('formatFile (real sandbox exec)', () => {
  let ws: string
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'houston-fmt-real-'))
  })
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true })
  })

  it('actually reformats a Go file with gofmt', async () => {
    const f = join(ws, 'main.go')
    // gofmt converts spaces to tabs and tightens spacing — easy to assert on.
    writeFileSync(f, 'package main\nfunc main()  {\n    x := 1\n_ = x\n}\n')
    const res = await formatFile('main.go', { workspace: ws, roots: [ws] })
    expect(res.formatted).toBe(true)
    expect(res.bin).toBe('gofmt')
    expect(res.exitCode).toBe(0)
    const out = readFileSync(f, 'utf8')
    expect(out).toContain('\tx := 1') // re-indented with a tab
    expect(out).not.toContain('func main()  {') // double space collapsed
  })
})
