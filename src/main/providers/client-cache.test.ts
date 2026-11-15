import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_SHARED_CLIENTS,
  clientKey,
  fileStamp,
  forgetSharedClient,
  isAuthRejection,
  resetSharedClients,
  sharedClient,
  sharedClientCount
} from './client-cache'

beforeEach(() => resetSharedClients())

describe('sharedClient', () => {
  it('builds a client once per key and hands every caller the same one', async () => {
    const build = vi.fn(async () => ({ id: Math.random() }))
    const a = await sharedClient('k', build)
    const b = await sharedClient('k', build)
    expect(b).toBe(a)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('builds a separate client for a different key', async () => {
    const build = vi.fn(async () => ({ id: Math.random() }))
    const a = await sharedClient('k1', build)
    const b = await sharedClient('k2', build)
    expect(b).not.toBe(a)
    expect(build).toHaveBeenCalledTimes(2)
  })

  it('does not keep a build that failed, so the next caller tries again', async () => {
    const build = vi
      .fn<() => Promise<{ ok: boolean }>>()
      .mockRejectedValueOnce(new Error('SDK did not load'))
      .mockResolvedValue({ ok: true })
    await expect(sharedClient('k', build)).rejects.toThrow('SDK did not load')
    await Promise.resolve()
    expect(sharedClientCount()).toBe(0)
    await expect(sharedClient('k', build)).resolves.toEqual({ ok: true })
    expect(build).toHaveBeenCalledTimes(2)
  })

  it('builds afresh once a client is forgotten', async () => {
    const build = vi.fn(async () => ({ id: Math.random() }))
    const a = await sharedClient('k', build)
    forgetSharedClient('k')
    const b = await sharedClient('k', build)
    expect(b).not.toBe(a)
  })

  it('keeps at most MAX_SHARED_CLIENTS, dropping the least recently used', async () => {
    const build = vi.fn(async () => ({}))
    for (let i = 0; i < MAX_SHARED_CLIENTS; i++) await sharedClient(`k${i}`, build)
    // k0 is used again, so k1 is now the oldest.
    await sharedClient('k0', build)
    await sharedClient('extra', build)
    expect(sharedClientCount()).toBe(MAX_SHARED_CLIENTS)
    build.mockClear()
    await sharedClient('k0', build)
    expect(build).not.toHaveBeenCalled()
    await sharedClient('k1', build)
    expect(build).toHaveBeenCalledTimes(1)
  })
})

describe('clientKey', () => {
  it('is the same for the same inputs, whatever their key order', () => {
    expect(clientKey('vertex', { region: 'r', headers: { a: '1', b: '2' } })).toBe(
      clientKey('vertex', { headers: { b: '2', a: '1' }, region: 'r' })
    )
  })

  it('differs when any input differs, the kind included', () => {
    const base = { region: 'r', apiKey: 'k1', headers: { a: '1' } }
    const keys = new Set([
      clientKey('bedrock', base),
      clientKey('vertex', base),
      clientKey('bedrock', { ...base, region: 'r2' }),
      clientKey('bedrock', { ...base, apiKey: 'k2' }),
      clientKey('bedrock', { ...base, headers: { a: '2' } }),
      clientKey('bedrock', { ...base, apiKey: undefined })
    ])
    expect(keys.size).toBe(6)
  })

  it('never holds a secret among its inputs, nor a plain hash of them', () => {
    const secret = 'sk-live-0123456789abcdef'
    const inputs = { apiKey: secret, headers: { Authorization: `Bearer ${secret}` } }
    const key = clientKey('bedrock', inputs)
    expect(key).not.toContain(secret)
    expect(key).not.toContain('Bearer')
    // Keyed under a per-process secret: the same inputs hashed plainly do not reproduce it.
    const plain = createHash('sha256').update(JSON.stringify(inputs)).digest('hex')
    expect(key).not.toContain(plain)
    expect(key).toMatch(/^bedrock:[0-9a-f]{64}$/)
  })
})

describe('fileStamp', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'houston-client-cache-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('changes when the file is rewritten, and is null when there is none', () => {
    const file = join(dir, 'credentials')
    expect(fileStamp(file)).toBeNull()
    expect(fileStamp(undefined)).toBeNull()
    writeFileSync(file, 'first')
    const before = fileStamp(file)
    expect(before).not.toBeNull()
    writeFileSync(file, 'second login')
    expect(fileStamp(file)).not.toBe(before)
  })
})

describe('isAuthRejection', () => {
  it('is true for refused credentials only', () => {
    expect(isAuthRejection({ status: 401 })).toBe(true)
    expect(isAuthRejection({ status: 403 })).toBe(true)
    expect(isAuthRejection({ status: 429 })).toBe(false)
    expect(isAuthRejection({ status: 500 })).toBe(false)
    expect(isAuthRejection(new Error('network'))).toBe(false)
    expect(isAuthRejection(null)).toBe(false)
  })
})
