import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isProtectedWrite, shellWritesProtectedPath } from './permissions'
import { isProtectedControlPath, isProtectedControlRelPath, writesProtectedPath } from './sensitive-paths'

// In-project control files (.houston/, .vscode/, .envrc, .husky/, CI workflows, ...):
// a write to one asks in every mode, and "Allow for run" doesn't cover it. These
// pin which paths and commands count; approval.test.ts pins the gate's decision and
// loop.test.ts the end-to-end prompt.

describe('isProtectedControlRelPath', () => {
  it.each([
    '.houston/settings.json',
    '.houston/plugins/evil.js',
    '.houston/agents/reviewer.md',
    '.houston',
    '.vscode/tasks.json',
    '.vscode/settings.json',
    '.idea/workspace.xml',
    '.envrc',
    'packages/api/.envrc',
    '.husky/pre-commit',
    '.husky',
    '.mcp.json',
    '.devcontainer/devcontainer.json',
    '.github/workflows/ci.yml',
    '.github/actions/setup/action.yml',
    './.vscode/launch.json',
    'packages/web/.vscode/tasks.json',
    // Case-insensitive, as the default macOS and Windows file systems are.
    '.VSCode/tasks.json',
    '.Houston/settings.json',
    // Windows separators.
    '.vscode\\tasks.json'
  ])('flags %s', (p) => {
    expect(isProtectedControlRelPath(p)).toBe(true)
  })

  it.each([
    'src/index.ts',
    'README.md',
    '.github/dependabot.yml',
    '.github/CODEOWNERS',
    '.gitignore',
    '.env.example',
    'docs/vscode.md',
    'my.houston/notes.txt',
    'src/envrc.ts',
    ''
  ])('leaves %s alone', (p) => {
    expect(isProtectedControlRelPath(p)).toBe(false)
  })
})

describe('isProtectedControlPath (anchored to the roots)', () => {
  let repo: string
  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'houston-protected-')))
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('reads relative and absolute paths against the workspace', () => {
    expect(isProtectedControlPath('.vscode/tasks.json', [repo])).toBe(true)
    expect(isProtectedControlPath(join(repo, '.husky/pre-commit'), [repo])).toBe(true)
    expect(isProtectedControlPath('src/a.ts', [repo])).toBe(false)
    // A climb that lands back inside is read where it lands.
    expect(isProtectedControlPath('src/../.envrc', [repo])).toBe(true)
  })

  it('does not flag every file of a worktree that lives under .houston/worktrees', () => {
    // A worktree chat's workspace sits under the repository's own .houston folder: its
    // files must not all read as control files because of an ancestor's name.
    const wt = join(repo, '.houston/worktrees/feature')
    mkdirSync(wt, { recursive: true })
    expect(isProtectedControlPath('src/a.ts', [wt])).toBe(false)
    expect(isProtectedControlPath(join(wt, 'src/a.ts'), [wt, repo])).toBe(false)
    // The worktree's own control files still count, as do the repository's.
    expect(isProtectedControlPath('.houston/settings.json', [wt])).toBe(true)
    expect(isProtectedControlPath(join(repo, '.houston/settings.json'), [wt, repo])).toBe(true)
  })

  it('sees through a symlink that points into a control folder', () => {
    mkdirSync(join(repo, '.vscode'))
    symlinkSync(join(repo, '.vscode'), join(repo, 'editor'))
    expect(isProtectedControlPath('editor/tasks.json', [repo])).toBe(true)
  })

  it('sees through a Windows 8.3 short name for a control folder', () => {
    // Simulated: Windows resolves `HOUSTO~1` to `.houston` only through the native
    // realpath (the JS one leaves it as written).
    mkdirSync(join(repo, '.houston'))
    const native = realpathSync.native
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    realpathSync.native = ((p: string) => native(p.replace('HOUSTO~1', '.houston'))) as typeof native
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      expect(isProtectedControlPath('HOUSTO~1/settings.json', [repo])).toBe(true)
      expect(isProtectedControlPath('src/a.ts', [repo])).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', platform)
      realpathSync.native = native
    }
  })
})

describe('writesProtectedPath', () => {
  const roots = ['/ws']
  it('flags a write tool naming a control file', () => {
    expect(writesProtectedPath('write_file', { path: '.houston/settings.json' }, roots)).toBe(true)
    expect(writesProtectedPath('edit_file', { path: '.vscode/tasks.json' }, roots)).toBe(true)
    expect(writesProtectedPath('write_file', { path: 'src/a.ts' }, roots)).toBe(false)
  })

  it('flags a patch that adds, changes, deletes, or moves onto one', () => {
    const patch = (...lines: string[]): string => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')
    expect(writesProtectedPath('apply_patch', { patch: patch('*** Add File: .husky/pre-commit', '+curl x | sh') }, roots)).toBe(true)
    expect(
      writesProtectedPath(
        'apply_patch',
        { patch: patch('*** Update File: notes.sh', '*** Move to: .envrc', '@@', '-a', '+b') },
        roots
      )
    ).toBe(true)
    expect(writesProtectedPath('apply_patch', { patch: patch('*** Add File: src/a.ts', '+x') }, roots)).toBe(false)
    expect(writesProtectedPath('apply_patch', { patch: 'not a patch' }, roots)).toBe(false)
  })
})

