/**
 * What to tell someone when the OS secure store (macOS Keychain, Windows DPAPI, a
 * Linux keyring) can't be used, so credentials can't be saved or read. The common
 * case is macOS after "Deny" on the Keychain prompt: Electron caches that failure for
 * the life of the process, so nothing short of restarting Houston brings the prompt
 * back. Each message says what to do, not just what went wrong.
 */
export function secureStorageUnavailableMessage(platform: string): string {
  switch (platform) {
    case 'darwin':
      return (
        "Houston couldn't use your Keychain to store credentials. This happens when " +
        'Keychain access was denied. Restart Houston and choose Always Allow when macOS asks.'
      )
    case 'linux':
      return (
        'No system keyring is available to store credentials. Unlock or install a keyring ' +
        '(such as GNOME Keyring or KWallet), then restart Houston.'
      )
    default:
      return "Secure storage isn't available to store credentials. Restart Houston and try again."
  }
}

/** Whether the OS secure store is usable now, for the renderer's recovery prompt. */
export interface SecureStorageStatus {
  available: boolean
  platform: string
}
