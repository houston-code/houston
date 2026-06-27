import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxRunResult } from '../sandbox'
import {
  CHECKERS,
  checkerFor,
  formatDiagnosticsBlock,
  runPostEditDiagnostics
} from './diagnostics'

describe('diagnostics: extension → checker mapping', () => {
  it('maps the JS/TS family to eslint', () => {
    for (const ext of ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs']) {
      expect(CHECKERS[ext]?.[0].bin).toBe('eslint')
    }
  })

  it('maps python to ruff then pyflakes, and go to gofmt', () => {
    expect(CHECKERS.py?.map((c) => c.bin)).toEqual(['ruff', 'pyflakes'])
    expect(CHECKERS.pyi?.map((c) => c.bin)).toEqual(['ruff', 'pyflakes'])
    expect(CHECKERS.go?.[0].bin).toBe('gofmt')
  })

  it('builds read-only argv per checker', () => {
    expect(CHECKERS.ts[0].args('/a/b.ts')).toEqual(['/a/b.ts'])
    expect(CHECKERS.py[0].args('/a/b.py')).toEqual(['check', '/a/b.py']) // ruff
    expect(CHECKERS.py[1].args('/a/b.py')).toEqual(['/a/b.py']) // pyflakes
    expect(CHECKERS.go[0].args('/a/b.go')).toEqual(['-l', '/a/b.go']) // gofmt -l, read-only
  })

  it('is case-insensitive on the extension', () => {
    const c = checkerFor('Main.PY', { env: { PATH: '/b' }, exists: (p) => p === '/b/ruff' })
    expect(c?.bin).toBe('ruff')
  })

  it('checkerFor prefers ruff but falls back to pyflakes', () => {
    expect(checkerFor('a.py', { env: { PATH: '' }, exists: () => false })).toBeNull()
    expect(
      checkerFor('a.py', { env: { PATH: '/b' }, exists: (p) => p === '/b/pyflakes' })?.bin
    ).toBe('pyflakes')
    expect(checkerFor('a.py', { env: { PATH: '/b' }, exists: (p) => p.endsWith('/ruff') })?.bin).toBe(
      'ruff'
    )
  })

  it('returns null for unmapped extensions', () => {
    const opts = { env: { PATH: '/b' }, exists: () => true }
    expect(checkerFor('a.bin', opts)).toBeNull()
    expect(checkerFor('a.rs', opts)).toBeNull() // no rust checker registered
    expect(checkerFor('noext', opts)).toBeNull()
  })
})

describe('formatDiagnosticsBlock', () => {
  const base = { bin: 'eslint', timedOut: false, workspace: '/ws', maxChars: 4000 }

  it('labels the checker and includes the output', () => {
    const block = formatDiagnosticsBlock({ ...base, output: '5:1 error Unexpected var' })
    expect(block).toContain('[diagnostics: eslint reported problems]')
    expect(block).toContain('5:1 error Unexpected var')
    expect(block.startsWith('\n\n')).toBe(true)
  })

  it('relativises workspace-absolute paths in the output', () => {
    const block = formatDiagnosticsBlock({ ...base, output: '/ws/src/a.ts\n  5:1  error  X' })
    expect(block).toContain('src/a.ts')
    expect(block).not.toContain('/ws/src/a.ts')
  })

  it('truncates output past maxChars and notes how much was dropped', () => {
    const block = formatDiagnosticsBlock({ ...base, output: 'x'.repeat(100), maxChars: 20 })
    expect(block).toContain('truncated, 80 more characters')
    expect(block.length).toBeLessThan(120)
  })

  it('reports a timeout distinctly', () => {
    const block = formatDiagnosticsBlock({ ...base, timedOut: true, output: '' })
    expect(block).toContain('timed out')
  })
})

