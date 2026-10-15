import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxRunResult } from '../sandbox'
import {
  FORMATTERS,
  WIN_BASH_EXTENSIONS,
  canRunTool,
  formatterFor,
  hasBinary,
  formatFile,
  planToolRun,
  resolveBinaryPath
} from './format'

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
    const f = formatterFor('README.MD', { platform: 'linux', env: { PATH: '/b' }, exists: (p) => p === '/b/prettier' })
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
      platform: 'linux',
      env: { PATH: '/opt/tools:/usr/bin' },
      exists: (p) => p === '/opt/tools/prettier'
    })
    expect(has).toBe(true)
  })

  it('hasBinary checks the standard install dirs too', () => {
    expect(
      hasBinary('gofmt', { platform: 'linux', env: { PATH: '' }, exists: (p) => p === '/opt/homebrew/bin/gofmt' })
    ).toBe(true)
  })

  it('hasBinary is false when the binary is absent everywhere', () => {
    expect(hasBinary('rustfmt', { platform: 'linux', env: { PATH: '/x:/y' }, exists: () => false })).toBe(false)
  })

  it('hasBinary rejects path-like names', () => {
    expect(hasBinary('../evil', { exists: () => true })).toBe(false)
    expect(hasBinary('/abs/bin', { exists: () => true })).toBe(false)
    expect(hasBinary('..\\evil', { exists: () => true })).toBe(false)
    expect(hasBinary('C:\\tools\\bin', { exists: () => true })).toBe(false)
    expect(hasBinary('', { exists: () => true })).toBe(false)
  })

  it('formatterFor prefers ruff but falls back to black', () => {
    expect(formatterFor('a.py', { platform: 'linux', env: { PATH: '' }, exists: () => false })).toBeNull()
    expect(formatterFor('a.py', { platform: 'linux', env: { PATH: '/b' }, exists: (p) => p === '/b/black' })?.bin).toBe(
      'black'
    )
    expect(
      formatterFor('a.py', { platform: 'linux', env: { PATH: '/b' }, exists: (p) => p.endsWith('/ruff') })?.bin
    ).toBe('ruff')
  })

  it('formatterFor returns null when no mapped binary is installed', () => {
    expect(formatterFor('a.ts', { platform: 'linux', env: { PATH: '/b' }, exists: () => false })).toBeNull()
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

// Windows behavior, exercised on every host through the platform / exists / env /
// shellSyntax seams (paths are built with literal backslashes, not the host's join).
describe('format: Windows binary lookup', () => {
  const env = { PATH: 'C:\\Tools;C:\\Users\\me\\AppData\\Roaming\\npm' }
  const npm = 'C:\\Users\\me\\AppData\\Roaming\\npm'

  it('finds native executables by their .exe / .com suffix', () => {
    const files = new Set(['C:\\Tools\\ruff.exe', `${npm}\\gofmt.com`])
    const exists = (p: string): boolean => files.has(p)
    expect(resolveBinaryPath('ruff', { platform: 'win32', env, exists })).toBe('C:\\Tools\\ruff.exe')
    expect(resolveBinaryPath('gofmt', { platform: 'win32', env, exists })).toBe(`${npm}\\gofmt.com`)
  })

  it('never resolves a .cmd / .bat shim, even under the Git Bash extension set', () => {
    const exists = (p: string): boolean => p.endsWith('.cmd') || p.endsWith('.bat')
    expect(resolveBinaryPath('prettier', { platform: 'win32', env, exists })).toBeNull()
    expect(
      resolveBinaryPath('prettier', { platform: 'win32', env, exists, extensions: WIN_BASH_EXTENSIONS })
    ).toBeNull()
  })

  it('finds the extensionless npm sh shim only with the Git Bash extension set', () => {
    const exists = (p: string): boolean => p === `${npm}\\prettier` || p === `${npm}\\prettier.cmd`
    expect(resolveBinaryPath('prettier', { platform: 'win32', env, exists })).toBeNull()
    expect(
      resolveBinaryPath('prettier', { platform: 'win32', env, exists, extensions: WIN_BASH_EXTENSIONS })
    ).toBe(`${npm}\\prettier`)
  })

  it('searches dir-major: an earlier PATH dir wins over a better suffix later', () => {
    const files = new Set([`${npm}\\ruff.exe`, 'C:\\Tools\\ruff'])
    expect(
      resolveBinaryPath('ruff', {
        platform: 'win32',
        env,
        exists: (p) => files.has(p),
        extensions: WIN_BASH_EXTENSIONS
      })
    ).toBe('C:\\Tools\\ruff')
  })

  it('skips the POSIX install dirs and rejects drive-relative names', () => {
    const probed: string[] = []
    resolveBinaryPath('gofmt', { platform: 'win32', env: { PATH: '' }, exists: (p) => (probed.push(p), false) })
    expect(probed).toEqual([])
    expect(hasBinary('C:ruff', { platform: 'win32', env, exists: () => true })).toBe(false)
  })

  it('formatterFor uses the Git Bash extension set on Windows', () => {
    const f = formatterFor('a.ts', { platform: 'win32', env, exists: (p) => p === `${npm}\\prettier` })
    expect(f?.bin).toBe('prettier')
  })
})

describe('format: building the tool command', () => {
  const tool = { bin: 'prettier', args: (p: string) => ['--write', p] }
  // Every character cmd.exe or bash could treat specially.
  const nasty = "C:\\repo\\it's a & b ^ %PATH% $(x) `y` !z.ts"

  it('runs the resolved file in forward-slash form under Git Bash, every argv element single-quoted', () => {
    const plan = planToolRun([tool], nasty, {
      platform: 'win32',
      shellSyntax: 'posix',
      resolveBin: () => 'C:\\Program Files\\nodejs\\prettier'
    })
    expect(plan?.command).toBe(
      `'C:/Program Files/nodejs/prettier' '--write' 'C:\\repo\\it'\\''s a & b ^ %PATH% $(x) \`y\` !z.ts'`
    )
  })

  it('keeps running by the bare name on POSIX', () => {
    const plan = planToolRun([tool], '/w/a.ts', {
      platform: 'linux',
      shellSyntax: 'posix',
      resolveBin: () => '/opt/homebrew/bin/prettier'
    })
    expect(plan?.command).toBe(`'prettier' '--write' '/w/a.ts'`)
  })

  it('is disabled under the cmd.exe fallback, without even probing for the binary', () => {
    let probed = false
    const resolveBin = (): string => ((probed = true), 'C:\\Tools\\ruff.exe')
    expect(planToolRun([tool], 'C:\\a.ts', { platform: 'win32', shellSyntax: 'cmd', resolveBin })).toBeNull()
    expect(canRunTool('ruff', { platform: 'win32', shellSyntax: 'cmd', resolveBin })).toBe(false)
    expect(probed).toBe(false)
  })

  it('canRunTool reflects the lookup when the shell is bash-compatible', () => {
    const env = { PATH: 'C:\\npm' }
    const opts = { platform: 'win32' as const, shellSyntax: 'posix' as const, env }
    expect(canRunTool('prettier', { ...opts, exists: (p) => p === 'C:\\npm\\prettier' })).toBe(true)
    expect(canRunTool('prettier', { ...opts, exists: (p) => p === 'C:\\npm\\prettier.cmd' })).toBe(false)
  })

  // The quoting proven against a real shell: the path comes back as ONE argv element,
  // byte for byte, with nothing expanded or executed.
  it.runIf(process.platform !== 'win32')('round-trips a hostile path through a real POSIX shell', () => {
    const echo = { bin: 'printf', args: (p: string) => ['%s', p] }
    for (const platform of ['linux', 'win32'] as const) {
      const plan = planToolRun([echo], nasty, { platform, shellSyntax: 'posix', resolveBin: (b) => b })
      expect(execFileSync('/bin/sh', ['-c', plan!.command], { encoding: 'utf8' })).toBe(nasty)
    }
  })

  it('formatFile does not run under the cmd.exe fallback', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'houston-fmt-cmd-'))
    try {
      writeFileSync(join(ws, 'a.ts'), 'const x=1')
      let ran = false
      const res = await formatFile('a.ts', {
        workspace: ws,
        roots: [ws],
        shellSyntax: 'cmd',
        hasBin: () => true,
        run: async () => {
          ran = true
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false, sandboxed: false }
        }
      })
      expect(res.formatted).toBe(false)
      expect(ran).toBe(false)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('formatFile on Windows (Git Bash) runs the resolved formatter path', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'houston-fmt-win-'))
    try {
      writeFileSync(join(ws, 'a.py'), 'x=1')
      let cmd = ''
      const res = await formatFile('a.py', {
        workspace: ws,
        roots: [ws],
        platform: 'win32',
        shellSyntax: 'posix',
        env: { PATH: 'C:\\Py\\Scripts' },
        exists: (p) => p === 'C:\\Py\\Scripts\\black.exe',
        run: async (o) => {
          cmd = o.command
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false, sandboxed: false }
        }
      })
      expect(res).toMatchObject({ formatted: true, bin: 'black' })
      expect(cmd).toBe(`'C:/Py/Scripts/black.exe' '-q' '${join(ws, 'a.py')}'`)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})
