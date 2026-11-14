import type { AppSettings } from '@shared/types'

/**
 * A chat window's native background: what shows before the renderer's first paint and
 * in the strip a live resize uncovers before it repaints. It is the page's own --bg for
 * the palette the renderer will paint (global.css; windowBackground.test.ts keeps the
 * two in step), so a launch, a new window or a resize never flashes the other theme.
 */
export const WINDOW_BACKGROUND = { dark: '#0a0a0b', light: '#faf9f6' } as const

/**
 * The background for a saved theme. "system" (or a theme not known yet, before settings
 * can be read) follows the OS appearance, as the renderer does.
 */
export function windowBackground(theme: AppSettings['theme'], osPrefersDark: boolean): string {
  const palette = theme === 'dark' || theme === 'light' ? theme : osPrefersDark ? 'dark' : 'light'
  return WINDOW_BACKGROUND[palette]
}