describe('runPostEditDiagnostics gating', () => {
  let ws: string
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'houston-diag-'))
  })
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true })
  })

  const clean: SandboxRunResult = {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    sandboxed: true
  }

  it('no-ops (without running) when no checker binary is present', async () => {
    writeFileSync(join(ws, 'a.ts'), 'const x = 1')
    let ran = false
    const res = await runPostEditDiagnostics('a.ts', {
      workspace: ws,
      roots: [ws],
      hasBin: () => false,
      run: async () => {
        ran = true
        return clean
      }
    })
    expect(res.ran).toBe(false)
    expect(ran).toBe(false)
  })

  it('no-ops for an unmapped extension', async () => {
    writeFileSync(join(ws, 'a.bin'), 'x')
    let ran = false
    const res = await runPostEditDiagnostics('a.bin', {
      workspace: ws,
      roots: [ws],
      hasBin: () => true,
      run: async () => {
        ran = true
        return clean
      }
    })
    expect(res.ran).toBe(false)
    expect(ran).toBe(false)
  })

  it('no-ops for a path that escapes the allowed roots', async () => {
    let ran = false
    const res = await runPostEditDiagnostics('../../etc/hosts', {
      workspace: ws,
      roots: [ws],
      hasBin: () => true,
      run: async () => {
        ran = true
        return clean
      }
    })
    expect(res.ran).toBe(false)
    expect(ran).toBe(false)
  })

  it('no-ops when the file does not exist', async () => {
    let ran = false
    const res = await runPostEditDiagnostics('ghost.ts', {
      workspace: ws,
      roots: [ws],
      hasBin: () => true,
      run: async () => {
        ran = true
        return clean
      }
    })
    expect(res.ran).toBe(false)
    expect(ran).toBe(false)
  })

  it('runs the checker (sandboxed, no network, read-only argv) and produces no block when clean', async () => {
    writeFileSync(join(ws, 'a.ts'), 'const x = 1')
    let captured: { command: string; allowNetwork: boolean; roots?: string[] } | null = null
    const res = await runPostEditDiagnostics('a.ts', {
      workspace: ws,
      roots: [ws],
      hasBin: (b) => b === 'eslint',
      run: async (opts) => {
        captured = { command: opts.command, allowNetwork: opts.allowNetwork, roots: opts.roots }
        return clean
      }
    })
    expect(res.ran).toBe(true)
    expect(res.bin).toBe('eslint')
    expect(res.exitCode).toBe(0)
    expect(res.block).toBeUndefined()
    expect(captured).not.toBeNull()
    expect(captured!.allowNetwork).toBe(false)
    expect(captured!.command).toContain('eslint')
    expect(captured!.command).toContain(join(ws, 'a.ts'))
    expect(captured!.roots).toEqual([ws])
  })

  it('surfaces a block when the checker exits non-zero', async () => {
    writeFileSync(join(ws, 'a.ts'), 'var x = 1')
    const res = await runPostEditDiagnostics('a.ts', {
      workspace: ws,
      roots: [ws],
      hasBin: (b) => b === 'eslint',
      run: async () => ({
        stdout: `${join(ws, 'a.ts')}\n  1:1  error  Unexpected var  no-var`,
        stderr: '',
        exitCode: 1,
        timedOut: false,
        sandboxed: true
      })
    })
    expect(res.ran).toBe(true)
    expect(res.block).toContain('[diagnostics: eslint reported problems]')
    expect(res.block).toContain('no-var')
    expect(res.block).toContain('a.ts')
    expect(res.block).not.toContain(join(ws, 'a.ts')) // relativised
  })

  it('surfaces a block when a zero-exit checker prints findings (gofmt -l)', async () => {
    writeFileSync(join(ws, 'main.go'), 'package main')
    const res = await runPostEditDiagnostics('main.go', {
      workspace: ws,
      roots: [ws],
      hasBin: (b) => b === 'gofmt',
      run: async () => ({
        stdout: `${join(ws, 'main.go')}\n`,
        stderr: '',
        exitCode: 0,
        timedOut: false,
        sandboxed: true
      })
    })
    expect(res.ran).toBe(true)
    expect(res.exitCode).toBe(0)
    expect(res.block).toContain('[diagnostics: gofmt reported problems]')
    expect(res.block).toContain('main.go')
  })

  it('quotes paths with spaces safely', async () => {
    writeFileSync(join(ws, 'a b.ts'), 'const x = 1')
    let cmd = ''
    await runPostEditDiagnostics('a b.ts', {
      workspace: ws,
      roots: [ws],
      hasBin: (b) => b === 'eslint',
      run: async (opts) => {
        cmd = opts.command
        return clean
      }
    })
    expect(cmd).toContain(`'${join(ws, 'a b.ts')}'`)
  })
})
