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

/** The title of the page the current section opens, when it is the page's first. */
const OpeningPageContext = createContext<string | null>(null)

/**
 * Whether a section's title only repeats the page title right above it ("Hooks" under
 * "Hooks"). SettingsSection then keeps its heading for screen readers and settings
 * search but doesn't show it a second time.
 */
export function useRepeatsPageTitle(title: string): boolean {
  const page = useContext(OpeningPageContext)
  const norm = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim()
  return page !== null && norm(page) === norm(title)
}

/**
 * Renders one section and tells its header whether the preferences it sets differ
 * from Houston's defaults, with a Reset that restores them (saved like any change,
 * so it can be undone), and whether its title just repeats the page's.
 */
export function SectionFrame({
  entry,
  ctx,
  openingPage = null
}: {
  entry: SectionEntry
  ctx: SettingsCtx
  /** The page's title when this section is the first under it. */
  openingPage?: string | null
}): JSX.Element {
  const { Component, keys } = entry
  const meta: SectionMeta | null = keys
    ? {
        modified: isModified(ctx.settings, keys),
        onReset: () => ctx.setSettings((s) => resetPreferences(s, keys))
      }
    : null
  return (
    <SectionMetaContext.Provider value={meta}>
      <OpeningPageContext.Provider value={openingPage}>
        <Component ctx={ctx} />
      </OpeningPageContext.Provider>
    </SectionMetaContext.Provider>
  )
}
