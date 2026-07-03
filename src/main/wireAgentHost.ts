import { configureAgentHost } from './agentHost'
import {
  addPermissionRule,
  configureHasKey,
  configureHeaderSecrets,
  getProvider,
  getSettings
} from './store'
import {
  deleteSecretHeaders,
  getKey,
  getSecretHeaders,
  hasKey,
  hasStoredKey,
  setSecretHeaders
} from './secrets'

/**
 * Bind the agent engine's host accessors (see `agentHost.ts`) plus the store's
 * credential-presence and header-secret seams to the real Electron-backed settings +
 * safeStorage secret storage. Called once at startup from the main entry, before any
 * run — covering all three Electron clients (GUI, headless, TUI), which boot through
 * `index.ts`. The standalone CLI wires its own implementations instead (src/cli).
 *
 * Kept out of `agentHost.ts` / `store.ts` themselves so those modules — which the
 * engine imports — never pull in `secrets` (and thus `electron`). This module is the
 * shell-side glue and may reference them freely.
 */
export function wireAgentHost(): void {
  configureHasKey(hasKey)
  configureHeaderSecrets({ get: getSecretHeaders, set: setSecretHeaders, remove: deleteSecretHeaders })
  configureAgentHost({
    getProvider,
    getSettings,
    addPermissionRule,
    getKey,
    hasStoredKey,
    getSecretHeaders
  })
}
