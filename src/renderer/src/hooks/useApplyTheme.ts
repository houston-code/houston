import { useEffect } from 'react'
import { applyTheme, type Theme } from '../lib/theme'

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
