import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `hasKey` must reflect whether a key is actually *usable* (decryptable), not merely
 * whether ciphertext is on disk — otherwise the UI/model-selection shows a key as set
 * while every agent run fails with "No API key set". The mocked `safeStorage` below
 * can be told to fail decryption to simulate a Keychain item that can no longer be
 * unlocked (e.g. after an unsigned app is rebuilt/re-signed).
 */

const state = vi.hoisted(() => ({
  userData: '',
  failDecrypt: false,
  failEncrypt: false,
  encryptionAvailable: true,
  // Ciphertext prefixes safeStorage reports as needing re-encryption (a rotated key).
  staleKeyPrefix: 'v0:'
}))

vi.mock('./userData', () => ({
  getUserDataDir: () => state.userData
}))

// Only the async API: the synchronous safeStorage calls are deprecated (removed in
// Electron 46), so any leftover use of them fails here.
vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => state.encryptionAvailable,
    encryptStringAsync: async (s: string) => {
      if (state.failEncrypt) throw new Error('Keychain write failed')
      return Buffer.from(`v1:${s}`, 'utf8')
    },
    decryptStringAsync: async (buf: Buffer) => {
      if (state.failDecrypt) throw new Error('Keychain item could not be unlocked')
      const s = buf.toString('utf8')
      if (s.startsWith(state.staleKeyPrefix)) return { result: s.slice(3), shouldReEncrypt: true }
      if (!s.startsWith('v1:')) throw new Error('bad ciphertext')
      return { result: s.slice(3), shouldReEncrypt: false }
    },
    getSelectedStorageBackend: () => 'gnome_libsecret'
  }
}))

import {
  collectSecretValues,
  deleteKey,
  deleteSecretHeaders,
  flushSecrets,
  getCredential,
  getKey,
  getMcpOAuthTokens,
  getSecretHeaders,
  hasKey,
  hasPendingSecretWrites,
  hasStoredKey,
  initSecrets,
  isWeakEncryptionBackend,
  mcpOAuthKeyId,
  refreshSecretsFromDisk,
  setCredential,
  setKey,
  secureStorageStatus,
  setMcpOAuthTokens,
  setSecretHeaders
} from './secrets'

beforeEach(async () => {
  state.userData = mkdtempSync(join(tmpdir(), 'houston-secrets-'))
  state.failDecrypt = false
  state.failEncrypt = false
  state.encryptionAvailable = true
  await initSecrets()
})

afterEach(async () => {
  await flushSecrets().catch(() => {})
  rmSync(state.userData, { recursive: true, force: true })
})

/** Simulate a relaunch: wait for queued writes, then decrypt the store from disk again. */
async function relaunch(): Promise<void> {
  await flushSecrets()
  await initSecrets()
}

function rawFile(): { keys: Record<string, string>; headers?: Record<string, string> } {
  return JSON.parse(readFileSync(join(state.userData, 'secrets.json'), 'utf8'))
}

describe('isWeakEncryptionBackend', () => {
  it('flags only the Linux hardcoded-key basic_text backend', () => {
    expect(isWeakEncryptionBackend('linux', 'basic_text')).toBe(true)
    expect(isWeakEncryptionBackend('linux', 'gnome_libsecret')).toBe(false)
    expect(isWeakEncryptionBackend('linux', 'kwallet')).toBe(false)
    expect(isWeakEncryptionBackend('linux', null)).toBe(false)
    // The concept is Linux-specific; other platforms have DPAPI/Keychain.
    expect(isWeakEncryptionBackend('darwin', 'basic_text')).toBe(false)
    expect(isWeakEncryptionBackend('win32', 'basic_text')).toBe(false)
  })
})

