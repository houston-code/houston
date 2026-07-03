import { configureAgentHost } from './agentHost'
import { addPermissionRule, configureHasKey, getProvider, getSettings } from './store'
import { getKey, hasKey, hasStoredKey } from './secrets'

/**
 * Bind the agent engine's host accessors (see `agentHost.ts`) to the real
 * Electron-backed settings + secret storage, and the store's credential-presence
 * check to the safeStorage-backed secrets. Called once at startup from the main
 * entry, before any run — covering all three Electron clients (GUI, headless,
 * TUI), which boot through `index.ts`. The standalone CLI wires its own
 * implementations instead (src/cli).
 *
 * Kept out of `agentHost.ts` / `store.ts` themselves so those modules — which the
 * engine imports — never pull in `secrets` (and thus `electron`). This module is
 * the shell-side glue and may reference them freely.
 */
export function wireAgentHost(): void {
  configureHasKey(hasKey)
  configureAgentHost({ getProvider, getSettings, addPermissionRule, getKey, hasStoredKey })
}