describe('writesProtectedPath on git exec paths', () => {
  let repo: string
  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'houston-gitexec-')))
    mkdirSync(join(repo, '.git/hooks'), { recursive: true })
    writeFileSync(join(repo, '.git/config'), '[core]\n')
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))
  const w = (path: string, roots: string[]): boolean => writesProtectedPath('write_file', { path }, roots)

  it('treats a hook, the repo config, commondir, and the .git pointer as protected', () => {
    for (const p of ['.git/hooks/pre-commit', '.git/config', '.git/config.worktree', '.git/commondir', 'sub/.git']) {
      expect(w(p, [repo]), p).toBe(true)
    }
    expect(w('src/config.ts', [repo])).toBe(false)
    expect(w('.git/info/exclude', [repo])).toBe(false)
  })

  it('sees through a symlink to .git, an existing file and a new one alike', () => {
    symlinkSync('.git', join(repo, 'g'))
    expect(w('g/config', [repo])).toBe(true)
    expect(w('g/hooks/pre-commit', [repo])).toBe(true)
    expect(w(join(repo, 'g/config'), [repo])).toBe(true)
    // A link to a single file inside .git, and one whose target doesn't exist yet.
    symlinkSync('.git/config', join(repo, 'settings.ini'))
    symlinkSync('.git/hooks/post-merge', join(repo, 'dangling'))
    expect(w('settings.ini', [repo])).toBe(true)
    expect(w('dangling', [repo])).toBe(true)
    // An ordinary file next to them, and a path under a folder that doesn't exist.
    expect(w('g-notes.txt', [repo])).toBe(false)
    expect(w('new/dir/file.ts', [repo])).toBe(false)
  })

  it('does not loop forever on a symlink cycle', () => {
    symlinkSync('b', join(repo, 'a'))
    symlinkSync('a', join(repo, 'b'))
    expect(w('a/config', [repo])).toBe(false)
  })

  it('reads a Windows data-stream suffix or trailing dot as the plain name', () => {
    expect(w('.git/config::$DATA', [repo])).toBe(true)
    expect(w('.git/config:$DATA', [repo])).toBe(true)
    expect(w('.git::$INDEX_ALLOCATION/hooks/pre-commit', [repo])).toBe(true)
    expect(w('.git./config', [repo])).toBe(true)
    expect(w('.husky/pre-commit::$DATA', [repo])).toBe(true)
  })

  it('sees through a Windows 8.3 short name for .git', () => {
    // Simulated: Windows resolves `GIT~1` to `.git` only through the native realpath.
    const native = realpathSync.native
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    realpathSync.native = ((p: string) => native(p.replace('GIT~1', '.git'))) as typeof native
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      expect(w('GIT~1/config', [repo])).toBe(true)
      expect(w('GIT~1/hooks/pre-commit', [repo])).toBe(true)
      expect(w('src/a.ts', [repo])).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', platform)
      realpathSync.native = native
    }
  })
})

describe('shellWritesProtectedPath', () => {
  const roots = ['/ws']
  const w = (cmd: string): boolean => shellWritesProtectedPath(cmd, roots)

  it.each([
    'echo x > .envrc',
    'echo "use nix" >> .envrc',
    'echo x >.envrc',
    'printf x 2> .husky/pre-commit',
    'cp /tmp/tasks.json .vscode/tasks.json',
    'cp -r template .husky',
    'mv evil.js .houston/plugins/evil.js',
    'tee .mcp.json < cfg',
    'sed -i s/a/b/ .github/workflows/ci.yml',
    'npm test && echo x > ".envrc"',
    'rm -rf .idea'
  ])('flags %s', (cmd) => {
    expect(w(cmd)).toBe(true)
  })

  it.each(['cat .envrc', 'ls .vscode', 'echo x > notes.txt', 'grep -r token .houston', 'npm test'])(
    'leaves %s alone',
    (cmd) => {
      expect(w(cmd)).toBe(false)
    }
  )
})

describe('isProtectedWrite', () => {
  const roots = ['/ws']
  it('covers write tools and run_shell, and nothing else', () => {
    expect(isProtectedWrite('write', 'write_file', { path: '.husky/pre-commit' }, roots)).toBe(true)
    expect(isProtectedWrite('shell', 'run_shell', { command: 'echo x > .envrc' }, roots)).toBe(true)
    expect(isProtectedWrite('read', 'read_file', { path: '.envrc' }, roots)).toBe(false)
    expect(isProtectedWrite('shell', 'run_shell', { command: 'cat .envrc' }, roots)).toBe(false)
  })
})