describe('secrets store', () => {
  it('round-trips a stored key', () => {
    setKey('anthropic', 'sk-test')
    expect(getKey('anthropic')).toBe('sk-test')
    expect(hasStoredKey('anthropic')).toBe(true)
    expect(hasKey('anthropic')).toBe(true)
  })

  it('reports no key when nothing is stored', () => {
    expect(getKey('anthropic')).toBeNull()
    expect(hasStoredKey('anthropic')).toBe(false)
    expect(hasKey('anthropic')).toBe(false)
  })

  it('hasKey is false for a stored-but-undecryptable key, while hasStoredKey stays true', async () => {
    setKey('anthropic', 'sk-test')
    state.failDecrypt = true // Keychain item can no longer be unlocked
    await relaunch()
    expect(hasStoredKey('anthropic')).toBe(true)
    expect(getKey('anthropic')).toBeNull()
    expect(hasKey('anthropic')).toBe(false)
  })

  it('deleteKey removes the stored ciphertext', () => {
    setKey('openai', 'sk-x')
    deleteKey('openai')
    expect(hasStoredKey('openai')).toBe(false)
    expect(hasKey('openai')).toBe(false)
    expect(getKey('openai')).toBeNull()
  })

  it('round-trips an api-key credential via getCredential/setCredential', () => {
    setCredential('anthropic', { type: 'api-key', key: 'sk-test' })
    expect(getCredential('anthropic')).toEqual({ type: 'api-key', key: 'sk-test' })
    // getKey still returns the bare key for api-key credentials.
    expect(getKey('anthropic')).toBe('sk-test')
    expect(hasKey('anthropic')).toBe(true)
  })

  it('round-trips an oauth credential', () => {
    const cred = {
      type: 'oauth' as const,
      access: 'access-tok',
      refresh: 'refresh-tok',
      expiresAt: 1_700_000_000_000
    }
    setCredential('anthropic', cred)
    expect(getCredential('anthropic')).toEqual(cred)
    expect(hasStoredKey('anthropic')).toBe(true)
    expect(hasKey('anthropic')).toBe(true)
  })

  it('getKey returns the oauth access token for an oauth credential', () => {
    setCredential('anthropic', {
      type: 'oauth',
      access: 'access-tok',
      refresh: 'refresh-tok'
    })
    // Callers that only understand a bearer string keep working under OAuth.
    expect(getKey('anthropic')).toBe('access-tok')
  })

  it('decodes a legacy bare-string key stored before the credential generalization', async () => {
    // Simulate the pre-generalization layout: ciphertext of the raw key, no JSON.
    const legacyCiphertext = Buffer.from('v1:legacy-key', 'utf8').toString('base64')
    writeFileSync(
      join(state.userData, 'secrets.json'),
      JSON.stringify({ keys: { openai: legacyCiphertext } })
    )
    await initSecrets()
    expect(getKey('openai')).toBe('legacy-key')
    expect(getCredential('openai')).toEqual({ type: 'api-key', key: 'legacy-key' })
    expect(hasKey('openai')).toBe(true)
  })

  it('setKey writes a credential that getCredential reads back as api-key', () => {
    setKey('openai', 'sk-y')
    expect(getCredential('openai')).toEqual({ type: 'api-key', key: 'sk-y' })
  })
})

describe('secure storage unavailable (e.g. a denied Keychain prompt)', () => {
  it('refuses to store a key, with a message that says how to recover', async () => {
    state.encryptionAvailable = false
    await initSecrets()
    expect(() => setKey('anthropic', 'sk-x')).toThrow(/restart Houston/i)
    expect(hasStoredKey('anthropic')).toBe(false)
  })

  it('reports the status the renderer uses to offer a restart', async () => {
    state.encryptionAvailable = false
    await initSecrets()
    expect(secureStorageStatus()).toEqual({ available: false, platform: process.platform })
    // Only a relaunch picks up a Keychain that became available (Electron caches the
    // failed lookup for the process), which is why the renderer offers a restart.
    state.encryptionAvailable = true
    expect(secureStorageStatus().available).toBe(false)
    await initSecrets()
    expect(secureStorageStatus().available).toBe(true)
  })

  it('reads nothing back while the store is unavailable', async () => {
    setKey('anthropic', 'sk-test')
    setSecretHeaders('provider:openai', { Authorization: 'Bearer tok' })
    state.encryptionAvailable = false
    await relaunch()
    expect(getKey('anthropic')).toBeNull()
    expect(getSecretHeaders('provider:openai')).toEqual({})
    // The ciphertext stays on disk for a later launch that can unlock it.
    expect(hasStoredKey('anthropic')).toBe(true)
  })
})

