import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isGitExecPath,
  isGitExecPathAt,
  isSensitivePath,
  isSensitivePathAt,
  isSensitiveRead,
  writesSensitivePath
} from './sensitive-paths'

describe('isSensitivePath', () => {
  it('flags dotenv files', () => {
    expect(isSensitivePath('.env')).toBe(true)
    expect(isSensitivePath('config/.env')).toBe(true)
    expect(isSensitivePath('.env.local')).toBe(true)
    expect(isSensitivePath('.env.production')).toBe(true)
    expect(isSensitivePath('apps/web/.env.staging')).toBe(true)
  })

  it('does not flag dotenv templates', () => {
    expect(isSensitivePath('.env.example')).toBe(false)
    expect(isSensitivePath('.env.sample')).toBe(false)
    expect(isSensitivePath('.env.template')).toBe(false)
    expect(isSensitivePath('.env.dist')).toBe(false)
  })

  it('flags SSH private keys but not public keys or config', () => {
    expect(isSensitivePath('.ssh/id_rsa')).toBe(true)
    expect(isSensitivePath('id_ed25519')).toBe(true)
    expect(isSensitivePath('secrets/.ssh/deploy_key')).toBe(true)
    expect(isSensitivePath('.ssh/id_rsa.pub')).toBe(false)
    expect(isSensitivePath('.ssh/known_hosts')).toBe(false)
    expect(isSensitivePath('.ssh/config')).toBe(false)
    expect(isSensitivePath('.ssh/authorized_keys')).toBe(false)
  })

  it('flags key/cert material by extension', () => {
    expect(isSensitivePath('certs/server.pem')).toBe(true)
    expect(isSensitivePath('tls/private.key')).toBe(true)
    expect(isSensitivePath('bundle.p12')).toBe(true)
    expect(isSensitivePath('a/b/keystore.jks')).toBe(true)
  })

  it('flags known credential stores by basename', () => {
    expect(isSensitivePath('.netrc')).toBe(true)
    expect(isSensitivePath('.git-credentials')).toBe(true)
    expect(isSensitivePath('.npmrc')).toBe(true)
    expect(isSensitivePath('.pypirc')).toBe(true)
    expect(isSensitivePath('credentials.json')).toBe(true)
    expect(isSensitivePath('deploy/service-account.json')).toBe(true)
  })

  it('flags cloud credential files only in their expected directory', () => {
    expect(isSensitivePath('.aws/credentials')).toBe(true)
    expect(isSensitivePath('home/.kube/config')).toBe(true)
    expect(isSensitivePath('.docker/config.json')).toBe(true)
    expect(isSensitivePath('gcloud/application_default_credentials.json')).toBe(true)
    // A source file named `credentials` outside .aws/ is not a cloud cred store.
    expect(isSensitivePath('src/credentials.ts')).toBe(false)
    expect(isSensitivePath('lib/config')).toBe(false)
  })

  it('handles Windows-style backslash separators', () => {
    expect(isSensitivePath('project\\.env')).toBe(true)
    expect(isSensitivePath('users\\me\\.ssh\\id_rsa')).toBe(true)
  })

  it('does not flag ordinary source files', () => {
    expect(isSensitivePath('src/index.ts')).toBe(false)
    expect(isSensitivePath('README.md')).toBe(false)
    expect(isSensitivePath('package.json')).toBe(false)
    expect(isSensitivePath('env.ts')).toBe(false)
    expect(isSensitivePath('environment.ts')).toBe(false)
    expect(isSensitivePath('')).toBe(false)
  })
})

