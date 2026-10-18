import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { restartTips, type OnboardingState } from '@shared/onboarding'

/** A new onboarding state, or a function deriving it from the latest one. */
export type OnboardingChange = OnboardingState | ((prev: OnboardingState) => OnboardingState)

/**
 * Persisted onboarding progress plus the transient "tour requested" flag.
 *
 * Changes are functional and applied to the latest state (not the one captured at the
 * caller's last render), so two quick changes compose instead of one dropping the
 * other. The UI updates at once; saves run one at a time and each writes the newest
 * state, so a slow earlier save can never land on top of a later change. The app's
 * settings copy is patched too, so anything that saves the whole settings object
 * (the Settings modal) carries the current onboarding state rather than a stale one.
 */
export function useOnboarding(opts: {
  settings: AppSettings | null
  setSettings: (fn: (s: AppSettings | null) => AppSettings | null) => void
  /** Conversations have loaded at least once (so "none" is real, not "not yet"). */
  conversationsLoaded: boolean
  hasConversation: boolean
}): {
  state: OnboardingState
  update: (change: OnboardingChange) => void
  touring: boolean
  startTour: () => void
  endTour: () => void
} {
  const { settings, setSettings, conversationsLoaded, hasConversation } = opts
  const loaded = settings !== null
  const persisted = settings?.onboarding
  const [state, setState] = useState<OnboardingState>({})
  const latest = useRef<OnboardingState | null>(null)
  const saving = useRef<Promise<void>>(Promise.resolve())
  const [touring, setTouring] = useState(false)

  // Adopt the persisted state once, when settings first load. After that this hook
  // owns it: a settings object fetched from main mid-save must not roll it back.
  useEffect(() => {
    if (!loaded || latest.current !== null) return
    latest.current = persisted ?? {}
    setState(latest.current)
  }, [loaded, persisted])

  const update = useCallback(
    (change: OnboardingChange) => {
      const prev = latest.current ?? {}
      const next = typeof change === 'function' ? change(prev) : change
      latest.current = next
      setState(next)
      setSettings((s) => (s ? { ...s, onboarding: next } : s))
      saving.current = saving.current
        .then(async () => {
          const current = await window.api.getSettings()
          await window.api.saveSettings({ ...current, onboarding: latest.current ?? next })
        })
        .catch(() => {
          // Best effort: losing an onboarding flag only means a tip may show again.
        })
    },
    [setSettings]
  )

  // Anyone who has sent a task is past the checklist. Latch it, so deleting every
  // chat later doesn't bring the checklist back.
  const checklistDone = state.checklistDone === true
  useEffect(() => {
    if (loaded && conversationsLoaded && hasConversation && !checklistDone) {
      update((s) => ({ ...s, checklistDone: true }))
    }
  }, [loaded, conversationsLoaded, hasConversation, checklistDone, update])

  const startTour = useCallback(() => {
    update(restartTips)
    setTouring(true)
  }, [update])

  const endTour = useCallback(() => setTouring(false), [])

  // Until the persisted state is adopted, read it directly so the first render after
  // settings load doesn't briefly treat an existing install as a fresh one.
  const current = latest.current === null ? (persisted ?? {}) : state
  return { state: current, update, touring, startTour, endTour }
}
