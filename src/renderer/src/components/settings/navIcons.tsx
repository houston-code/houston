import type { TabId } from './pages'

/** Shared stroke attributes for the 16px monoline nav glyphs. */
const svg = {
  viewBox: '0 0 16 16',
  width: 16,
  height: 16,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

/**
 * Decorative monoline glyph per nav tab. Rendered inside an aria-hidden span so
 * it never alters the button's accessible name (which must stay exactly the tab
 * label). currentColor lets each icon track the idle/hover/active text colour.
 */
export const NAV_ICON: Record<TabId, JSX.Element> = {
  models: (
    <svg {...svg}>
      <rect x="4" y="4" width="8" height="8" rx="1" />
      <path d="M6.5 1.5v2M9.5 1.5v2M6.5 12.5v2M9.5 12.5v2M1.5 6.5h2M1.5 9.5h2M12.5 6.5h2M12.5 9.5h2" />
    </svg>
  ),
  agent: (
    <svg {...svg}>
      <path d="M2 4h7M2 8h4M2 12h7" />
      <circle cx="11.5" cy="4" r="1.5" />
      <circle cx="8.5" cy="8" r="1.5" />
      <circle cx="11.5" cy="12" r="1.5" />
      <path d="M13 4h1M10 8h4M13 12h1" />
    </svg>
  ),
  tools: (
    <svg {...svg}>
      <path d="M10.2 2.2a3.2 3.2 0 00-3.8 4.3L2 10.9 3.1 14l3.1-.1 4.4-4.4a3.2 3.2 0 004.3-3.8l-2 2-2.1-.6-.6-2.1z" />
    </svg>
  ),
  mcp: (
    <svg {...svg}>
      <path d="M6 1.5v3M10 1.5v3M4.5 4.5h7v3a3.5 3.5 0 01-7 0zM8 11v3.5" />
    </svg>
  ),
  hooks: (
    <svg {...svg}>
      <path d="M8 1.5v7a3 3 0 11-3-3" />
      <path d="M6.5 3L8 1.5 9.5 3" />
    </svg>
  ),
  workspace: (
    <svg {...svg}>
      <path d="M1.5 4.5a1 1 0 011-1h3l1.5 1.5h5a1 1 0 011 1v6a1 1 0 01-1 1h-10a1 1 0 01-1-1z" />
    </svg>
  ),
  general: (
    <svg {...svg}>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
    </svg>
  ),
  appearance: (
    <svg {...svg}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 2a6 6 0 000 12z" fill="currentColor" />
    </svg>
  ),
  keyboard: (
    <svg {...svg}>
      <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
      <path d="M4 6.5h0M6.5 6.5h0M9 6.5h0M11.5 6.5h0M4 9h0M11.5 9h0M6 9h4" />
    </svg>
  ),
  permissions: (
    <svg {...svg}>
      <path d="M8 1.5l5 2v3.6c0 3-2.1 5.2-5 6.4-2.9-1.2-5-3.4-5-6.4V3.5l5-2z" />
    </svg>
  ),
  about: (
    <svg {...svg}>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 7.2v4M8 4.8h0" />
    </svg>
  )
}