describe('MCP OAuth token store', () => {
  const tokens = {
    access: 'mcp-access-token',
    refresh: 'mcp-refresh-token',
    expiresAt: 1_800_000_000_000,
    scope: 'mcp:read',
    clientId: 'dyn-client-1',
    clientSecret: 'dyn-secret-1',
    tokenEndpoint: 'https://auth.example.com/token',
    resource: 'https://mcp.example.com/mcp'
  }

  it('round-trips a token set per server id', () => {
    setMcpOAuthTokens('linear', tokens)
    expect(getMcpOAuthTokens('linear')).toEqual(tokens)
    expect(getMcpOAuthTokens('other')).toBeNull()
  })

  it('normalizes an absent refresh token to undefined', () => {
    setMcpOAuthTokens('linear', { ...tokens, refresh: undefined })
    expect(getMcpOAuthTokens('linear')!.refresh).toBeUndefined()
  })

  it('signs out with null', () => {
    setMcpOAuthTokens('linear', tokens)
    setMcpOAuthTokens('linear', null)
    expect(getMcpOAuthTokens('linear')).toBeNull()
  })

  it('never collides with a provider credential of the same bare id', () => {
    setKey('linear', 'sk-provider')
    setMcpOAuthTokens('linear', tokens)
    expect(getKey('linear')).toBe('sk-provider')
    expect(getMcpOAuthTokens('linear')!.access).toBe('mcp-access-token')
  })

  it('reports null for a blob missing what a refresh needs', () => {
    setCredential(mcpOAuthKeyId('linear'), { type: 'oauth', access: 'a', refresh: 'r' })
    expect(getMcpOAuthTokens('linear')).toBeNull()
  })

  it('feeds the client secret and tokens into collectSecretValues', () => {
    setMcpOAuthTokens('linear', tokens)
    const values = collectSecretValues()
    expect(values).toContain('mcp-access-token')
    expect(values).toContain('mcp-refresh-token')
    expect(values).toContain('dyn-secret-1')
  })
})

describe('secret headers store', () => {
  it('round-trips an encrypted header map for a scope', () => {
    setSecretHeaders('provider:openai', { Authorization: 'Bearer tok', 'X-Title': 'Houston' })
    expect(getSecretHeaders('provider:openai')).toEqual({
      Authorization: 'Bearer tok',
      'X-Title': 'Houston'
    })
  })

  it('keeps header scopes independent (provider vs mcp with the same id)', () => {
    setSecretHeaders('provider:x', { Authorization: 'Bearer p' })
    setSecretHeaders('mcp:x', { Authorization: 'Bearer m' })
    expect(getSecretHeaders('provider:x')).toEqual({ Authorization: 'Bearer p' })
    expect(getSecretHeaders('mcp:x')).toEqual({ Authorization: 'Bearer m' })
  })

  it('returns {} when nothing is stored for a scope', () => {
    expect(getSecretHeaders('provider:missing')).toEqual({})
  })

  it('setSecretHeaders with an empty map removes the entry (no stale ciphertext)', async () => {
    setSecretHeaders('mcp:remote', { Authorization: 'Bearer tok' })
    setSecretHeaders('mcp:remote', {})
    expect(getSecretHeaders('mcp:remote')).toEqual({})
    // The scope is gone from the raw file, not just decrypting to {}.
    await flushSecrets()
    expect(rawFile().headers?.['mcp:remote']).toBeUndefined()
  })

  it('deleteSecretHeaders removes a stored scope', () => {
    setSecretHeaders('provider:openai', { Authorization: 'Bearer tok' })
    deleteSecretHeaders('provider:openai')
    expect(getSecretHeaders('provider:openai')).toEqual({})
  })

  it('returns {} for a stored-but-undecryptable header map', async () => {
    setSecretHeaders('provider:openai', { Authorization: 'Bearer tok' })
    state.failDecrypt = true
    await relaunch()
    expect(getSecretHeaders('provider:openai')).toEqual({})
  })

  it('stores header ciphertext, not the plaintext token, on disk', async () => {
    setSecretHeaders('provider:openai', { Authorization: 'Bearer super-secret' })
    await flushSecrets()
    const raw = readFileSync(join(state.userData, 'secrets.json'), 'utf8')
    expect(raw).not.toContain('super-secret')
    // The header blob and the credential keys live in separate maps.
    setKey('openai', 'sk-key')
    await flushSecrets()
    const parsed = rawFile()
    expect(parsed.keys.openai).toBeTruthy()
    expect(parsed.headers?.['provider:openai']).toBeTruthy()
  })
})

