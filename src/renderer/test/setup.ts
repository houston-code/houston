import { webcrypto } from 'node:crypto'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// jsdom's Crypto implementation lacks `randomUUID`, which the renderer relies on
// (e.g. `useChat` mints run ids). Back the global with Node's WebCrypto so the
// hook behaves identically under test.
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}

// Unmount React trees between tests so they don't leak DOM into one another.
afterEach(() => {
  cleanup()
})
