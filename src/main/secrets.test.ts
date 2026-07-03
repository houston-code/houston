import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  encryptionAvailable: true
}))

vi.mock('./userData', () => ({
  getUserDataDir: () => state.userData
}))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => state.encryptionAvailable,
    encryptString: (s: string) => Buffer.from(`v1:${s}`, 'utf8'),
    decryptString: (buf: Buffer) => {
      if (state.failDecrypt) throw new Error('Keychain item could not be unlocked')
      const s = buf.toString('utf8')
      if (!s.startsWith('v1:')) throw new Error('bad ciphertext')
      return s.slice(3)
    }
  }
}))

import {
  deleteKey,
  getCredential,
  getKey,
  hasKey,
  hasStoredKey,
  setCredential,
  setKey
} from './secrets'

beforeEach(() => {
  state.userData = mkdtempSync(join(tmpdir(), 'houston-secrets-'))
  state.failDecrypt = false
  state.encryptionAvailable = true
})

afterEach(() => {
  rmSync(state.userData, { recursive: true, force: true })
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

  it('hasKey is false for a stored-but-undecryptable key, while hasStoredKey stays true', () => {
    setKey('anthropic', 'sk-test')
    state.failDecrypt = true // Keychain item can no longer be unlocked
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

  it('decodes a legacy bare-string key stored before the credential generalization', () => {
    // Simulate the pre-generalization layout: ciphertext of the raw key, no JSON.
    const legacyCiphertext = Buffer.from('v1:legacy-key', 'utf8').toString('base64')
    writeFileSync(
      join(state.userData, 'secrets.json'),
      JSON.stringify({ keys: { openai: legacyCiphertext } })
    )
    expect(getKey('openai')).toBe('legacy-key')
    expect(getCredential('openai')).toEqual({ type: 'api-key', key: 'legacy-key' })
    expect(hasKey('openai')).toBe(true)
  })

  it('setKey writes a credential that getCredential reads back as api-key', () => {
    setKey('openai', 'sk-y')
    expect(getCredential('openai')).toEqual({ type: 'api-key', key: 'sk-y' })
  })
})
