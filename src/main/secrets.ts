import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

/**
 * API-key storage. Keys are encrypted with Electron `safeStorage`, which on macOS
 * derives its encryption key from the system Keychain. Only ciphertext touches disk;
 * plaintext keys never leave the main process and are never sent to the renderer.
 */

interface SecretsFile {
  // providerId -> base64(ciphertext)
  keys: Record<string, string>
}

function secretsPath(): string {
  return join(app.getPath('userData'), 'secrets.json')
}

function load(): SecretsFile {
  const path = secretsPath()
  if (!existsSync(path)) return { keys: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SecretsFile>
    return { keys: parsed.keys ?? {} }
  } catch {
    return { keys: {} }
  }
}

function persist(data: SecretsFile): void {
  const path = secretsPath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  // 0600 — owner read/write only.
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
  renameSync(tmp, path)
}

function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS encryption (Keychain) is unavailable, so API keys cannot be stored securely.'
    )
  }
}

export function setKey(providerId: string, plaintext: string): void {
  assertEncryptionAvailable()
  const data = load()
  const encrypted = safeStorage.encryptString(plaintext)
  data.keys[providerId] = encrypted.toString('base64')
  persist(data)
}

export function deleteKey(providerId: string): void {
  const data = load()
  if (providerId in data.keys) {
    delete data.keys[providerId]
    persist(data)
  }
}

/** True when *some* ciphertext is stored for this provider, decryptable or not. */
export function hasStoredKey(providerId: string): boolean {
  return Boolean(load().keys[providerId])
}

/**
 * True when a *usable* key is stored — ciphertext exists AND it decrypts with the
 * current OS encryption key. A key that's present on disk but can no longer be
 * unlocked (e.g. the Keychain item's access changed after an app re-sign/update)
 * returns false, so the "key set" signal the UI and model selection rely on matches
 * what an agent run can actually retrieve via `getKey`.
 */
export function hasKey(providerId: string): boolean {
  return getKey(providerId) !== null
}

/** Main-process only. Returns the decrypted key, or null if none/undecryptable. */
export function getKey(providerId: string): string | null {
  const stored = load().keys[providerId]
  if (!stored) return null
  try {
    assertEncryptionAvailable()
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return null
  }
}
