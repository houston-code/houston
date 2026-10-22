import type { TabId } from './pages'

/**
 * Decorative monoline glyph per nav tab. Rendered inside an aria-hidden span so
 * it never alters the button's accessible name (which must stay exactly the tab
 * label). currentColor lets each icon track the idle/hover/active text colour.
 */
export const NAV_ICON: Record<TabId, JSX.Element> = {
  updates: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13.5 8a5.5 5.5 0 11-1.6-3.9M13.5 2v3h-3" />
      <path d="M8 5.5v3l2 1.5" />
    </svg>
  ),
  legal: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 1.5h4.5L12 5v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2.5a1 1 0 011-1z" />
      <path d="M8.5 1.5V5H12M5.5 8h5M5.5 10.5h5M5.5 5.5h1.5" />
    </svg>
  ),
  models: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="8" height="8" rx="1" />
      <path d="M6.5 1.5v2M9.5 1.5v2M6.5 12.5v2M9.5 12.5v2M1.5 6.5h2M1.5 9.5h2M12.5 6.5h2M12.5 9.5h2" />
    </svg>
  ),
  tools: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.5l5 2v3.6c0 3-2.1 5.2-5 6.4-2.9-1.2-5-3.4-5-6.4V3.5l5-2z" />
    </svg>
  ),
  workspace: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 4.5a1 1 0 011-1h3l1.5 1.5h5a1 1 0 011 1v6a1 1 0 01-1 1h-10a1 1 0 01-1-1z" />
    </svg>
  ),
  keyboard: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
      <path d="M4 6.5h0M6.5 6.5h0M9 6.5h0M11.5 6.5h0M4 9h0M11.5 9h0M6 9h4" />
    </svg>
  ),
  appearance: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.05 3.05l1.15 1.15M11.8 11.8l1.15 1.15M12.95 3.05l-1.15 1.15M4.2 11.8l-1.15 1.15" />
    </svg>
  )
}
