import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import {
  cliCollectSecrets,
  cliGetHeaders,
  cliGetKey,
  cliHasKey,
  cliRemoveKey,
  cliSetKey,
  envVarCandidates,
  genericEnvVar,
  resetCredentialWarnings
} from './credentials'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'houston-cli-creds-'))
  resetCredentialWarnings()
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function writeCreds(obj: unknown, mode = 0o600): void {
  const path = join(dir, 'cli-credentials.json')
  writeFileSync(path, JSON.stringify(obj))
  chmodSync(path, mode)
}

describe('env var mapping', () => {
  it('maps built-in provider ids to their conventional variables', () => {
    expect(envVarCandidates('anthropic')).toEqual(['ANTHROPIC_API_KEY', 'HOUSTON_API_KEY_ANTHROPIC'])
    expect(envVarCandidates('gemini')).toEqual([
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'HOUSTON_API_KEY_GEMINI'
    ])
    expect(envVarCandidates('web-search:brave')).toContain('BRAVE_API_KEY')
  })

  it('sanitizes arbitrary ids into the generic form', () => {
    expect(genericEnvVar('my custom.provider-2')).toBe('HOUSTON_API_KEY_MY_CUSTOM_PROVIDER_2')
  })

  it('maps catalog hosts to their documented variables (keying parity)', () => {
    expect(envVarCandidates('openrouter')).toEqual(['OPENROUTER_API_KEY', 'HOUSTON_API_KEY_OPENROUTER'])
    expect(envVarCandidates('groq')).toEqual(['GROQ_API_KEY', 'HOUSTON_API_KEY_GROQ'])
    // A catalog key set via its conventional env var resolves end-to-end.
    expect(cliGetKey('openrouter', { env: { OPENROUTER_API_KEY: 'or-key' }, dataDir: dir })).toBe('or-key')
  })

  it('prefers a well-known variable, then the generic, then the file', () => {
    writeCreds({ anthropic: 'from-file' })
    const deps = { dataDir: dir, warn: vi.fn() }
    expect(cliGetKey('anthropic', { ...deps, env: { ANTHROPIC_API_KEY: 'from-env' } })).toBe('from-env')
    expect(cliGetKey('anthropic', { ...deps, env: { HOUSTON_API_KEY_ANTHROPIC: 'generic' } })).toBe('generic')
    expect(cliGetKey('anthropic', { ...deps, env: {} })).toBe('from-file')
  })
})

