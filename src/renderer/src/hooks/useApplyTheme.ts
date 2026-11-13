import { useEffect } from 'react'
import { applyAppearance, applyTheme, type Appearance, type Theme } from '../lib/theme'

/**
 * Apply `theme` to the document root and keep it in sync with the OS while on
 * `system`. Shared by the app shell (which applies the saved theme) and the
 * Settings modal (which uses it to live-preview the in-progress selection), so
 * preview and the committed state resolve colors identically on every platform.
 */
export function useApplyTheme(theme: Theme): void {
  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = (): void => applyTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])
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
