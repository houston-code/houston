import { configureAgentHost } from './agentHost'
import {
  addPermissionRule,
  configureHasKey,
  configureHeaderSecrets,
  configureMcpOAuthPresence,
  configureSetKey,
  getProvider,
  getSettings
} from './store'
import {
  collectSecretValues,
  deleteSecretHeaders,
  getKey,
  getMcpOAuthTokens,
  getSecretHeaders,
  hasKey,
  hasStoredKey,
  setKey,
  setMcpOAuthTokens,
  setSecretHeaders
} from './secrets'
import { configureLogRedactor } from './logger'
import { configureTitleRedaction } from './conversations'
import { redactSecrets } from './agent/redact'

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
  // safeStorage is the desktop's only key store, so the environment never shadows a
  // stored key here (unlike the CLI) — always report no shadow.
  configureSetKey((id, key) => {
    setKey(id, key)
    return { shadowedByEnv: null }
  })
  configureHeaderSecrets({ get: getSecretHeaders, set: setSecretHeaders, remove: deleteSecretHeaders })
  // The derived `hasOAuth` flag on MCP server configs (drives the Sign in/out UI).
  configureMcpOAuthPresence((serverId) => getMcpOAuthTokens(serverId) !== null)
  // Scrub stored secrets (and token-shaped strings) from every log line.
  configureLogRedactor((message) => redactSecrets(message, collectSecretValues()))
  // Known-value source for redacting derived conversation titles.
  configureTitleRedaction(collectSecretValues)
  configureAgentHost({
    getProvider,
    getSettings,
    addPermissionRule,
    getKey,
    hasStoredKey,
    getSecretHeaders,
    collectSecrets: collectSecretValues,
    getMcpOAuth: getMcpOAuthTokens,
    setMcpOAuth: setMcpOAuthTokens
  })
}
