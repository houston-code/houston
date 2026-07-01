import { configureAgentHost } from './agentHost'
import { addPermissionRule, getProvider, getSettings } from './store'
import { getKey, hasStoredKey } from './secrets'

/**
 * Bind the agent engine's host accessors (see `agentHost.ts`) to the real
 * Electron-backed settings + secret storage. Called once at startup from the main
 * entry, before any run — covering all three clients (GUI, headless, TUI), which
 * all boot through `index.ts`.
 *
 * Kept out of `agentHost.ts` itself so that module — which the engine imports —
 * never pulls in `store` / `secrets` (and thus `electron`). This module is the
 * shell-side glue and may reference them freely.
 */
export function wireAgentHost(): void {
  configureAgentHost({ getProvider, getSettings, addPermissionRule, getKey, hasStoredKey })
}