describe('collectSecretValues', () => {
  it('collects api keys and both OAuth tokens', () => {
    setKey('anthropic', 'sk-ant-longenoughkey')
    setCredential('openai', {
      type: 'oauth',
      access: 'access-token-longenough',
      refresh: 'refresh-token-longenough'
    })
    expect(collectSecretValues().sort()).toEqual(
      ['access-token-longenough', 'refresh-token-longenough', 'sk-ant-longenoughkey'].sort()
    )
  })

  it('drops credential values below the length floor', () => {
    setKey('tiny', 'short') // 5 chars < MIN_CREDENTIAL_LEN
    expect(collectSecretValues()).toEqual([])
  })

  it('collects the opaque token out of a header value, not the scheme word', () => {
    const token = 'a'.repeat(24)
    setSecretHeaders('provider:acme', {
      Authorization: `Bearer ${token}`, // → the long token, not "Bearer"
      'Content-Type': 'application/json', // short-ish, common → not a secret
      'X-Trace': 'has spaces in it so not opaque' // all short words → not a secret
    })
    expect(collectSecretValues()).toEqual([token])
  })

  it('skips undecryptable entries rather than throwing', async () => {
    setKey('anthropic', 'sk-ant-longenoughkey')
    state.failDecrypt = true
    await relaunch()
    expect(collectSecretValues()).toEqual([])
  })

  it('caches until a write invalidates it', () => {
    setKey('anthropic', 'sk-ant-longenoughkey')
    expect(collectSecretValues()).toEqual(['sk-ant-longenoughkey'])
    // A later write is reflected (the cache was dropped on persist).
    setKey('openai', 'sk-openai-longenough')
    expect(collectSecretValues().sort()).toEqual(
      ['sk-ant-longenoughkey', 'sk-openai-longenough'].sort()
    )
  })
})

