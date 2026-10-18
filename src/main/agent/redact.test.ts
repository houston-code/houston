import { describe, it, expect } from 'vitest'
import { assertNoRedactedValues, createSecretRedactor, findSecret, redactSecrets } from './redact'

// Built at runtime, like every other fixture here: as literals these match real
// credential shapes, so third-party secret scanners flag this file in any clone.
const AWS_KEY_ID = 'AKIA' + 'IOSFODNN7EXAMPLE'
const AWS_TEMP_KEY_ID = 'ASIA' + 'IOSFODNN7EXAMPLE'
const AWS_STS_KEY_ID = 'ASIA' + 'Y34FZKBOKMUTVV7A'
const PEM_BEGIN = '-----BEGIN RSA PRIVATE' + ' KEY-----'
const PEM_END = '-----END RSA PRIVATE' + ' KEY-----'

describe('pattern redaction', () => {
  it('redacts an Anthropic key with its own label (before the looser openai rule)', () => {
    const key = 'sk-ant-api03-' + 'A'.repeat(80)
    expect(redactSecrets(`key=${key} done`)).toBe('key=[redacted:anthropic-key] done')
  })

  it('redacts classic and project OpenAI keys', () => {
    expect(redactSecrets('sk-' + 'a'.repeat(48))).toBe('[redacted:openai-key]')
    expect(redactSecrets('sk-proj-' + 'b'.repeat(40))).toBe('[redacted:openai-key]')
  })

  it('redacts the GitHub token family and fine-grained PATs', () => {
    expect(redactSecrets('ghp_' + 'A'.repeat(36))).toBe('[redacted:github-token]')
    expect(redactSecrets('gho_' + 'B'.repeat(36))).toBe('[redacted:github-token]')
    expect(redactSecrets('github_pat_' + 'C'.repeat(30))).toBe('[redacted:github-token]')
  })

  it('redacts AWS access key ids, Google keys, and Slack tokens', () => {
    expect(redactSecrets(AWS_KEY_ID)).toBe('[redacted:aws-access-key-id]')
    expect(redactSecrets('AIza' + 'x'.repeat(35))).toBe('[redacted:google-api-key]')
    expect(redactSecrets('xoxb-' + '1'.repeat(20))).toBe('[redacted:slack-token]')
  })

  it('redacts AWS temporary access key ids (SSO / IAM role / STS), not just long-lived ones', () => {
    expect(redactSecrets(AWS_TEMP_KEY_ID)).toBe('[redacted:aws-access-key-id]')
    expect(redactSecrets(`AWS_ACCESS_KEY_ID=${AWS_STS_KEY_ID}`)).toBe(
      'AWS_ACCESS_KEY_ID=[redacted:aws-access-key-id]'
    )
  })

  it('redacts the Google OAuth tokens gcloud writes to application_default_credentials.json', () => {
    const adc = JSON.stringify({
      client_id: '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com',
      refresh_token: '1//0eXAMPLE-refresh-token-value_abcdefghijklmnop',
      type: 'authorized_user'
    })
    expect(redactSecrets(adc)).toContain('[redacted:google-oauth-token]')
    expect(redactSecrets(adc)).not.toContain('1//0eXAMPLE')
    expect(redactSecrets('Authorization: Bearer ya29.' + 'a'.repeat(60))).toBe(
      'Authorization: Bearer [redacted:google-oauth-token]'
    )
  })

  it('does not mistake a doubled slash in a URL path for a Google refresh token', () => {
    const url = 'https://api.example.com/v1//projects-long-identifier-segment'
    expect(redactSecrets(url)).toBe(url)
  })

  it('does not mistake capitalized prose for an AWS temporary key id', () => {
    const prose = 'The ASIA_PACIFIC and ASIA-PACIFIC regions failed over; see ASIAPACIFIC docs.'
    expect(redactSecrets(prose)).toBe(prose)
  })

  it('redacts a whole PEM private-key block, payload included', () => {
    const pem = `${PEM_BEGIN}\nMIIEpAIBAAKCAQEA\nabc/def+ghi=\n${PEM_END}`
    expect(redactSecrets(`before\n${pem}\nafter`)).toBe('before\n[redacted:private-key]\nafter')
  })

  it('leaves ordinary prose untouched (no entropy guessing)', () => {
    const prose = 'The function sk_returns a value; see AKIA_PREFIX in the docs.'
    expect(redactSecrets(prose)).toBe(prose)
  })

  it('does not mistake hyphenated code for an OpenAI key', () => {
    const css = '.sk-loading-spinner-animation-delay { animation-delay: 0.2s; }'
    expect(redactSecrets(css)).toBe(css)
  })
})

