import type { MockupVariant } from '@shared/mockup'

/**
 * The seam between the `render_mockup` tool and the offscreen browser that renders
 * it. The Electron shell wires the real backend at startup (`mockupCapture.ts`,
 * via {@link setMockupBackend}), so this module, and the agent loop importing it,
 * stays free of `electron` and the tool is simply not offered where nothing is wired
 * (the standalone CLI). Tests inject a fake through the tool context instead.
 */

export interface MockupRenderInput {
  /** Realpath of the root the file lives in; the page may load files from here only. */
  root: string
  /** Realpath of the HTML file, inside `root`. */
  file: string
  variants: MockupVariant[]
  signal?: AbortSignal
}

export interface MockupRender {
  /** PNG bytes. The caller enforces the attach size cap. */
  png: Buffer
  width: number
  height: number
  /** Console output while the page loaded, formatted "LEVEL: text". */
  console: string[]
  /** A non-fatal load problem; a screenshot is still captured. */
  loadError?: string
  /** True when a full-page capture was cut at MAX_FULL_PAGE_HEIGHT. */
  truncated?: boolean
}

export type RenderMockup = (input: MockupRenderInput) => Promise<MockupRender[]>

let backend: RenderMockup | null = null

/** Wire the real (Electron) renderer. Call once during startup. */
export function setMockupBackend(render: RenderMockup): void {
  backend = render
}

/** Test-only: clear the wired backend. */
export function resetMockupBackend(): void {
  backend = null
}

/** Whether a renderer is wired: only the Electron shell wires one. */
export function isMockupBackendConfigured(): boolean {
  return backend !== null
}

/** The wired renderer, for the loop to hand the tool. */
export function mockupBackend(): RenderMockup | null {
  return backend
}