describe('async persistence', () => {
  it('a write is readable at once and survives a relaunch', async () => {
    setKey('anthropic', 'sk-test')
    expect(getKey('anthropic')).toBe('sk-test')
    expect(hasPendingSecretWrites()).toBe(true)
    await relaunch()
    expect(hasPendingSecretWrites()).toBe(false)
    expect(getKey('anthropic')).toBe('sk-test')
  })

  it('stores ciphertext, never the plaintext key', async () => {
    setKey('anthropic', 'sk-plaintext-marker')
    await flushSecrets()
    expect(rawFile().keys.anthropic).toBe(Buffer.from('v1:{"type":"api-key","key":"sk-plaintext-marker"}').toString('base64'))
    expect(readFileSync(join(state.userData, 'secrets.json'), 'utf8')).not.toContain('sk-plaintext-marker')
  })

  it('applies queued writes in order', async () => {
    setKey('anthropic', 'first')
    setKey('anthropic', 'second')
    deleteKey('openai')
    setKey('openai', 'sk-openai')
    deleteKey('openai')
    await relaunch()
    expect(getKey('anthropic')).toBe('second')
    expect(hasStoredKey('openai')).toBe(false)
  })

  it('a failed write rejects the next flush and rolls the value back', async () => {
    setKey('anthropic', 'kept')
    await flushSecrets()
    state.failEncrypt = true
    setKey('anthropic', 'lost')
    expect(getKey('anthropic')).toBe('lost')
    await expect(flushSecrets()).rejects.toThrow('Keychain write failed')
    expect(getKey('anthropic')).toBe('kept')
    expect(collectSecretValues()).not.toContain('lost')
    // The error is reported once.
    await expect(flushSecrets()).resolves.toBeUndefined()
  })

  it('two failed writes fall back to what is on disk, not the earlier failed value', async () => {
    setKey('anthropic', 'on-disk')
    await flushSecrets()
    state.failEncrypt = true
    setKey('anthropic', 'fails-1')
    setKey('anthropic', 'fails-2')
    await expect(flushSecrets()).rejects.toThrow()
    expect(getKey('anthropic')).toBe('on-disk')
  })

  it('a failed write never rolls back a newer value that saved', async () => {
    let calls = 0
    state.failEncrypt = false
    const { safeStorage } = await import('electron')
    const original = safeStorage.encryptStringAsync
    // Fail only the first encryption.
    safeStorage.encryptStringAsync = async (s: string) => {
      if (calls++ === 0) throw new Error('transient')
      return original(s)
    }
    try {
      setKey('anthropic', 'fails')
      setKey('anthropic', 'saved')
      await expect(flushSecrets()).rejects.toThrow('transient')
      expect(getKey('anthropic')).toBe('saved')
      await relaunch()
      expect(getKey('anthropic')).toBe('saved')
    } finally {
      safeStorage.encryptStringAsync = original
    }
  })

  it('a failed new header map is removed from memory', async () => {
    state.failEncrypt = true
    setSecretHeaders('provider:openai', { Authorization: 'Bearer tok' })
    await expect(flushSecrets()).rejects.toThrow()
    expect(getSecretHeaders('provider:openai')).toEqual({})
  })

  it('re-encrypts entries safeStorage flags as stale', async () => {
    const stale = (s: string): string => Buffer.from(`v0:${s}`, 'utf8').toString('base64')
    writeFileSync(
      join(state.userData, 'secrets.json'),
      JSON.stringify({
        keys: { anthropic: stale('{"type":"api-key","key":"sk-old"}') },
        headers: { 'provider:openai': stale('{"Authorization":"Bearer tok"}') }
      })
    )
    await initSecrets()
    expect(getKey('anthropic')).toBe('sk-old')
    expect(getSecretHeaders('provider:openai')).toEqual({ Authorization: 'Bearer tok' })
    await flushSecrets()
    const raw = rawFile()
    expect(Buffer.from(raw.keys.anthropic, 'base64').toString('utf8')).toMatch(/^v1:/)
    expect(Buffer.from(raw.headers!['provider:openai'], 'base64').toString('utf8')).toMatch(/^v1:/)
  })

  it('keeps entries another process wrote since startup', async () => {
    setKey('anthropic', 'sk-mine')
    await flushSecrets()
    const raw = rawFile()
    raw.keys.openai = Buffer.from('v1:sk-theirs', 'utf8').toString('base64')
    writeFileSync(join(state.userData, 'secrets.json'), JSON.stringify(raw))
    setKey('gemini', 'sk-gemini')
    await relaunch()
    expect(getKey('anthropic')).toBe('sk-mine')
    expect(getKey('openai')).toBe('sk-theirs')
    expect(getKey('gemini')).toBe('sk-gemini')
  })

  it('deleting what was never stored writes nothing', async () => {
    deleteKey('anthropic')
    deleteSecretHeaders('provider:openai')
    setSecretHeaders('mcp:remote', {})
    await flushSecrets()
    expect(existsSync(join(state.userData, 'secrets.json'))).toBe(false)
  })

  it('a getter returns a copy of the header map', () => {
    setSecretHeaders('provider:openai', { Authorization: 'Bearer tok' })
    getSecretHeaders('provider:openai').Authorization = 'mutated'
    expect(getSecretHeaders('provider:openai')).toEqual({ Authorization: 'Bearer tok' })
  })

  it('before initSecrets, reads see nothing and writes refuse', async () => {
    setKey('anthropic', 'sk-test')
    await flushSecrets()
    vi.resetModules()
    const fresh = await import('./secrets')
    expect(fresh.getKey('anthropic')).toBeNull()
    expect(fresh.secureStorageStatus().available).toBe(false)
    expect(() => fresh.setKey('anthropic', 'sk-x')).toThrow(/restart Houston/i)
    await fresh.initSecrets()
    expect(fresh.getKey('anthropic')).toBe('sk-test')
  })
})

