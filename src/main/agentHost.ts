import type { AppSettings, PermissionRule, ProviderConfig } from '@shared/types'

/**
 * Injection seam between the agent engine (`agent/`, `providers/`, `mcp/`,
 * `sandbox/`) and the app's Electron-backed settings + secret storage.
 *
 * The engine reads provider config, settings, and credentials, but must not
 * import `electron` — directly or transitively. Importing `./store` / `./secrets`
 * would pull it in (both `import { app } from 'electron'`), so engine code imports
 * the electron-free accessors below instead, and the desktop shell wires the real
 * implementation once at startup via {@link configureAgentHost}
 * (see `wireAgentHost.ts`). This keeps the engine's dependency graph portable to
 * non-Electron hosts — the full-screen TUI as its own bundle, a future embeddable
 * SDK — and lets tests supply a fake without a running app.
 *
 * An eslint rule (see `eslint.config.mjs`) forbids `electron` / `store` /
 * `secrets` imports under the engine dirs so this boundary can't silently erode.
 */
export interface AgentHost {
  /** Look up a provider by id from current settings. */
  getProvider(providerId: string): ProviderConfig | undefined
  /** Current app settings, with live `hasKey` flags attached. */
  getSettings(): AppSettings
  /** Persist a permission rule from an in-prompt "Always allow / Always deny" choice. */
  addPermissionRule(rule: PermissionRule): AppSettings
  /** Decrypted API key (or OAuth access token) for a provider, or null if none/undecryptable. */
  getKey(providerId: string): string | null
  /** True when some ciphertext is stored for a provider (decryptable or not). */
  hasStoredKey(providerId: string): boolean
  /**
   * Decrypted custom-header map for a scope ("provider:<id>" / "mcp:<id>"; see the
   * header-scope helpers in @shared/types), or `{}` if none. Header values are
   * secrets, so they're pulled from the store and merged into requests here in the
   * engine rather than travelling on the config (which carries masked values).
   */
  getSecretHeaders(scope: string): Record<string, string>
  /**
   * Every plaintext secret value this install holds (provider keys, OAuth tokens,
   * custom-header secrets), for the tool-result/log redactor (see `agent/redact.ts`).
   * Optional: a host that can't enumerate its secrets just gets pattern-only redaction.
   */
  collectSecrets?(): string[]
}

let host: AgentHost | null = null

/** Bind the engine to a concrete host. Call once during startup, before any run. */
export function configureAgentHost(impl: AgentHost): void {
  host = impl
}

/** Reset the wired host. Test-only — lets a suite restore a clean, unconfigured state. */
export function resetAgentHost(): void {
  host = null
}

function requireHost(): AgentHost {
  if (!host) {
    throw new Error(
      'Agent host not configured — call configureAgentHost() during startup before running the agent.'
    )
  }
  return host
}

export function getProvider(providerId: string): ProviderConfig | undefined {
  return requireHost().getProvider(providerId)
}

export function getSettings(): AppSettings {
  return requireHost().getSettings()
}

export function addPermissionRule(rule: PermissionRule): AppSettings {
  return requireHost().addPermissionRule(rule)
}

export function getKey(providerId: string): string | null {
  return requireHost().getKey(providerId)
}

export function hasStoredKey(providerId: string): boolean {
  return requireHost().hasStoredKey(providerId)
}

export function getSecretHeaders(scope: string): Record<string, string> {
  return requireHost().getSecretHeaders(scope)
}

/** All plaintext secret values for redaction, or `[]` if the host can't enumerate them. */
export function collectSecrets(): string[] {
  return requireHost().collectSecrets?.() ?? []
}