describe('credentials file', () => {
  it('returns null when the file or the id is absent', () => {
    const deps = { dataDir: dir, env: {}, warn: vi.fn() }
    expect(cliGetKey('anthropic', deps)).toBeNull()
    writeCreds({ openai: 'sk-x' })
    expect(cliGetKey('anthropic', deps)).toBeNull()
    expect(cliHasKey('openai', deps)).toBe(true)
  })

  it('warns once on malformed JSON (treated as absent); non-string values are absent silently', () => {
    const warn = vi.fn()
    const deps = { dataDir: dir, env: {}, warn }
    const path = join(dir, 'cli-credentials.json')
    writeFileSync(path, 'not json{')
    chmodSync(path, 0o600) // isolate the malformed warning from the loose-perms one
    expect(cliGetKey('anthropic', deps)).toBeNull()
    expect(cliGetKey('openai', deps)).toBeNull() // a second read in the same process
    expect(warn).toHaveBeenCalledTimes(1) // once per process, not per read
    expect(String(warn.mock.calls[0][0])).toContain('not valid JSON')

    warn.mockClear()
    writeCreds({ anthropic: 42 }) // valid JSON, non-string value → absent, no warning
    expect(cliGetKey('anthropic', deps)).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns once when the file is readable by other users', () => {
    if (process.platform === 'win32') return
    writeCreds({ anthropic: 'sk-x' }, 0o644)
    const warn = vi.fn()
    const deps = { dataDir: dir, env: {}, warn }
    expect(cliGetKey('anthropic', deps)).toBe('sk-x')
    expect(cliGetKey('anthropic', deps)).toBe('sk-x')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('chmod 600')
  })

  it('does not warn for owner-only permissions', () => {
    if (process.platform === 'win32') return
    writeCreds({ anthropic: 'sk-x' }, 0o600)
    const warn = vi.fn()
    expect(cliGetKey('anthropic', { dataDir: dir, env: {}, warn })).toBe('sk-x')
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('headers file', () => {
  function writeHeaders(obj: unknown, mode = 0o600): void {
    const path = join(dir, 'cli-headers.json')
    writeFileSync(path, JSON.stringify(obj))
    chmodSync(path, mode)
  }

  it('returns the header map for a scope, and {} for an unknown scope or absent file', () => {
    const deps = { dataDir: dir, warn: vi.fn() }
    expect(cliGetHeaders('provider:openai', deps)).toEqual({}) // no file yet
    writeHeaders({ 'provider:openai': { Authorization: 'Bearer tok', 'X-Title': 'Houston' } })
    expect(cliGetHeaders('provider:openai', deps)).toEqual({
      Authorization: 'Bearer tok',
      'X-Title': 'Houston'
    })
    expect(cliGetHeaders('mcp:other', deps)).toEqual({})
  })

  it('drops non-string values silently, and warns once on malformed JSON', () => {
    const warn = vi.fn()
    const deps = { dataDir: dir, warn }
    writeHeaders({ 'provider:openai': { Authorization: 'Bearer tok', bad: 42 } })
    expect(cliGetHeaders('provider:openai', deps)).toEqual({ Authorization: 'Bearer tok' })
    expect(warn).not.toHaveBeenCalled() // valid JSON, just a non-string value

    const path = join(dir, 'cli-headers.json')
    writeFileSync(path, 'not json{')
    chmodSync(path, 0o600) // isolate the malformed warning from the loose-perms one
    expect(cliGetHeaders('provider:openai', deps)).toEqual({})
    expect(cliGetHeaders('mcp:x', deps)).toEqual({}) // second read, same process
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('not valid JSON')
  })

  it('warns once when the headers file is readable by other users', () => {
    if (process.platform === 'win32') return
    writeHeaders({ 'provider:openai': { Authorization: 'Bearer tok' } }, 0o644)
    const warn = vi.fn()
    const deps = { dataDir: dir, warn }
    cliGetHeaders('provider:openai', deps)
    cliGetHeaders('provider:openai', deps)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('chmod 600')
  })
})

describe('cliCollectSecrets', () => {
  function writeHeaders(obj: unknown): void {
    writeFileSync(join(dir, 'cli-headers.json'), JSON.stringify(obj))
  }

  it('collects known env vars, generic overrides, and file credentials', () => {
    writeCreds({ custom: 'file-key-longenough' })
    const env = {
      ANTHROPIC_API_KEY: 'anthropic-env-key',
      HOUSTON_API_KEY_ACME: 'acme-generic-key',
      UNRELATED_VAR: 'not-a-known-secret-name'
    }
    expect(cliCollectSecrets({ dataDir: dir, env }).sort()).toEqual(
      ['acme-generic-key', 'anthropic-env-key', 'file-key-longenough'].sort()
    )
  })

  it('ignores short env values and unknown env names', () => {
    const env = { ANTHROPIC_API_KEY: 'short', RANDOM: 'a-long-but-unknown-name-value' }
    expect(cliCollectSecrets({ dataDir: dir, env })).toEqual([])
  })

  it('collects the opaque token out of a header value, not the scheme word', () => {
    const token = 'a'.repeat(24)
    writeHeaders({
      'provider:acme': {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    })
    expect(cliCollectSecrets({ dataDir: dir, env: {} })).toEqual([token])
  })

  it('returns [] when no sources are present', () => {
    expect(cliCollectSecrets({ dataDir: dir, env: {} })).toEqual([])
  })

  it('still redacts built-in provider env keys after the shared-map refactor', () => {
    const env = { OPENAI_API_KEY: 'openai-secret-key', GROQ_API_KEY: 'groq-secret-key' }
    expect(cliCollectSecrets({ dataDir: dir, env }).sort()).toEqual(
      ['groq-secret-key', 'openai-secret-key'].sort()
    )
  })
})

describe('cliSetKey / cliRemoveKey', () => {
  it('writes a key to cli-credentials.json with 0600 perms and reads it back', () => {
    const res = cliSetKey('openrouter', 'or-secret', { dataDir: dir, env: {} })
    expect(res.shadowedByEnv).toBeNull()
    expect(cliGetKey('openrouter', { dataDir: dir, env: {} })).toBe('or-secret')
    if (process.platform !== 'win32') {
      const mode = statSync(join(dir, 'cli-credentials.json')).mode
      expect(mode & 0o077).toBe(0) // owner-only
    }
  })

  it('merges into an existing file without clobbering other keys', () => {
    cliSetKey('openrouter', 'or-secret', { dataDir: dir, env: {} })
    cliSetKey('groq', 'groq-secret', { dataDir: dir, env: {} })
    const parsed = JSON.parse(readFileSync(join(dir, 'cli-credentials.json'), 'utf8'))
    expect(parsed).toEqual({ openrouter: 'or-secret', groq: 'groq-secret' })
  })

  it('reports the env var that shadows a freshly stored key', () => {
    const res = cliSetKey('openrouter', 'stored', { dataDir: dir, env: { OPENROUTER_API_KEY: 'env-wins' } })
    expect(res.shadowedByEnv).toBe('OPENROUTER_API_KEY')
    // Env still wins in resolution, matching the warning.
    expect(cliGetKey('openrouter', { dataDir: dir, env: { OPENROUTER_API_KEY: 'env-wins' } })).toBe('env-wins')
  })

  it('removes a stored key, and is a no-op when there is nothing to remove', () => {
    cliSetKey('openrouter', 'or-secret', { dataDir: dir, env: {} })
    expect(cliRemoveKey('openrouter', { dataDir: dir })).toBe(true)
    expect(cliGetKey('openrouter', { dataDir: dir, env: {} })).toBeNull()
    expect(cliRemoveKey('openrouter', { dataDir: dir })).toBe(false)
    expect(cliRemoveKey('never-had-one', { dataDir: dir })).toBe(false)
  })
})
