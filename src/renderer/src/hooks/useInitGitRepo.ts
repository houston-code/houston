import { useCallback, useState } from 'react'

/**
 * Shared "initialize a git repo, then reflect the new state" action, used by both
 * the Changes panel's empty-state button and the first-write banner so their init
 * flow and error handling never drift apart. Calls the same `git:init` IPC (a bare
 * `git init` — no commit, idempotent) and, on success, runs the caller's `onSuccess`
 * so each consumer can re-read whatever it shows (the working-tree diff, the
 * repo-state gate that hides the banner, …).
 *
 * `initializing` disables the trigger while the call is in flight; `initError` holds
 * a short human-readable reason when it fails, mirroring the Changes panel's prior
 * inline handling.
 */
export function useInitGitRepo(workspace: string | null): {
  initializing: boolean
  initError: string | null
  initRepo: (onSuccess?: () => void | Promise<void>) => Promise<boolean>
} {
  const [initializing, setInitializing] = useState(false)
  const [initError, setInitError] = useState<string | null>(null)

  const initRepo = useCallback(
    async (onSuccess?: () => void | Promise<void>): Promise<boolean> => {
      if (!workspace) return false
      setInitializing(true)
      setInitError(null)
      try {
        const res = await window.api.initGitRepo(workspace)
        if (res.ok) {
          await onSuccess?.()
          return true
        }
        setInitError(res.error ?? 'Could not initialize the repository.')
        return false
      } catch (e) {
        setInitError((e as Error).message)
        return false
      } finally {
        setInitializing(false)
      }
    },
    [workspace]
  )

  return { initializing, initError, initRepo }
}
