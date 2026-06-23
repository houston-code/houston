export type Theme = 'system' | 'dark' | 'light'

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
