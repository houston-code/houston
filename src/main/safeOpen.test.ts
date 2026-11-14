import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkOpenTarget, isLaunchType, openPathSafely, osExtension } from './safeOpen'

const posixOnly = process.platform === 'win32' ? it.skip : it

let root: string
beforeEach(() => {
  // realpath so macOS's /var -> /private/var link doesn't read as a symlinked target.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'houston-safeopen-')))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function put(rel: string, text = 'x', mode?: number): string {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, text)
  if (mode !== undefined) chmodSync(abs, mode)
  return abs
}

describe('osExtension and isLaunchType', () => {
  it('lowercases, and on Windows ignores trailing dots and spaces', () => {
    expect(osExtension('/a/Run.COMMAND', 'darwin')).toBe('.command')
    expect(osExtension('C:\\a\\run.exe. .', 'win32')).toBe('.exe')
    expect(osExtension('/a/run.exe.', 'linux')).toBe('.')
  })

  it('knows each platform launch types and leaves documents alone', () => {
    for (const n of ['x.app', 'x.command', 'x.tool', 'x.terminal', 'x.pkg', 'x.scpt', 'x.workflow', 'x.webloc', 'x.jar']) {
      expect(isLaunchType(n, 'darwin')).toBe(true)
    }
    for (const n of ['x.exe', 'x.bat', 'x.CMD', 'x.lnk', 'x.url', 'x.ps1', 'x.vbs', 'x.js', 'x.hta', 'x.msi', 'x.scr', 'x.cpl', 'x.exe.']) {
      expect(isLaunchType(n, 'win32')).toBe(true)
    }
    for (const n of ['x.desktop', 'x.sh']) expect(isLaunchType(n, 'linux')).toBe(true)
    for (const p of ['darwin', 'win32', 'linux'] as const) {
      for (const n of ['x.md', 'x.ts', 'x.png', 'x.txt', 'Makefile']) expect(isLaunchType(n, p)).toBe(false)
    }
    // A .js file is a document on macOS and Linux, a script host target on Windows.
    expect(isLaunchType('x.js', 'darwin')).toBe(false)
  })
})

describe('checkOpenTarget', () => {
  it('opens a plain document by its real path', () => {
    const f = put('a.txt')
    expect(checkOpenTarget(f, { platform: 'darwin' })).toEqual({ action: 'open', path: f })
  })

  posixOnly('refuses a .md link to a .command (macOS would launch it in Terminal)', () => {
    put('run.command', '#!/bin/sh\necho pwned\n')
    symlinkSync(join(root, 'run.command'), join(root, 'notes.md'))
    for (const opts of [{ platform: 'darwin' as const }, { platform: 'darwin' as const, markdownOnly: true }]) {
      const c = checkOpenTarget(join(root, 'notes.md'), opts)
      expect(c.action).toBe('refuse')
    }
  })

  posixOnly('opens a same-type link by its target, never the link', () => {
    const target = put('docs/real.md')
    symlinkSync(target, join(root, 'alias.md'))
    expect(checkOpenTarget(join(root, 'alias.md'), { platform: 'darwin' })).toEqual({ action: 'open', path: target })
  })

  it('shows a launchable file in its folder instead of opening it', () => {
    const f = put('run.command')
    const c = checkOpenTarget(f, { platform: 'darwin' })
    expect(c).toMatchObject({ action: 'reveal', path: f })
    expect(checkOpenTarget(put('setup.exe'), { platform: 'win32' }).action).toBe('reveal')
    expect(checkOpenTarget(put('app.desktop'), { platform: 'linux' }).action).toBe('reveal')
  })

  posixOnly('shows an executable file in its folder (macOS runs it in Terminal)', () => {
    const f = put('tool', '#!/bin/sh\n', 0o755)
    expect(checkOpenTarget(f, { platform: 'darwin' }).action).toBe('reveal')
    expect(checkOpenTarget(f, { platform: 'linux' }).action).toBe('reveal')
  })

  it('refuses a folder, and an app bundle folder', () => {
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'Evil.app'))
    expect(checkOpenTarget(join(root, 'src'), { platform: 'darwin' }).action).toBe('refuse')
    expect(checkOpenTarget(join(root, 'Evil.app'), { platform: 'darwin' }).action).toBe('refuse')
  })

  it('in folder mode opens a plain folder but only reveals a bundle', () => {
    mkdirSync(join(root, 'logs'))
    mkdirSync(join(root, 'Evil.app'))
    expect(checkOpenTarget(join(root, 'logs'), { folder: true, platform: 'darwin' }).action).toBe('open')
    expect(checkOpenTarget(join(root, 'Evil.app'), { folder: true, platform: 'darwin' }).action).toBe('reveal')
    expect(checkOpenTarget(put('f.txt'), { folder: true }).action).toBe('refuse')
  })

  it('refuses a missing file, a dangling link and a relative path', () => {
    expect(checkOpenTarget(join(root, 'gone.md')).action).toBe('refuse')
    expect(checkOpenTarget('a.md').action).toBe('refuse')
    expect(checkOpenTarget('').action).toBe('refuse')
  })

  posixOnly('refuses a dangling link', () => {
    symlinkSync(join(root, 'nowhere.md'), join(root, 'dangling.md'))
    expect(checkOpenTarget(join(root, 'dangling.md')).action).toBe('refuse')
  })

  it('markdownOnly refuses anything but a regular .md file', () => {
    expect(checkOpenTarget(put('a.md'), { markdownOnly: true, platform: 'darwin' }).action).toBe('open')
    expect(checkOpenTarget(put('a.txt'), { markdownOnly: true, platform: 'darwin' }).action).toBe('refuse')
    expect(checkOpenTarget(put('run.command'), { markdownOnly: true, platform: 'darwin' }).action).toBe('refuse')
  })

  posixOnly('markdownOnly refuses an executable .md', () => {
    expect(checkOpenTarget(put('x.md', 'x', 0o755), { markdownOnly: true, platform: 'darwin' }).action).toBe('refuse')
  })

  posixOnly('within refuses a file whose real path leaves the folder', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'houston-safeopen-out-')))
    try {
      writeFileSync(join(outside, 'x.md'), 'x')
      symlinkSync(join(outside, 'x.md'), join(root, 'x.md'))
      expect(checkOpenTarget(join(root, 'x.md'), { within: root }).action).toBe('refuse')
      expect(checkOpenTarget(join(root, 'x.md')).action).toBe('open')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('openPathSafely', () => {
  posixOnly('never calls the opener for a .md -> .command link', async () => {
    put('b.command')
    symlinkSync(join(root, 'b.command'), join(root, 'a.md'))
    const open = vi.fn(async () => '')
    const reveal = vi.fn()
    const r = await openPathSafely(join(root, 'a.md'), { open, reveal }, { platform: 'darwin' })
    expect(r.ok).toBe(false)
    expect(open).not.toHaveBeenCalled()
    expect(reveal).not.toHaveBeenCalled()
  })

  it('reveals a launchable file instead of opening it', async () => {
    const f = put('b.command')
    const open = vi.fn(async () => '')
    const reveal = vi.fn()
    const r = await openPathSafely(f, { open, reveal }, { platform: 'darwin' })
    expect(r).toEqual({ ok: false, error: expect.stringContaining('showed it in its folder') })
    expect(open).not.toHaveBeenCalled()
    expect(reveal).toHaveBeenCalledWith(f)
  })

  it('opens a document and reports an opener failure', async () => {
    const f = put('a.md')
    const open = vi.fn(async () => '')
    expect(await openPathSafely(f, { open })).toEqual({ ok: true })
    expect(open).toHaveBeenCalledWith(f)
    open.mockResolvedValueOnce('No app')
    expect(await openPathSafely(f, { open })).toEqual({ ok: false, error: 'No app' })
  })
})