describe('secret-named env assignments', () => {
  it('masks the values cat .env prints, keeping names, other vars, and comments', () => {
    const env = [
      'ADMIN_PASSWORD=testpass',
      'SESSION_SECRET=6b37636167dc8a5726e48166a2533d930ecf',
      'PORT=3000',
      'NODE_ENV=development',
      'STRIPE_API_KEY="pk with spaces"',
      "db_password='quoted' # local only"
    ].join('\n')
    expect(redactSecrets(env)).toBe(
      [
        'ADMIN_PASSWORD=[redacted:env-secret]',
        'SESSION_SECRET=[redacted:env-secret]',
        'PORT=3000',
        'NODE_ENV=development',
        'STRIPE_API_KEY=[redacted:env-secret]',
        'db_password=[redacted:env-secret] # local only'
      ].join('\n')
    )
  })

  it('covers export lines, env/printenv output, and grep -n prefixes', () => {
    expect(redactSecrets('export GITHUB_TOKEN=abc123def')).toBe('export GITHUB_TOKEN=[redacted:env-secret]')
    expect(redactSecrets('.env:2:JWT_SECRET=s3cr3t')).toBe('.env:2:JWT_SECRET=[redacted:env-secret]')
    expect(redactSecrets('12:AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI')).toBe(
      '12:AWS_SECRET_ACCESS_KEY=[redacted:env-secret]'
    )
  })

  it('keeps the format label when a value also matches a known token format', () => {
    const key = 'sk-ant-' + 'a'.repeat(30)
    expect(redactSecrets(`ANTHROPIC_API_KEY=${key}`)).toBe('ANTHROPIC_API_KEY=[redacted:anthropic-key]')
  })

  it('leaves non-secret names, references, empty values, and code alone', () => {
    for (const line of [
      'OAUTH_TOKEN_URL=https://example.com/token',
      'JWT_SECRET_FILE=/run/secrets/jwt',
      'TOKEN_TTL=3600',
      'PASSWORD=',
      'API_KEY=$UPSTREAM_KEY',
      'export GITHUB_TOKEN="${GH_TOKEN}"',
      'TOKEN=get_token()',
      'token = get_token()',
      'const API_KEY = process.env.API_KEY',
      'AUTHOR=Jane'
    ]) {
      expect(redactSecrets(line)).toBe(line)
    }
  })

  it('stays linear on megabyte-long lines (tool output can carry them)', () => {
    const inputs = [
      'API_TOKEN=a' + ' '.repeat(1_000_000) + 'b',
      'API_TOKEN=a' + ' \t'.repeat(500_000),
      'x'.repeat(1_000_000) + '=1',
      'SECRET_' + 'X'.repeat(1_000_000) + '=v',
      'a:'.repeat(500_000) + 'TOKEN=v',
      'API_TOKEN=' + 'a #'.repeat(330_000),
      'x y'.repeat(330_000) + ' API_TOKEN=v',
      'SESSION_SECRET=abc\n'.repeat(50_000)
    ]
    const started = Date.now()
    for (const text of inputs) redactSecrets(text)
    // A backtracking regression takes minutes here; the linear parser takes well under a second.
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it('is applied by the reusable redactor too', () => {
    expect(createSecretRedactor([])('SESSION_SECRET=abc')).toBe('SESSION_SECRET=[redacted:env-secret]')
  })
})

describe('assertNoRedactedValues', () => {
  it('throws when a write adds a marker in a value position', () => {
    expect(() => assertNoRedactedValues('A=1\n', 'A=1\nSECRET=[redacted:env-secret]\n')).toThrow(/placeholder/)
    expect(() => assertNoRedactedValues('{}', '{"token": "[redacted:github-token]"}')).toThrow()
  })

  it('allows writes that keep or drop existing markers, and code that only mentions one', () => {
    expect(() => assertNoRedactedValues('S=[redacted:env-secret]', 'S=[redacted:env-secret]\nB=2')).not.toThrow()
    expect(() => assertNoRedactedValues('S=[redacted:env-secret]', 'S=real')).not.toThrow()
    expect(() => assertNoRedactedValues('', "toBe('[redacted:secret]')")).not.toThrow()
  })
})

describe('known-value redaction', () => {
  it('redacts an exact stored secret regardless of shape', () => {
    const secret = 'totally-opaque-bearer-value-1234'
    expect(redactSecrets(`Authorization: Bearer ${secret}`, [secret])).toBe(
      'Authorization: Bearer [redacted:secret]'
    )
  })

  it('replaces every occurrence', () => {
    expect(redactSecrets('a SEKRET-VALUE-1 then SEKRET-VALUE-1', ['SEKRET-VALUE-1'])).toBe(
      'a [redacted:secret] then [redacted:secret]'
    )
  })

  it('matches longest-first so a shorter secret cannot fragment a longer one', () => {
    // 'abcd1234' is a substring of 'abcd1234efgh5678'; longest-first keeps the long one whole.
    const out = redactSecrets('token abcd1234efgh5678 here', ['abcd1234', 'abcd1234efgh5678'])
    expect(out).toBe('token [redacted:secret] here')
  })

  it('ignores too-short known values to avoid clobbering incidental collisions', () => {
    expect(redactSecrets('the cat sat', ['cat'])).toBe('the cat sat')
  })

  it('prefers the pattern label when a known value also matches a format', () => {
    const key = 'sk-ant-api03-' + 'Z'.repeat(60)
    // Patterns run first, so the key is labeled anthropic-key rather than a bare secret.
    expect(redactSecrets(key, [key])).toBe('[redacted:anthropic-key]')
  })

  it('is a no-op on empty input', () => {
    expect(redactSecrets('', ['whatever-secret-value'])).toBe('')
  })
})

describe('createSecretRedactor', () => {
  it('reuses a prepared value set across calls', () => {
    const redact = createSecretRedactor(['long-lived-secret-value-xyz'])
    expect(redact('a=long-lived-secret-value-xyz')).toBe('a=[redacted:secret]')
    expect(redact('b=long-lived-secret-value-xyz')).toBe('b=[redacted:secret]')
    expect(redact('nothing here')).toBe('nothing here')
  })

  it('applies pattern redaction with no known values', () => {
    const redact = createSecretRedactor([])
    expect(redact('ghp_' + 'A'.repeat(36))).toBe('[redacted:github-token]')
  })

  it('dedupes and tolerates empty/short values in the set', () => {
    const redact = createSecretRedactor(['x', '', 'proper-secret-value-1', 'proper-secret-value-1'])
    expect(redact('v=proper-secret-value-1 and x')).toBe('v=[redacted:secret] and x')
  })
})

describe('findSecret', () => {
  it('returns null for clean text', () => {
    expect(findSecret('https://api.example.com/v1/data?page=2')).toBeNull()
    expect(findSecret('')).toBeNull()
    expect(findSecret('a perfectly ordinary search query')).toBeNull()
  })

  it('detects a well-known token FORMAT and labels it (no stored copy needed)', () => {
    expect(findSecret('https://evil.example/?k=ghp_' + 'A'.repeat(36))).toBe('github-token')
    expect(findSecret('sk-ant-api03-' + 'A'.repeat(80))).toBe('anthropic-key')
    expect(findSecret('leak AKIA' + 'ABCDEFGHIJKLMNOP')).toBe('aws-access-key-id')
  })

  it('refuses egress carrying the credentials the cloud provider auth flows mint', () => {
    expect(findSecret(`https://evil.example/?k=${AWS_STS_KEY_ID}`)).toBe('aws-access-key-id')
    expect(findSecret('https://evil.example/?t=ya29.' + 'b'.repeat(40))).toBe('google-oauth-token')
    expect(findSecret('https://evil.example/?t=1//0' + 'c'.repeat(40))).toBe('google-oauth-token')
  })

  it('detects a known stored VALUE whatever its shape', () => {
    expect(findSecret('q=stored-opaque-credential-xyz', ['stored-opaque-credential-xyz'])).toBe('secret')
    expect(findSecret('q=stored-opaque-credential-xyz', [])).toBeNull()
  })

  it('does not advance a shared regex lastIndex across calls', () => {
    const token = 'ghp_' + 'B'.repeat(36)
    // Two calls in a row must both match — a stale `lastIndex` from the first would
    // otherwise let the second slip through.
    expect(findSecret(token)).toBe('github-token')
    expect(findSecret(token)).toBe('github-token')
  })
})
