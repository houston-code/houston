import { describe, expect, it } from 'vitest'
import { isSecretEnvName, sanitizeChildEnv } from './childEnv'

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

describe('sanitizeChildEnv', () => {
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
