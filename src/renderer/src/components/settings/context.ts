import type { Dispatch, SetStateAction } from 'react'
import type { AppSettings } from '@shared/types'

/**
 * What every settings section reads and writes. The shell owns the working copy
 * of the settings and the cross-section state (the shared busy flag, the key
 * inputs both the provider and web-search sections use, the footer error); a
 * section keeps anything only it needs (a filter, a fetched status) to itself.
 */
export interface SettingsCtx {
  settings: AppSettings
  setSettings: Dispatch<SetStateAction<AppSettings>>
  /** The in-flight action's key (a provider id, `mcp-oauth:<id>`), or null. */
  busy: string | null
  setBusy: (busy: string | null) => void
  /** Unsaved API-key text per provider/search key id. */
  keyInputs: Record<string, string>
  setKeyInputs: Dispatch<SetStateAction<Record<string, string>>>
  /** Show an error in the footer (null clears it). */
  setFormError: (error: string | null) => void
  /** Store an API key in the OS secret store (never in settings.json). */
  saveKey: (id: string) => Promise<void>
  removeKey: (id: string) => Promise<void>
  /**
   * Persist the working copy now. For actions main performs against the saved
   * settings (fetching a provider's models, MCP OAuth), which must see the edits.
   */
  persistNow: () => Promise<void>
  /** Open the local-only per-model loop scorecard. */
  onShowScorecard?: () => void
}

/** One settings section: a self-contained `SettingsSection` (or nothing). */
export type SectionComponent = (props: { ctx: SettingsCtx }) => JSX.Element | null
