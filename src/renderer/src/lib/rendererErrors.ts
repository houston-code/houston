/**
 * Send renderer errors to the main-process log, so a crash or a caught render error
 * leaves a line in houston.log instead of only a DevTools message nobody saw. Main
 * checks, caps and rate-limits what arrives (see crashRecovery.ts in main).
 */

type Kind = 'error' | 'unhandledrejection' | 'boundary'

function describe(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) return { message: `${value.name}: ${value.message}`, ...(value.stack ? { stack: value.stack } : {}) }
  if (typeof value === 'string') return { message: value }
  try {
    return { message: JSON.stringify(value) ?? String(value) }
  } catch {
    return { message: String(value) }
  }
}

/** Report one error. Never throws: a failed report must not become a second error. */
export function reportRendererError(kind: Kind, error: unknown, componentStack?: string | null): void {
  try {
    window.api?.reportRendererError?.({
      kind,
      ...describe(error),
      ...(componentStack ? { componentStack } : {})
    })
  } catch {
    // The bridge is gone (the page is unloading); DevTools still has the error.
  }
}

/** Forward uncaught errors and unhandled promise rejections. Call once at startup. */
export function installRendererErrorReporting(target: Window = window): void {
  target.addEventListener('error', (e: ErrorEvent) => {
    reportRendererError('error', e.error ?? e.message)
  })
  target.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    reportRendererError('unhandledrejection', e.reason)
  })
}
