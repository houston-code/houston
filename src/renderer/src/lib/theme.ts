import type { ChatFontSize, CodeTheme, Density } from '@shared/types'

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

export interface Appearance {
  chatFontSize?: ChatFontSize
  density?: Density
  codeTheme?: CodeTheme
}

const CHAT_FONT_SIZES: readonly ChatFontSize[] = ['small', 'default', 'large']
const DENSITIES: readonly Density[] = ['comfortable', 'compact']
const CODE_THEMES: readonly CodeTheme[] = ['default', 'contrast', 'muted']

/**
 * Apply the appearance options as root attributes (`data-chat-size`, `data-density`,
 * `data-code-theme`), which global.css maps to CSS variables. A default or unknown
 * value removes its attribute, so the defaults are exactly the app's original look.
 */
export function applyAppearance(a: Appearance, root: HTMLElement = document.documentElement): void {
  const set = (attr: string, value: string | undefined, allowed: readonly string[], fallback: string): void => {
    if (value && value !== fallback && allowed.includes(value)) root.setAttribute(attr, value)
    else root.removeAttribute(attr)
  }
  set('data-chat-size', a.chatFontSize, CHAT_FONT_SIZES, 'default')
  set('data-density', a.density, DENSITIES, 'comfortable')
  set('data-code-theme', a.codeTheme, CODE_THEMES, 'default')
}

/** Apply the resolved theme to the document root (drives the CSS variable palette). */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = resolveTheme(theme, osPrefersLight())
}
