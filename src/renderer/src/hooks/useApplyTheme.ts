import { useEffect } from 'react'
import type { AccentColor } from '@shared/types'
import {
  applyAccent,
  applyAppearance,
  applyTheme,
  rememberTheme,
  rememberedTheme,
  type Appearance,
  type Theme
} from '../lib/theme'

/**
 * Apply `theme` to the document root and keep it in sync with the OS while on
 * `system`. Shared by the app shell (which applies the saved theme) and the
 * Settings modal (which uses it to live-preview the in-progress selection), so
 * preview and the committed state resolve colors identically on every platform.
 *
 * `undefined` means settings haven't loaded yet: the theme cached from the last saved
 * choice (applied by main.tsx before the first paint) stays, rather than flipping to
 * the OS default and back. With `remember` (the app shell, never the preview), each
 * saved theme is cached for the next launch.
 */
export function useApplyTheme(theme: Theme | undefined, { remember = false }: { remember?: boolean } = {}): void {
  useEffect(() => {
    const applied = theme ?? rememberedTheme()
    applyTheme(applied)
    if (remember && theme !== undefined) rememberTheme(theme)
    if (applied !== 'system' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = (): void => applyTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme, remember])
}

/** Apply the accent preset to the document root (app shell and Settings preview). */
export function useApplyAccent(accent: AccentColor | undefined): void {
  useEffect(() => {
    applyAccent(accent)
  }, [accent])
}

/**
 * Apply the chat text size, density and code theme to the document root. Like the
 * theme, shared by the app shell and the Settings modal's live preview.
 */
export function useApplyAppearance({ chatFontSize, density, codeTheme }: Appearance): void {
  useEffect(() => {
    applyAppearance({ chatFontSize, density, codeTheme })
  }, [chatFontSize, density, codeTheme])
}