describe('isSensitiveRead', () => {
  it('flags a read-kind call whose path is a credential file', () => {
    expect(isSensitiveRead('read', { path: '.env' }, [])).toBe(true)
    expect(isSensitiveRead('read', { path: 'keys/server.pem', pattern: 'BEGIN' }, [])).toBe(true)
  })

  it('ignores ordinary paths, non-string paths, and non-read kinds', () => {
    expect(isSensitiveRead('read', { path: 'src/index.ts' }, [])).toBe(false)
    expect(isSensitiveRead('read', { path: ['.env'] }, [])).toBe(false)
    expect(isSensitiveRead('read', {}, [])).toBe(false)
    // A write to .env is gated by the write path's own approval, not this check.
    expect(isSensitiveRead('write', { path: '.env' }, [])).toBe(false)
  })

  it('checks every entry of a show_images call', () => {
    expect(isSensitiveRead('read', { images: [{ path: 'shots/a.png' }, { path: '.ssh/id_ed25519' }] }, [])).toBe(true)
    expect(isSensitiveRead('read', { images: [{ path: 'shots/a.png' }, { path: 'shots/b.png' }] }, [])).toBe(false)
    expect(isSensitiveRead('read', { images: [null, 'x', { path: 7 }] }, [])).toBe(false)
    expect(isSensitiveRead('read', { images: 'not-an-array' }, [])).toBe(false)
    expect(isSensitiveRead('read', { images: [{ path: 'a.png', compareWith: 'certs/server.key' }] }, [])).toBe(true)
  })
})

describe('writesSensitivePath', () => {
  it('checks the path of the single-file write tools', () => {
    expect(writesSensitivePath('write_file', { path: '.env', content: 'A=1' }, [])).toBe(true)
    expect(writesSensitivePath('edit_file', { path: 'apps/api/.env.local' }, [])).toBe(true)
    expect(writesSensitivePath('write_file', { path: '.env.example', content: 'A=' }, [])).toBe(false)
    expect(writesSensitivePath('write_file', { path: 'src/env.ts' }, [])).toBe(false)
  })

  it('checks every path an apply_patch touches, including a move target', () => {
    const add = '*** Begin Patch\n*** Add File: .env\n+A=1\n*** End Patch'
    const move = '*** Begin Patch\n*** Update File: tmp.txt\n*** Move to: .env\n@@\n-a\n+b\n*** End Patch'
    const del = '*** Begin Patch\n*** Delete File: certs/server.key\n*** End Patch'
    const plain = '*** Begin Patch\n*** Add File: README.md\n+hi\n*** End Patch'
    expect(writesSensitivePath('apply_patch', { patch: add }, [])).toBe(true)
    expect(writesSensitivePath('apply_patch', { patch: move }, [])).toBe(true)
    expect(writesSensitivePath('apply_patch', { patch: del }, [])).toBe(true)
    expect(writesSensitivePath('apply_patch', { patch: plain }, [])).toBe(false)
    expect(writesSensitivePath('apply_patch', { patch: 'not a patch' }, [])).toBe(false)
  })
})

describe('isGitExecPath', () => {
  it('flags hooks, config, commondir, and the .git pointer file', () => {
    expect(isGitExecPath('.git/hooks/pre-commit')).toBe(true)
    expect(isGitExecPath('./.git/hooks/post-checkout')).toBe(true)
    expect(isGitExecPath('/repo/.git/config')).toBe(true)
    expect(isGitExecPath('.git/config.worktree')).toBe(true)
    expect(isGitExecPath('.git/commondir')).toBe(true)
    expect(isGitExecPath('sub/.git')).toBe(true)
    expect(isGitExecPath('.GIT/Hooks/pre-push')).toBe(true)
    expect(isGitExecPath('C:\\repo\\.git\\hooks\\pre-commit')).toBe(true)
  })

  it('flags submodule and linked-worktree git dirs', () => {
    expect(isGitExecPath('.git/modules/lib/config')).toBe(true)
    expect(isGitExecPath('.git/modules/lib/hooks/pre-commit')).toBe(true)
    expect(isGitExecPath('.git/worktrees/feat/commondir')).toBe(true)
    expect(isGitExecPath('.git/worktrees/feat/config.worktree')).toBe(true)
  })

  it('leaves ordinary files alone, inside and outside .git', () => {
    expect(isGitExecPath('config')).toBe(false)
    expect(isGitExecPath('src/hooks/useThing.ts')).toBe(false)
    expect(isGitExecPath('.husky/pre-commit')).toBe(false)
    expect(isGitExecPath('.gitignore')).toBe(false)
    expect(isGitExecPath('.github/workflows/ci.yml')).toBe(false)
    expect(isGitExecPath('.git/info/exclude')).toBe(false)
    expect(isGitExecPath('.git/COMMIT_EDITMSG')).toBe(false)
    expect(isGitExecPath('')).toBe(false)
  })
})

