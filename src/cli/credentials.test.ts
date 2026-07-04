import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cliGetHeaders,
  cliGetKey,
  cliHasKey,
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
