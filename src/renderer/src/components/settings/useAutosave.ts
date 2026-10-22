import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { AppSettings } from '@shared/types'

/** Derived fields main recomputes on every read; never an edit of the user's. */
function comparable(s: AppSettings): AppSettings {
  return {
    ...s,
    providers: s.providers.map((p) => ({ ...p, hasKey: false })),
    searchKeyStatus: undefined
  }
}

/**
 * The top-level settings that differ between `base` and `next`, as a patch (a key
 * removed in `next` maps to undefined), or null when nothing the user edits differs.
 * Saving a patch over a fresh read of the stored settings, rather than the whole
 * working copy, keeps a change made elsewhere meanwhile (a rule the agent saved from
 * an approval prompt, a trust decision) from being overwritten by a stale copy.
 */
export function settingsPatch(base: AppSettings, next: AppSettings): Partial<AppSettings> | null {
  const a = comparable(base) as unknown as Record<string, unknown>
  const b = comparable(next) as unknown as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  let any = false
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      patch[k] = (next as unknown as Record<string, unknown>)[k]
      any = true
    }
  }
  return any ? (patch as Partial<AppSettings>) : null
}

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

/** A text field where an edit is still being typed (its value commits when it loses focus). */
function isTypingIn(container: HTMLElement | null): boolean {
  const el = document.activeElement
  if (!container || !(el instanceof HTMLElement) || !container.contains(el)) return false
  if (el instanceof HTMLTextAreaElement) return true
  return el instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'button', 'submit', 'color'].includes(el.type)
}

/**
 * Save settings as they change, the way an OS settings panel does, instead of
 * behind a Save button:
 *
 * - A toggle, a choice, a reorder, or a removal saves right away (after a short
 *   debounce that folds a burst of clicks into one write).
 * - A text field saves when it loses focus, never mid-word: a permission pattern
 *   or a hook command half-typed is not a setting anyone chose, and `*` typed
 *   first would briefly allow everything.
 * - Each save remembers what it replaced, so the change can be undone once.
 * - Anything still pending is saved when Settings closes.
 */
export function useAutosave({
  settings,
  setSettings,
  initial,
  containerRef,
  onSaved,
  onError,
  delayMs = 250
}: {
  settings: AppSettings
  setSettings: (s: AppSettings) => void
  initial: AppSettings
  /** Where the editable fields live; focus inside one of its text fields defers the save. */
  containerRef: RefObject<HTMLElement | null>
  onSaved: (fresh: AppSettings) => void
  onError: (message: string) => void
  delayMs?: number
}): { status: SaveStatus; flush: () => Promise<void>; undo: (() => void) | null } {
  const [status, setStatus] = useState<SaveStatus>('idle')
  // What is stored, as this panel last wrote or read it.
  const baseline = useRef(initial)
  const working = useRef(settings)
  working.current = settings
  // The stored settings the last save replaced, for a one-step undo.
  const [undoTo, setUndoTo] = useState<AppSettings | null>(null)
  // Bumped when a field loses focus or a save lands, to re-check what is pending.
  const [tick, setTick] = useState(0)
  const inFlight = useRef<Promise<void> | null>(null)
  // Set while an undo is being saved, so that save offers no undo of its own.
  const undoing = useRef(false)
  // The patch whose save last failed: not retried until the settings change again,
  // so a persistent failure (a read-only disk) can't spin in a save loop.
  const failed = useRef<string | null>(null)
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const flush = useCallback(async (): Promise<void> => {
    if (inFlight.current) await inFlight.current
    const next = working.current
    const patch = settingsPatch(baseline.current, next)
    if (!patch) return
    const replaced = baseline.current
    setStatus('saving')
    const run = (async () => {
      try {
        const current = await window.api.getSettings()
        const merged: Record<string, unknown> = { ...current, ...patch }
        // A setting removed here (e.g. back to automatic) is removed, not stored as undefined.
        for (const [k, v] of Object.entries(patch)) if (v === undefined) delete merged[k]
        const fresh = await window.api.saveSettings(merged as unknown as AppSettings)
        failed.current = null
        baseline.current = next
        setUndoTo(undoing.current ? null : replaced)
        undoing.current = false
        setStatus('saved')
        onSavedRef.current(fresh)
      } catch (e) {
        failed.current = JSON.stringify(patch)
        setStatus('error')
        onErrorRef.current(`Could not save settings: ${(e as Error).message}`)
      } finally {
        inFlight.current = null
        setTick((t) => t + 1)
      }
    })()
    inFlight.current = run
    await run
  }, [])

  useEffect(() => {
    const patch = settingsPatch(baseline.current, settings)
    if (!patch || JSON.stringify(patch) === failed.current) return
    setStatus((s) => (s === 'saving' ? s : 'pending'))
    if (isTypingIn(containerRef.current)) return
    const timer = setTimeout(() => void flush(), delayMs)
    return () => clearTimeout(timer)
  }, [settings, tick, flush, containerRef, delayMs])

  // A text field losing focus is when its edit is done.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onFocusOut = (): void => setTick((t) => t + 1)
    el.addEventListener('focusout', onFocusOut)
    return () => el.removeEventListener('focusout', onFocusOut)
  }, [containerRef])

  // Closing Settings saves whatever is still pending.
  useEffect(() => () => void flush(), [flush])

  const undo = undoTo
    ? (): void => {
        setUndoTo(null)
        undoing.current = true
        setSettings(undoTo)
      }
    : null
  return { status, flush, undo }
}
