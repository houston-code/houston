import { describe, expect, it } from 'vitest'
import { isSecretEnvName, sanitizeChildEnv, stripUrlUserinfo } from './childEnv'

describe('isSecretEnvName', () => {
  it('flags credential-shaped names via the substring pattern (case-insensitive)', () => {
    for (const name of [
      'AWS_SECRET_ACCESS_KEY',
      'AWS_ACCESS_KEY_ID', // contains _KEY
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'NPM_TOKEN',
      'DB_PASSWORD',
      'MYSQL_PASSWD',
      'STRIPE_CREDENTIAL',
      'SOME_AUTH',
      'my_secret_value', // lowercase _secret
      'GITLAB_TOKEN'
    ]) {
      expect(isSecretEnvName(name), name).toBe(true)
    }
  })

  it.each([
    'GITHUB_PAT', // personal access token
    'AZURE_DEVOPS_PAT',
    'SMTP_PASS',
    'MAIL_PASS',
    'MYSQL_PWD',
    'GPG_PASSPHRASE',
    'SENDGRID_APIKEY', // APIKEY with no underscore
    'MAPBOXAPIKEY',
    'apikey',
    'SENTRY_DSN',
    'DATABASE_DSN',
    'DSN',
    'SESSION_COOKIE',
    'COOKIE_JAR',
    'AUTH0_COOKIE',
    'TWITCH_SESSION',
    'aws_session', // lowercase _session at the end
    'MY_SESSION_TOKEN'
  ])('flags credential-shaped %s', (name) => {
    expect(isSecretEnvName(name)).toBe(true)
  })

  it.each([
    // The suffixes are anchored so these ordinary names survive.
    'LD_LIBRARY_PATH',
    'PKG_CONFIG_PATH',
    'NODE_PATH',
    'MANPATH',
    'GIT_PASSTHROUGH_OPTS',
    'XDG_SESSION_TYPE',
    'XDG_SESSION_ID',
    'DBUS_SESSION_BUS_ADDRESS',
    'PWD',
    'OLDPWD',
    'DSN_TIMEOUT'
  ])('keeps %s (shares a suffix with a credential name, but is config)', (name) => {
    expect(isSecretEnvName(name)).toBe(false)
  })

  it('flags the AWS_ namespace and the explicit GitHub token names', () => {
    expect(isSecretEnvName('AWS_PROFILE')).toBe(true) // namespace-wide drop
    expect(isSecretEnvName('AWS_REGION')).toBe(true)
    expect(isSecretEnvName('GH_TOKEN')).toBe(true)
    expect(isSecretEnvName('GITHUB_TOKEN')).toBe(true)
  })

  it('keeps ordinary config and safe base vars', () => {
    for (const name of [
      'PATH',
      'HOME',
      'TMPDIR',
      'SHELL',
      'LANG',
      'LC_ALL',
      'LC_CTYPE',
      'NODE_ENV',
      'CI',
      'DATABASE_URL',
      'HTTP_PROXY',
      'TERM',
      'TZ',
      'npm_config_cache'
    ]) {
      expect(isSecretEnvName(name), name).toBe(false)
    }
  })

  it('keeps SSH_AUTH_SOCK: a socket path, not a leakable secret, needed for git-over-ssh', () => {
    // It matches the _AUTH substring, so the exception is what preserves it.
    expect(isSecretEnvName('SSH_AUTH_SOCK')).toBe(false)
  })
})

describe('stripUrlUserinfo', () => {
  it.each([
    ['postgres://user:pass@db.local:5432/app', 'postgres://db.local:5432/app'],
    ['redis://:hunter2@cache:6379/0', 'redis://cache:6379/0'],
    ['https://ghp_token@github.com/org/repo.git', 'https://github.com/org/repo.git'],
    ['mysql://u:p@ss@h/db', 'mysql://h/db'], // unescaped @ in the password: the last @ ends it
    ['postgres://u:p@h1,h2:5432/db?sslmode=require', 'postgres://h1,h2:5432/db?sslmode=require'],
    ['amqp://guest:guest@rabbit', 'amqp://rabbit']
  ])('cuts the userinfo out of %s', (input, output) => {
    expect(stripUrlUserinfo(input)).toBe(output)
  })

  it.each([
    'postgres://db.local/app',
    'https://registry.npmjs.org/@scope/pkg', // an @ in the path is not userinfo
    'http://h/?q=a@b',
    'not a url',
    '',
    'file:///tmp/x'
  ])('leaves %j unchanged', (value) => {
    expect(stripUrlUserinfo(value)).toBe(value)
  })
})

describe('sanitizeChildEnv', () => {
  it('keeps *_URL / *_URI vars but strips their userinfo', () => {
    const out = sanitizeChildEnv({
      DATABASE_URL: 'postgres://u:secret@db/app',
      AMQP_URI: 'amqp://guest:guest@rabbit',
      URL: 'https://tok@example.com/',
      NPM_REGISTRY_URL: 'https://registry.npmjs.org/'
    })
    expect(out.DATABASE_URL).toBe('postgres://db/app')
    expect(out.AMQP_URI).toBe('amqp://rabbit')
    expect(out.URL).toBe('https://example.com/')
    expect(out.NPM_REGISTRY_URL).toBe('https://registry.npmjs.org/')
    expect(JSON.stringify(out)).not.toContain('secret')
  })

  it('leaves a URL in a var not named like one alone (proxy credentials, say)', () => {
    expect(sanitizeChildEnv({ HTTP_PROXY: 'http://u:p@proxy:3128' }).HTTP_PROXY).toBe('http://u:p@proxy:3128')
  })

  it('strips a representative secret while keeping PATH/HOME and cache vars', () => {
    const out = sanitizeChildEnv({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      TMPDIR: '/tmp',
      npm_config_cache: '/tmp/houston-pkg-cache/npm',
      AWS_SECRET_ACCESS_KEY: 'AKIA-super-secret',
      GH_TOKEN: 'ghp_leakme',
      OPENAI_API_KEY: 'sk-leakme'
    })
    // Secrets gone.
    expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(out.GH_TOKEN).toBeUndefined()
    expect(out.OPENAI_API_KEY).toBeUndefined()
    // Safe vars survive.
    expect(out.PATH).toBe('/usr/bin')
    expect(out.HOME).toBe('/Users/me')
    expect(out.TMPDIR).toBe('/tmp')
    expect(out.npm_config_cache).toBe('/tmp/houston-pkg-cache/npm')
  })

  it('skips undefined entries so the result is a clean string map', () => {
    const out = sanitizeChildEnv({ PATH: '/usr/bin', UNSET: undefined })
    expect('UNSET' in out).toBe(false)
    expect(out.PATH).toBe('/usr/bin')
  })

  it('does not mutate the input env', () => {
    const input = { PATH: '/usr/bin', GH_TOKEN: 'secret' }
    sanitizeChildEnv(input)
    expect(input.GH_TOKEN).toBe('secret') // original untouched
  })
})
