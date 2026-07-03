/**
 * Host-injected location of the per-user data directory — the profile holding
 * settings.json, secrets, conversations, logs, and TUI history.
 *
 * The Electron shell wires `app.getPath('userData')` at startup (index.ts, right
 * after `app.setName`); the standalone CLI computes the same per-platform path
 * without Electron (src/cli/paths.ts) so both hosts share one profile. A seam —
 * rather than importing `electron` — keeps every consumer (store, secrets,
 * conversations, logger, window/update state) portable to non-Electron hosts,
 * mirroring the agentHost pattern (see agentHost.ts).
 */

let dir: string | null = null

/** Bind the user-data directory. Call once during startup, before any read/write. */
export function setUserDataDir(d: string): void {
  dir = d
}

/** Reset the wired directory. Test-only — restores a clean, unconfigured state. */
export function resetUserDataDir(): void {
  dir = null
}

export function getUserDataDir(): string {
  if (!dir) {
    throw new Error(
      'User-data directory not configured — call setUserDataDir() during startup before reading or writing app data.'
    )
  }
  return dir
}
