import { createContext, useContext } from 'react'
import { isModified, resetPreferences } from '@shared/settingsPortable'
import type { SettingsCtx } from './context'
import type { SectionEntry } from './pages'

/** What a section's header shows beyond its title: whether it differs from the defaults. */
interface SectionMeta {
  modified: boolean
  onReset: () => void
}

const SectionMetaContext = createContext<SectionMeta | null>(null)

/** The current section's Modified state, for SettingsSection's header (null outside a frame). */
export function useSectionMeta(): SectionMeta | null {
  return useContext(SectionMetaContext)
}

/**
 * Renders one section and tells its header whether the preferences it sets differ
 * from Houston's defaults, with a Reset that restores them (saved like any change,
 * so it can be undone).
 */
export function SectionFrame({ entry, ctx }: { entry: SectionEntry; ctx: SettingsCtx }): JSX.Element {
  const { Component, keys } = entry
  const meta: SectionMeta | null = keys
    ? {
        modified: isModified(ctx.settings, keys),
        onReset: () => ctx.setSettings((s) => resetPreferences(s, keys))
      }
    : null
  return (
    <SectionMetaContext.Provider value={meta}>
      <Component ctx={ctx} />
    </SectionMetaContext.Provider>
  )
}
