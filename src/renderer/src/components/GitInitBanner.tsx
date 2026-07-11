import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { useInitGitRepo } from '../hooks/useInitGitRepo'
import { Icon } from './Icon'

/** Repo signals the banner cares about (a subset of RepoInfo). */
interface RepoState {
  /** Whether the workspace path still exists on disk. */
  exists: boolean
  /** Whether it's inside a git repo already. */
  isRepo: boolean
}

/**
 * A non-blocking inline banner that offers to `git init` a workspace the first time
 * the agent writes a file into it while it isn't a git repository. Left unversioned,
 * a one-shot build is invisible in the Changes panel until the user happens to open
 * it — this catches that the moment the first write lands, without gating the run or
 * stealing focus from the composer.
 *
 * Detection reuses existing signals only: `writeHappened` (any transcript tool with
 * `toolKind === 'write'`, derived by the caller) and `getRepoInfo` for repo state.
 * It shows only for an existing non-repo the user hasn't opted out of; once the
 * folder becomes a repo (via this banner, the Changes panel, or externally) the
 * re-check flips `isRepo` true and the banner disappears on its own.
 *
 * Actions all reuse existing IPC via {@link useInitGitRepo} and the git-init-dismiss
 * bridge: initialize (accent), "Not now" (session-only, held by the caller), and a
 * "Don't ask again for this folder" checkbox that persists the opt-out.
 */
export function GitInitBanner({
  workspace,
  writeHappened,
  running,
  sessionDismissed,
  onNotNow,
  onDismissed,
  recheckSignal = 0
}: {
  /** The active chat's workspace, or null when there is none. */
  workspace: string | null
  /** True once this chat has ≥1 write tool call (a boolean, not a count). */
  writeHappened: boolean
  /** Whether a run is in progress — used to re-check repo state when it finishes. */
  running: boolean
  /** Whether the user chose "Not now" for this workspace this session (held by the caller). */
  sessionDismissed: boolean
  /** Called when the user picks "Not now" (session-only dismissal). */
  onNotNow: () => void
  /**
   * Called with the fresh settings after the user opts out ("Don't ask again"), so the
   * caller can keep its own settings copy in sync. Without this, a later wholesale
   * settings save (e.g. the Settings modal, seeded from the caller's stale copy) would
   * silently drop the just-persisted opt-out.
   */
  onDismissed?: (settings: AppSettings) => void
  /**
   * Bumped by the caller when something in-app may have changed repo state without a
   * window-focus event — e.g. the Changes panel closing after its own "Initialize git
   * repository" — so the banner re-checks and clears itself. Focus/run-finish cover
   * the external cases.
   */
  recheckSignal?: number
}): JSX.Element | null {
  const [repo, setRepo] = useState<RepoState | null>(null)
  // null = not yet known (still loading); avoids a flash before the check resolves.
  const [suppressed, setSuppressed] = useState<boolean | null>(null)
  const { initializing, initError, initRepo } = useInitGitRepo(workspace)

  const wsRef = useRef(workspace)
  wsRef.current = workspace

  // Fetch repo state + the persisted opt-out together. Guarded against a workspace
  // switch landing mid-flight so a stale result can't drive the wrong banner.
  const refresh = useCallback(async (): Promise<void> => {
    const ws = wsRef.current
    if (!ws) {
      setRepo(null)
      setSuppressed(null)
      return
    }
    try {
      const [info, dismissed] = await Promise.all([
        window.api.getRepoInfo(ws),
        window.api.isGitInitDismissed(ws)
      ])
      if (wsRef.current !== ws) return
      setRepo({ exists: info.exists, isRepo: info.isRepo })
      setSuppressed(dismissed)
    } catch {
      // Non-fatal — leave the banner hidden rather than risk prompting on bad data.
    }
  }, [])

  // Only reach for repo state once a write has actually happened (and the workspace
  // isn't already dismissed this session): no write, no IPC, no banner.
  const active = !!workspace && writeHappened && !sessionDismissed
  useEffect(() => {
    if (active) void refresh()
    else {
      setRepo(null)
      setSuppressed(null)
    }
  }, [active, workspace, refresh])

  // Re-check when a run finishes (writes land during the run) — but only while active.
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running && active) void refresh()
    wasRunning.current = running
  }, [running, active, refresh])

  // Catch a repo initialized outside the app while we were in the background, so the
  // banner clears itself.
  useEffect(() => {
    if (!active) return
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [active, refresh])

  // Re-check on an in-app signal (e.g. the Changes panel just closed after its own
  // init) that focus/run-finish wouldn't catch. Skips the initial value so it doesn't
  // double up with the mount fetch.
  const recheckRef = useRef(recheckSignal)
  useEffect(() => {
    if (recheckRef.current === recheckSignal) return
    recheckRef.current = recheckSignal
    if (active) void refresh()
  }, [recheckSignal, active, refresh])

  const onInitialize = useCallback((): void => {
    // On success, re-read repo state → isRepo flips true → this banner unmounts.
    void initRepo(refresh)
  }, [initRepo, refresh])

  const onDontAskAgain = useCallback((): void => {
    if (!workspace) return
    setSuppressed(true) // hide immediately; persistence follows.
    void window.api.dismissGitInit(workspace).then((next) => onDismissed?.(next))
  }, [workspace, onDismissed])

  // Gate: an existing non-repo, after a write, not dismissed this session, and not
  // opted out. `suppressed !== false` covers both still-loading (null) and opted-out.
  if (!active || suppressed !== false || !repo || !repo.exists || repo.isRepo) {
    return null
  }

  return (
    <section
      className="git-init-banner"
      role="region"
      aria-labelledby="git-init-banner-title"
    >
      <span className="git-init-banner__icon" aria-hidden="true">
        <Icon name="gitBranch" size={16} />
      </span>
      <div className="git-init-banner__body">
        <p className="git-init-banner__title" id="git-init-banner-title">
          This folder isn’t a git repository
        </p>
        <p className="git-init-banner__text">
          Initialize one so you can review, undo, and turn what Houston builds into a PR.
          Nothing is committed — your files just become visible in Changes.
        </p>
        {initError && (
          <p className="git-init-banner__error" role="alert">
            {initError}
          </p>
        )}
        <div className="git-init-banner__actions">
          <button
            type="button"
            className="btn btn--sm btn--accent"
            onClick={onInitialize}
            disabled={initializing}
          >
            {initializing ? 'Initializing…' : 'Initialize repository'}
          </button>
          <button type="button" className="btn btn--sm" onClick={onNotNow}>
            Not now
          </button>
          <label className="git-init-banner__dontask">
            <input type="checkbox" checked={false} onChange={onDontAskAgain} />
            Don’t ask again for this folder
          </label>
        </div>
      </div>
    </section>
  )
}