describe('writesSensitivePath on git exec paths', () => {
  it('prompts for a file-tool write to a hook or the repo config', () => {
    expect(writesSensitivePath('write_file', { path: '.git/hooks/pre-commit' }, [])).toBe(true)
    expect(writesSensitivePath('edit_file', { path: '.git/config' }, [])).toBe(true)
    expect(writesSensitivePath('write_file', { path: 'src/config.ts' }, [])).toBe(false)
  })

  it('checks every apply_patch target, a move destination included', () => {
    const add = '*** Begin Patch\n*** Add File: .git/hooks/post-merge\n+#!/bin/sh\n*** End Patch'
    expect(writesSensitivePath('apply_patch', { patch: add }, [])).toBe(true)
    const move =
      '*** Begin Patch\n*** Update File: notes.txt\n*** Move to: .git/commondir\n@@\n-a\n+b\n*** End Patch'
    expect(writesSensitivePath('apply_patch', { patch: move }, [])).toBe(true)
  })
})

describe('credential and git exec paths at their real location', () => {
  let repo: string
  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'houston-sensitive-')))
    writeFileSync(join(repo, '.env'), 'A=1\n')
    mkdirSync(join(repo, '.git'))
    writeFileSync(join(repo, '.git/config'), '[core]\n')
    writeFileSync(join(repo, 'plain.txt'), 'x\n')
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('flags a read through a symlink to .env, a file or a folder link alike', () => {
    symlinkSync('.env', join(repo, 'notes.txt'))
    mkdirSync(join(repo, 'keys'))
    writeFileSync(join(repo, 'keys/server.pem'), 'k')
    symlinkSync('keys', join(repo, 'stuff'))
    expect(isSensitiveRead('read', { path: 'notes.txt' }, [repo])).toBe(true)
    expect(isSensitiveRead('read', { path: join(repo, 'notes.txt') }, [repo])).toBe(true)
    expect(isSensitiveRead('read', { path: 'stuff/server.pem' }, [repo])).toBe(true)
    expect(isSensitiveRead('read', { images: [{ path: 'notes.txt' }] }, [repo])).toBe(true)
    expect(isSensitiveRead('read', { path: 'plain.txt' }, [repo])).toBe(false)
  })

  it('flags a write through a symlink to .env or into .git, a dangling one included', () => {
    symlinkSync('.env', join(repo, 'notes.txt'))
    symlinkSync('.env.production', join(repo, 'later.txt'))
    symlinkSync('.git', join(repo, 'g'))
    expect(writesSensitivePath('write_file', { path: 'notes.txt' }, [repo])).toBe(true)
    expect(writesSensitivePath('write_file', { path: 'later.txt' }, [repo])).toBe(true)
    expect(writesSensitivePath('edit_file', { path: 'g/config' }, [repo])).toBe(true)
    expect(isGitExecPathAt('g/config', [repo])).toBe(true)
    expect(isSensitivePathAt('notes.txt', [repo])).toBe(true)
  })

  it('leaves ordinary and not-yet-existing workspace files alone', () => {
    expect(isSensitivePathAt('plain.txt', [repo])).toBe(false)
    expect(isSensitivePathAt('new/dir/file.ts', [repo])).toBe(false)
    expect(isGitExecPathAt('src/config', [repo])).toBe(false)
    expect(writesSensitivePath('write_file', { path: 'new.txt' }, [repo])).toBe(false)
  })

  it('does not flag every file of a workspace whose ancestor has a sensitive name', () => {
    const ws = join(repo, '.ssh', 'proj')
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, 'readme.md'), 'x')
    expect(isSensitivePathAt('readme.md', [ws])).toBe(false)
  })

  it('reads a Windows stream suffix or trailing dot as the plain name', () => {
    expect(isSensitivePathAt('.env::$DATA', [repo])).toBe(true)
    expect(isSensitivePathAt('server.pem.', [repo])).toBe(true)
    expect(isGitExecPathAt('.git\\config::$DATA', [repo])).toBe(true)
    expect(isGitExecPathAt('.git/config:$DATA', [repo])).toBe(true)
  })
})
