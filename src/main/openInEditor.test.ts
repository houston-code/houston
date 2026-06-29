import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EDITORS } from '@shared/editors'

// Hoisted mocks for the side-effecting deps the module pulls in. The pure logic
// (detectEditors with injected deps, planEditorLaunch) needs none of these, but
// importing the module evaluates them.
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
const { showItemInFolder } = vi.hoisted(() => ({ showItemInFolder: vi.fn() }))
const { resolveBinaryPath } = vi.hoisted(() => ({ resolveBinaryPath: vi.fn<(b: string) => string | null>() }))
vi.mock('node:child_process', () => ({ spawn }))
vi.mock('electron', () => ({ shell: { showItemInFolder } }))
vi.mock('./logger', () => ({ log: { warn: vi.fn() } }))
vi.mock('./agent/format', () => ({ resolveBinaryPath }))

import {
  detectEditors,
  planEditorLaunch,
  openProjectInEditor,
  revealInFileManager
} from './openInEditor'

const code = EDITORS.find((e) => e.id === 'vscode')!

beforeEach(() => {
  vi.clearAllMocks()
  resolveBinaryPath.mockReturnValue(null)
  spawn.mockReturnValue({ on: vi.fn(), unref: vi.fn() })
})

describe('detectEditors', () => {
  it('marks an editor available when its CLI resolves', () => {
    const res = detectEditors({
      platform: 'linux',
      resolveBin: (b) => (b === 'code' ? '/usr/bin/code' : null),
      exists: () => false
    })
    expect(res.find((e) => e.id === 'vscode')!.available).toBe(true)
    expect(res.find((e) => e.id === 'zed')!.available).toBe(false)
  })

  it('falls back to the macOS .app bundle when the CLI is missing', () => {
    const res = detectEditors({
      platform: 'darwin',
      resolveBin: () => null,
      exists: (p) => p === '/Applications/Cursor.app'
    })
    expect(res.find((e) => e.id === 'cursor')!.available).toBe(true)
    expect(res.find((e) => e.id === 'vscode')!.available).toBe(false)
  })

  it('does not use the .app fallback off macOS', () => {
    const res = detectEditors({ platform: 'win32', resolveBin: () => null, exists: () => true })
    expect(res.every((e) => !e.available)).toBe(true)
  })

  it('offers Xcode on macOS when its CLI or app is present', () => {
    const viaApp = detectEditors({
      platform: 'darwin',
      resolveBin: () => null,
      exists: (p) => p === '/Applications/Xcode.app'
    })
    expect(viaApp.find((e) => e.id === 'xcode')!.available).toBe(true)
  })

  it('never offers Xcode off macOS, even if its `xed` name resolves (Linux collision)', () => {
    const res = detectEditors({
      platform: 'linux',
      resolveBin: (b) => (b === 'xed' ? '/usr/bin/xed' : null), // the Linux Mint editor
      exists: () => false
    })
    expect(res.find((e) => e.id === 'xcode')!.available).toBe(false)
  })
})

describe('planEditorLaunch', () => {
  it('launches by exact app name on macOS when the .app is present', () => {
    // Even with a `code` CLI on PATH — which a VS Code fork (Cursor) can shadow —
    // the app-name launch wins, so "Open in VS Code" can't open the wrong editor.
    expect(planEditorLaunch(code, '/proj', 'darwin', '/usr/local/bin/code', true)).toEqual({
      cmd: 'open',
      args: ['-a', 'Visual Studio Code', '/proj']
    })
  })

  it('uses the resolved CLI on macOS when no .app is installed', () => {
    expect(planEditorLaunch(code, '/proj', 'darwin', '/usr/local/bin/code', false)).toEqual({
      cmd: '/usr/local/bin/code',
      args: ['/proj']
    })
  })

  it('uses the resolved CLI off macOS (no app-name launch)', () => {
    expect(planEditorLaunch(code, '/proj', 'linux', '/usr/bin/code', false)).toEqual({
      cmd: '/usr/bin/code',
      args: ['/proj']
    })
  })

  it('returns null when neither the CLI nor the app is available', () => {
    expect(planEditorLaunch(code, '/proj', 'linux', null, false)).toBeNull()
    expect(planEditorLaunch(code, '/proj', 'darwin', null, false)).toBeNull()
  })
})

describe('openProjectInEditor', () => {
  it('rejects an unknown editor id', () => {
    expect(openProjectInEditor('emacs', process.cwd()).ok).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects a relative or missing directory without spawning', () => {
    expect(openProjectInEditor('vscode', 'relative/path').ok).toBe(false)
    expect(openProjectInEditor('vscode', '/no/such/dir/xyz123').ok).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('spawns the resolved CLI with the directory (argv array, never a shell)', () => {
    // Off macOS the CLI is the only launch path; inject platform so the assertion
    // is deterministic regardless of where the test runs.
    resolveBinaryPath.mockReturnValue('/usr/local/bin/code')
    const res = openProjectInEditor('vscode', process.cwd(), { platform: 'linux' })
    expect(res.ok).toBe(true)
    expect(spawn).toHaveBeenCalledWith(
      '/usr/local/bin/code',
      [process.cwd()],
      expect.objectContaining({ detached: true })
    )
  })

  it('on macOS launches the .app by name, not a shadowing `code` CLI (Cursor hijack)', () => {
    // A `code` on PATH that actually belongs to a fork would otherwise open it;
    // with the .app present we launch VS Code by name instead.
    resolveBinaryPath.mockReturnValue('/usr/local/bin/code')
    const res = openProjectInEditor('vscode', process.cwd(), {
      platform: 'darwin',
      exists: (p) => p === process.cwd() || p === '/Applications/Visual Studio Code.app'
    })
    expect(res.ok).toBe(true)
    expect(spawn).toHaveBeenCalledWith(
      'open',
      ['-a', 'Visual Studio Code', process.cwd()],
      expect.objectContaining({ detached: true })
    )
  })
})

describe('revealInFileManager', () => {
  it('reveals an existing directory', () => {
    expect(revealInFileManager(process.cwd()).ok).toBe(true)
    expect(showItemInFolder).toHaveBeenCalledWith(process.cwd())
  })

  it('rejects a missing path without revealing', () => {
    expect(revealInFileManager('/no/such/dir/xyz123').ok).toBe(false)
    expect(showItemInFolder).not.toHaveBeenCalled()
  })
})