// The desktop app and a terminal session each hold a vault over the same file. These
// stand in for the other process by writing the file directly, as it would.
describe('changes made by another Houston process', () => {
  const cipher = (plaintext: string): string => Buffer.from(`v1:${plaintext}`, 'utf8').toString('base64')
  const otherProcessWrites = (mutate: (f: { keys: Record<string, string>; headers?: Record<string, string> }) => void): void => {
    const path = join(state.userData, 'secrets.json')
    const file = existsSync(path) ? rawFile() : { keys: {} }
    mutate(file)
    writeFileSync(path, JSON.stringify(file))
  }

  it('picks up a key saved, rotated, or deleted in the other process', async () => {
    setKey('openai', 'sk-mine-1234')
    await flushSecrets()
    otherProcessWrites((f) => {
      f.keys.anthropic = cipher(JSON.stringify({ type: 'api-key', key: 'sk-theirs-5678' }))
    })
    await refreshSecretsFromDisk()
    expect(getKey('anthropic')).toBe('sk-theirs-5678')
    expect(getKey('openai')).toBe('sk-mine-1234')
    expect(collectSecretValues()).toContain('sk-theirs-5678')

    otherProcessWrites((f) => {
      f.keys.anthropic = cipher(JSON.stringify({ type: 'api-key', key: 'sk-rotated-9999' }))
      delete f.keys.openai
    })
    await refreshSecretsFromDisk()
    expect(getKey('anthropic')).toBe('sk-rotated-9999')
    expect(getKey('openai')).toBeNull()
    expect(collectSecretValues()).not.toContain('sk-theirs-5678')
  })

  it('sees an MCP refresh token the other process rotated, and headers it saved', async () => {
    const tokens = { access: 'access-one-xxxxx', refresh: 'refresh-one-xxxx', clientId: 'c', tokenEndpoint: 'https://as/token' }
    setMcpOAuthTokens('srv', tokens)
    await flushSecrets()
    otherProcessWrites((f) => {
      f.keys[mcpOAuthKeyId('srv')] = cipher(
        JSON.stringify({ type: 'oauth', ...tokens, access: 'access-two-xxxxx', refresh: 'refresh-two-xxxx' })
      )
      f.headers = { ...(f.headers ?? {}), 'mcp:srv': cipher(JSON.stringify({ 'x-api-key': 'k' })) }
    })
    await refreshSecretsFromDisk()
    expect(getMcpOAuthTokens('srv')).toMatchObject({ access: 'access-two-xxxxx', refresh: 'refresh-two-xxxx' })
    expect(getSecretHeaders('mcp:srv')).toEqual({ 'x-api-key': 'k' })
  })

  it("never lets the other process's older copy replace a write still on its way to disk", async () => {
    otherProcessWrites((f) => {
      f.keys.anthropic = cipher(JSON.stringify({ type: 'api-key', key: 'sk-old-on-disk' }))
    })
    setKey('anthropic', 'sk-new-in-memory') // queued, not yet written
    await refreshSecretsFromDisk()
    expect(getKey('anthropic')).toBe('sk-new-in-memory')
    await flushSecrets()
    await refreshSecretsFromDisk()
    expect(getKey('anthropic')).toBe('sk-new-in-memory')
  })

  it('checks the file from the getters, at most once a second', async () => {
    const base = Date.now() + 10_000_000 // past any check an earlier test made
    const now = vi.spyOn(Date, 'now').mockReturnValue(base)
    try {
      getKey('anthropic') // checks, finds nothing new
      otherProcessWrites((f) => {
        f.keys.anthropic = cipher(JSON.stringify({ type: 'api-key', key: 'sk-from-the-app' }))
      })
      now.mockReturnValue(base + 500)
      getKey('anthropic') // within the second: not even a stat
      await new Promise((r) => setTimeout(r, 10))
      expect(getKey('anthropic')).toBeNull()
      now.mockReturnValue(base + 1_500)
      expect(getKey('anthropic')).toBeNull() // notices the change, re-syncs in the background
      await new Promise((r) => setTimeout(r, 10))
      expect(getKey('anthropic')).toBe('sk-from-the-app')
    } finally {
      now.mockRestore()
    }
  })
})
