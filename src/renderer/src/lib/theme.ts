import { ACCENT_COLORS, type AccentColor } from '@shared/types'

export type Theme = 'system' | 'dark' | 'light'

/**
 * Apply an accent preset as `data-accent` on the root, which global.css maps to the
 * accent variables. The default (or anything unknown) removes it, leaving the theme's
 * own accent.
 */
export function applyAccent(accent: AccentColor | undefined, root: HTMLElement = document.documentElement): void {
  if (accent && accent !== 'default' && (ACCENT_COLORS as readonly string[]).includes(accent)) {
    root.setAttribute('data-accent', accent)
  } else root.removeAttribute('data-accent')
}

/** Resolve a theme preference to a concrete palette, honoring the OS preference for `system`. */
export function resolveTheme(theme: Theme, prefersLight: boolean): 'dark' | 'light' {
  if (theme === 'light') return 'light'
  if (theme === 'dark') return 'dark'
  return prefersLight ? 'light' : 'dark'
}

/** Whether the OS currently prefers a light color scheme. */
export function osPrefersLight(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)').matches
    : false
}

/** Apply the resolved theme to the document root (drives the CSS variable palette). */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = resolveTheme(theme, osPrefersLight())
}
