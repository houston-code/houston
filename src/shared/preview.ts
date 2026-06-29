/**
 * Shared types for the live Preview dock — used by main (preview pane manager +
 * IPC), preload, and the renderer so all three agree on the wire shape.
 */

/** A dev server the agent started (a `run_shell` background process) that the dock can preview. */
export interface PreviewServer {
  /** The background-shell id — a stable key for this started server. */
  id: string
  /** The command that started it (shown as the pane's label). */
  command: string
  /** False once the process has exited. */
  running: boolean
  /** The loopback URL detected in the server's output, if one was found yet. */
  url?: string
}

/** Integer rectangle in the window's content coordinate space (device-independent px). */
export interface PreviewPaneBounds {
  x: number
  y: number
  width: number
  height: number
}

/** One pane the renderer wants painted: a stable id, the loopback URL, and where. */
export interface PreviewPaneSpec {
  id: string
  url: string
  bounds: PreviewPaneBounds
}

/** Hard cap on simultaneously-rendered preview panes. */
export const MAX_PREVIEW_PANES = 3
