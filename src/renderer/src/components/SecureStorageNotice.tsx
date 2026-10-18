import { useState } from 'react'
import { secureStorageUnavailableMessage } from '@shared/secureStorage'

/**
 * Shown when a key can't be saved because the OS secure store is unusable. On macOS
 * that's usually a denied Keychain prompt, which Electron remembers until the app
 * restarts, so the way out is a restart: this offers one, and says what to choose
 * when macOS asks again.
 */
export function SecureStorageNotice({ platform }: { platform: string }): JSX.Element {
  const [restarting, setRestarting] = useState(false)
  const restart = async (): Promise<void> => {
    setRestarting(true)
    // False means the user chose to keep running work; leave the button usable.
    if (!(await window.api.relaunchApp().catch(() => false))) setRestarting(false)
  }
  return (
    <div className="secure-storage-notice" role="alert">
      <span className="secure-storage-notice__text">{secureStorageUnavailableMessage(platform)}</span>
      <button
        type="button"
        className="btn btn--sm btn--accent"
        onClick={() => void restart()}
        disabled={restarting}
      >
        {restarting ? 'Restarting…' : 'Restart Houston'}
      </button>
    </div>
  )
}

/**
 * After a credential save fails: the platform when the secure store is the cause (so
 * the caller shows the notice above), or null when it's some other failure.
 */
export async function secureStorageBlocked(): Promise<string | null> {
  try {
    const status = await window.api.getSecureStorageStatus()
    return status.available ? null : status.platform
  } catch {
    return null
  }
}
