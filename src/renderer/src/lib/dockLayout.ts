import type { DockTab } from '../components/PreviewDock'

/**
 * The right-hand side panel's remembered tab. Kept in this window's local storage: a
 * per-machine convenience, read back when the panel reopens at launch. The plan review
 * is never remembered, since it only exists while a plan waits for an answer.
 */
const KEY = 'houston.dockTab'
const REMEMBERED: readonly DockTab[] = ['tasks', 'preview', 'files']

export function readDockTab(): DockTab {
  try {
    const v = localStorage.getItem(KEY)
    return v && (REMEMBERED as readonly string[]).includes(v) ? (v as DockTab) : 'preview'
  } catch {
    return 'preview'
  }
}

export function rememberDockTab(tab: DockTab): void {
  if (!REMEMBERED.includes(tab)) return
  try {
    localStorage.setItem(KEY, tab)
  } catch {
    /* storage unavailable: the tab just isn't remembered */
  }
}

export function forgetDockTab(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing to forget */
  }
}

/** Where the side panel was before a plan took it over, to go back once the plan is answered. */
export interface DockState {
  open: boolean
  tab: DockTab
}

/**
 * The side panel after the plan review leaves it (answered or dismissed): back to how
 * it was before the plan opened it. Pure.
 */
export function afterPlan(current: DockState, before: DockState | null): DockState {
  if (current.tab !== 'plan') return current
  if (!before || before.tab === 'plan') return { open: false, tab: 'preview' }
  return before
}
