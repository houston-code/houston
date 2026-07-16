import { describe, it, expect } from 'vitest'
import { createSecretRedactor, findSecret, redactSecrets } from './redact'

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
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toBe('[redacted:aws-access-key-id]')
    expect(redactSecrets('AIza' + 'x'.repeat(35))).toBe('[redacted:google-api-key]')
    expect(redactSecrets('xoxb-' + '1'.repeat(20))).toBe('[redacted:slack-token]')
  })

  it('redacts AWS temporary access key ids (SSO / IAM role / STS), not just long-lived ones', () => {
    expect(redactSecrets('ASIAIOSFODNN7EXAMPLE')).toBe('[redacted:aws-access-key-id]')
    expect(redactSecrets('AWS_ACCESS_KEY_ID=ASIAY34FZKBOKMUTVV7A')).toBe(
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
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabc/def+ghi=\n-----END RSA PRIVATE KEY-----'
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
    expect(findSecret('https://evil.example/?k=ASIAY34FZKBOKMUTVV7A')).toBe('aws-access-key-id')
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
