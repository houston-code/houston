import { ACCENT_COLORS, type AccentColor, type ChatFontSize, type CodeTheme, type Density } from '@shared/types'

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

/**
 * The theme the user last saved, cached in this machine's local storage. Settings
 * reach the renderer over IPC, after the first paint, so main.tsx applies this one
 * before rendering anything: a light-theme user no longer sees a dark window flash
 * on every launch and new window. Anything unknown (or no storage) is "system".
 */
const THEME_KEY = 'houston.theme'
const THEMES: readonly Theme[] = ['system', 'dark', 'light']

export function rememberedTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v && (THEMES as readonly string[]).includes(v) ? (v as Theme) : 'system'
  } catch {
    return 'system'
  }
}

export function rememberTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    /* storage unavailable: the next launch follows the OS until settings load */
  }
}
