import type { WebContents } from 'electron'

/**
 * A DevTools protocol connection to an offscreen page, shared by the two capture
 * backends (`view_localhost` variants, `render_mockup`). They need it for what
 * Electron has no per-window API for: a forced color scheme, mobile emulation, and
 * full-page screenshots.
 *
 * Attach only to a window that has loaded a document (`about:blank` is enough):
 * attached to one that never loaded, the first command hangs and the next one
 * crashes the app. Every command has a timeout, so a wedged page fails the capture
 * instead of hanging the run.
 */

/** Longest any one DevTools command may take before the capture is abandoned. */
export const CDP_TIMEOUT_MS = 10_000

export interface Cdp {
  send(method: string, params?: object): Promise<unknown>
  /** Listen for protocol events (e.g. `Page.javascriptDialogOpening`). */
  on(listener: (method: string, params: Record<string, unknown>) => void): void
  detach(): void
}

export function attachCdp(wc: WebContents): Cdp {
  const dbg = wc.debugger
  if (!dbg.isAttached()) dbg.attach('1.3')
  return {
    send(method, params) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`The page did not answer ${method} within ${CDP_TIMEOUT_MS}ms.`)),
          CDP_TIMEOUT_MS
        )
      })
      return Promise.race([dbg.sendCommand(method, params), timeout]).finally(() => clearTimeout(timer))
    },
    on(listener) {
      dbg.on('message', (_event, method, params) => listener(method, (params ?? {}) as Record<string, unknown>))
    },
    detach() {
      try {
        if (dbg.isAttached()) dbg.detach()
      } catch {
        /* the window is already gone */
      }
    }
  }
}

/** Emulate a viewport and color scheme on the attached page. */
export async function emulateViewport(
  cdp: Cdp,
  v: { width: number; height: number; mobile: boolean; colorScheme: 'light' | 'dark' }
): Promise<void> {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: v.width,
    height: v.height,
    deviceScaleFactor: 1,
    mobile: v.mobile
  })
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v.colorScheme }] })
}

/** PNG of the viewport, or of `clip` within it, as the emulated page renders it. */
export async function cdpScreenshot(
  cdp: Cdp,
  clip?: { x: number; y: number; width: number; height: number }
): Promise<Buffer> {
  const shot = (await cdp.send('Page.captureScreenshot', {
    format: 'png',
    ...(clip ? { clip: { ...clip, scale: 1 } } : {})
  })) as { data: string }
  return Buffer.from(shot.data, 'base64')
}

/** PNG of the whole page height, cut at `maxHeight`. */
export async function cdpFullPage(
  cdp: Cdp,
  width: number,
  viewportHeight: number,
  maxHeight: number
): Promise<{ png: Buffer; height: number; truncated: boolean }> {
  const metrics = (await cdp.send('Page.getLayoutMetrics')) as { cssContentSize?: { height: number } }
  const content = Math.ceil(metrics.cssContentSize?.height ?? viewportHeight)
  const height = Math.max(viewportHeight, Math.min(content, maxHeight))
  const shot = (await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height, scale: 1 }
  })) as { data: string }
  return { png: Buffer.from(shot.data, 'base64'), height, truncated: content > maxHeight }
}
