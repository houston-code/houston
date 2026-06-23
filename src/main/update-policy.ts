/**
 * Pure decision for whether the auto-updater should run. Kept free of Electron
 * imports so it can be unit-tested without the Electron runtime.
 */
export function shouldAutoUpdate(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  // Never check for updates in dev/test (unpackaged), and allow an explicit opt-out.
  if (env.HOUSTON_DISABLE_UPDATER === '1') return false
  return isPackaged
}
