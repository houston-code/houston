/**
 * Pure decision for whether the auto-updater should run. Kept free of Electron
 * imports so it can be unit-tested without the Electron runtime.
 */
export function shouldAutoUpdate(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  // Never check for updates in dev/test (unpackaged), and allow an explicit opt-out.
  if (env.HOUSTON_DISABLE_UPDATER === '1') return false
  return isPackaged
}

/**
 * Whether the updater may auto-download and install an update in place, vs. only
 * surfacing a manual-download banner.
 *
 * Safe ONLY where the build is code-signed + notarized, so electron-updater can
 * verify the downloaded package against the running app before replacing it. Auto-
 * installing an unverifiable package would turn the update feed into a remote-code-
 * execution boundary. Today only macOS is signed + notarized; Windows (pending an
 * Authenticode cert) and Linux stay on the manual-download path until they are too.
 */
export function shouldAutoInstallUpdates(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin'
}

/**
 * Whether to show the post-restart "What's new" popup.
 *
 * True only when we've recorded a *previous* version that differs from the one
 * now running — i.e. the app was updated and relaunched. A first-ever run
 * (no recorded version) is a fresh install, not an update, so it returns false.
 * The caller additionally gates on having authored highlights for `current`.
 *
 * Detection is version-bump based rather than tied to the auto-installer, so it
 * fires for manually-installed DMGs too (the current unsigned distribution path).
 * A downgrade also differs; in practice that doesn't happen, and the highlights
 * gate makes a stray match harmless.
 */
export function shouldShowWhatsNew(lastSeen: string | null, current: string): boolean {
  return lastSeen !== null && lastSeen !== current
}
