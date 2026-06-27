import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { ITheme } from '@xterm/xterm'

/** Read the current palette from the app's CSS variables so the terminal matches
 * the active (dark/light) theme. */
function themeFromCss(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback
  return {
    background: v('--bg-code', '#08090b'),
    foreground: v('--text', '#e8e9ec'),
    cursor: v('--accent', '#4f8cff'),
    cursorAccent: v('--bg-code', '#08090b'),
    selectionBackground: v('--bg-hover', '#1d1e23')
  }
}

/**
 * One xterm.js instance bound to a main-process PTY by `id`. The instance is
 * created once and kept alive for the tab's lifetime; background tabs stay
 * mounted (hidden by the parent) so their scrollback and live output survive a
 * tab switch. When this tab becomes active again it refits to the panel size.
 */
export function TerminalView({ id, active }: { id: string; active: boolean }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() ||
        'ui-monospace, monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: themeFromCss(),
      scrollback: 10_000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    const safeFit = (): void => {
      // FitAddon needs real dimensions; a hidden (display:none) tab has none.
      if (host.offsetParent === null) return
      try {
        fit.fit()
        void window.api.resizeTerminal(id, term.cols, term.rows)
      } catch {
        /* layout not settled yet — the ResizeObserver will fire again */
      }
    }
    safeFit()

    // Forward keystrokes / pasted text to the PTY.
    const dataSub = term.onData((data) => void window.api.writeTerminal(id, data))
    // Stream PTY output to this view (filtered to our id).
    const unsubscribe = window.api.onTerminalData((payload) => {
      if (payload.id === id) term.write(payload.data)
    })

    const ro = new ResizeObserver(() => safeFit())
    ro.observe(host)

    // Track theme changes (data-theme flips on documentElement).
    const themeObserver = new MutationObserver(() => {
      term.options.theme = themeFromCss()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })

    return () => {
      dataSub.dispose()
      unsubscribe()
      ro.disconnect()
      themeObserver.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [id])

  // When this tab becomes active, the panel may have resized while it was hidden —
  // refit and focus it.
  useEffect(() => {
    if (!active) return
    const term = termRef.current
    const fit = fitRef.current
    const host = hostRef.current
    if (!term || !fit || !host || host.offsetParent === null) return
    try {
      fit.fit()
      void window.api.resizeTerminal(id, term.cols, term.rows)
    } catch {
      /* ignore */
    }
    term.focus()
  }, [active, id])

  return <div className="terminal-view" ref={hostRef} />
}
