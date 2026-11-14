import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { canRunTool, planToolRun, projectBinDirs, projectLocalBin } from './format'
import { BUILTIN_SERVERS, projectPython, resolveServer } from './lsp/servers'

const files = (...paths: string[]): ((p: string) => boolean) => {
  const set = new Set(paths)
  return (p) => set.has(p)
}

describe('project-local formatter and checker binaries', () => {
  const root = '/w/proj'

  it('looks in node_modules/.bin, then .venv and venv, then $VIRTUAL_ENV', () => {
    expect(projectBinDirs([root], { VIRTUAL_ENV: '/home/u/env' }, 'linux')).toEqual([
      join(root, 'node_modules', '.bin'),
      join(root, '.venv', 'bin'),
      join(root, 'venv', 'bin'),
      join('/home/u/env', 'bin')
    ])
    expect(projectBinDirs(['C:\\p'], {}, 'win32')).toEqual(['C:\\p\\node_modules\\.bin', 'C:\\p\\.venv\\Scripts', 'C:\\p\\venv\\Scripts'])
  })

  it('finds a project install, and nothing for a path-like name', () => {
    const exists = files(join(root, '.venv', 'bin', 'ruff'))
    expect(projectLocalBin('ruff', { roots: [root], env: {}, exists, platform: 'linux' })).toBe(join(root, '.venv', 'bin', 'ruff'))
    expect(projectLocalBin('../ruff', { roots: [root], env: {}, exists, platform: 'linux' })).toBeNull()
    expect(projectLocalBin('ruff', { roots: [], env: {}, exists, platform: 'linux' })).toBeNull()
  })

  it('runs the project copy by its path, ahead of PATH and of earlier candidates', () => {
    const ruff = { bin: 'ruff', args: (p: string) => ['format', p] }
    const black = { bin: 'black', args: (p: string) => ['-q', p] }
    // ruff is on PATH, but the project pins black in its venv.
    const exists = files('/usr/bin/ruff', join(root, '.venv', 'bin', 'black'))
    const plan = planToolRun([ruff, black], '/w/proj/a.py', {
      roots: [root],
      env: { PATH: '/usr/bin' },
      exists,
      platform: 'linux',
      shellSyntax: 'posix'
    })
    expect(plan?.tool.bin).toBe('black')
    expect(plan?.command).toBe(`'${join(root, '.venv', 'bin', 'black')}' '-q' '/w/proj/a.py'`)
  })

  it('uses the activated virtualenv when the project has none', () => {
    const exists = files('/home/u/env/bin/ruff')
    const plan = planToolRun([{ bin: 'ruff', args: (p: string) => ['check', p] }], '/w/a.py', {
      roots: [root],
      env: { VIRTUAL_ENV: '/home/u/env', PATH: '' },
      exists,
      platform: 'linux',
      shellSyntax: 'posix'
    })
    expect(plan?.command).toBe(`'/home/u/env/bin/ruff' 'check' '/w/a.py'`)
  })

  it('falls back to PATH by bare name, and canRunTool sees project installs', () => {
    const prettier = { bin: 'prettier', args: (p: string) => ['--write', p] }
    const opts = { roots: [root], env: { PATH: '/usr/bin' }, platform: 'linux' as const, shellSyntax: 'posix' as const }
    expect(planToolRun([prettier], '/w/a.ts', { ...opts, exists: files('/usr/bin/prettier') })?.command).toBe(
      `'prettier' '--write' '/w/a.ts'`
    )
    expect(canRunTool('prettier', { ...opts, env: { PATH: '' }, exists: files(join(root, 'node_modules', '.bin', 'prettier')) })).toBe(true)
  })
})

describe('pyright gets the project virtualenv', () => {
  const python = BUILTIN_SERVERS.find((s) => s.id === 'python')!
  const root = '/w/proj'
  const bin = (p: string): boolean => p.endsWith('pyright-langserver')

  it('finds .venv, then venv, then $VIRTUAL_ENV', () => {
    expect(projectPython([root], { env: {}, exists: files(join(root, 'venv', 'bin', 'python')), platform: 'linux' })).toBe(
      join(root, 'venv', 'bin', 'python')
    )
    expect(projectPython([root], { env: { VIRTUAL_ENV: '/e' }, exists: files('/e/bin/python'), platform: 'linux' })).toBe('/e/bin/python')
    expect(projectPython([root], { env: {}, exists: () => false, platform: 'linux' })).toBeNull()
  })

  it('sends python.pythonPath alongside the built-in analysis settings', () => {
    const exists = (p: string): boolean => bin(p) || p === join(root, '.venv', 'bin', 'python')
    const r = resolveServer(python, { roots: [root], env: { PATH: '/usr/bin' }, exists, platform: 'linux' })
    const settings = r?.spec.settings as { python: Record<string, unknown> }
    expect(settings.python.pythonPath).toBe(join(root, '.venv', 'bin', 'python'))
    expect(settings.python.analysis).toEqual((python.settings as { python: { analysis: unknown } }).python.analysis)
    // The registry entry itself is untouched.
    expect((python.settings as { python: Record<string, unknown> }).python.pythonPath).toBeUndefined()
  })

  it('leaves the settings alone with no virtualenv', () => {
    const r = resolveServer(python, { roots: [root], env: { PATH: '/usr/bin' }, exists: bin, platform: 'linux' })
    expect(r?.spec).toBe(python)
  })
})
