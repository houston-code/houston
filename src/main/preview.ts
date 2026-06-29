/**
 * Live preview panes for the renderer's Preview dock.
 *
 * The dock shows the dev servers the agent started (a `run_shell` background
 * process whose loopback URL we sniffed — see agent/shells.ts) as live, scrollable
 * pages. Unlike `view_localhost`, which screenshots an offscreen window for the
 * *model*, this renders interactive pages for the *user*.
 *
 * Each pane is a `WebContentsView` overlaid on the main window and positioned to
 * match a placeholder the renderer measures in the DOM (the renderer owns layout;
 * we only paint native views into the rectangles it reports). A native view always
 * paints above the window's HTML, so the renderer also tells us to hide the panes
 * whenever the dock is closed or a modal/overlay is on top — otherwise a preview
 * would obscure Settings or the command palette.
 *
 * Security mirrors view_localhost exactly: the page is untrusted dev-server output,
 * so each view is sandboxed, context-isolated, has no Node integration, runs in a
 * private session whose subresource requests can't reach private/LAN/metadata
 * hosts, and is pinned to loopback — any attempt to navigate or redirect the top
 * frame off loopback (or to open a new window) is refused.
 */

import { WebContentsView, session, type BaseWindow, type Session } from 'electron'
import { isBlockedSubresourceHost, isLoopbackHost, validateLocalhostUrl } from './agent/loopback'
import type { PreviewPaneBounds, PreviewPaneSpec } from '@shared/preview'

interface Pane {
  id: string
  view: WebContentsView
  url: string
}

const panes = new Map<string, Pane>()
let host: BaseWindow | null = null

/** The locked-down session the preview panes share (installed once). */
const PREVIEW_PARTITION = 'preview-pane'
let filterInstalled = false
function previewSession(): Session {
  const ses = session.fromPartition(PREVIEW_PARTITION)
  if (!filterInstalled) {
    ses.webRequest.onBeforeRequest((details, callback) => {
      let hostname = ''
      try {
        hostname = new URL(details.url).hostname
      } catch {
        /* unparseable (data:/blob:/about:) — no network egress, allow */
      }
      callback({ cancel: isBlockedSubresourceHost(hostname) })
    })
    filterInstalled = true
  }
  return ses
}

/** Round a DOM rect to whole device-independent pixels for setBounds. */
function roundBounds(b: PreviewPaneBounds): PreviewPaneBounds {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(0, Math.round(b.width)),
    height: Math.max(0, Math.round(b.height))
  }
}

/** Remember the window the panes overlay (the main window). */
export function attachPreviewHost(window: BaseWindow): void {
  host = window
}

function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname
  } catch {
    return '' // malformed → treated as off-host below
  }
}

function createPane(spec: PreviewPaneSpec): Pane {
  const view = new WebContentsView({
    webPreferences: {
      session: previewSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  const wc = view.webContents
  // Pin the top frame to loopback: a dev-server page must not be able to 302 (or
  // script-navigate) the pane to a public or internal host. Subresources are
  // filtered separately by the private session above.
  const blockOffHost = (event: { preventDefault: () => void }, navUrl: string): void => {
    if (!isLoopbackHost(hostOf(navUrl))) event.preventDefault()
  }
  wc.on('will-navigate', (e, navUrl) => blockOffHost(e, navUrl))
  wc.on('will-redirect', (e, navUrl) => blockOffHost(e, navUrl))
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))

  const pane: Pane = { id: spec.id, view, url: spec.url }
  void wc.loadURL(spec.url).catch(() => {
    /* the dev server may not be ready yet; the renderer offers a manual reload */
  })
  host?.contentView.addChildView(view)
  return pane
}

function destroyPane(pane: Pane): void {
  host?.contentView.removeChildView(pane.view)
  const wc = pane.view.webContents as { close?: () => void; isDestroyed?: () => boolean }
  if (wc && !wc.isDestroyed?.()) wc.close?.()
}

/**
 * Reconcile the live panes to `specs`: create new ones, drop removed ones, reload
 * any whose URL changed, and position + show/hide the rest. Passing `visible:
 * false` keeps the panes (so they don't reload on every overlay toggle) but hides
 * them; passing an empty `specs` tears them all down.
 */
export function syncPreviewPanes(specs: PreviewPaneSpec[], visible: boolean): void {
  if (!host) return
  // Defense in depth: only ever load loopback URLs, even if a renderer bug sends
  // something else. The per-view nav guard blocks *navigation* off loopback; this
  // also blocks the *initial* load.
  specs = specs.filter((s) => isLoopbackHost(hostOf(s.url)))
  const wanted = new Map(specs.map((s) => [s.id, s]))

  // Drop panes the renderer no longer wants.
  for (const [id, pane] of panes) {
    if (!wanted.has(id)) {
      destroyPane(pane)
      panes.delete(id)
    }
  }

  for (const spec of specs) {
    let pane = panes.get(spec.id)
    if (!pane) {
      pane = createPane(spec)
      panes.set(spec.id, pane)
    } else if (pane.url !== spec.url) {
      // Same slot, different server URL — point the existing view at it.
      pane.url = spec.url
      void pane.view.webContents.loadURL(spec.url).catch(() => {})
    }
    pane.view.setVisible(visible)
    if (visible) pane.view.setBounds(roundBounds(spec.bounds))
  }
}

/** Reload one pane (the dock's per-pane refresh, e.g. after the server starts). */
export function reloadPreviewPane(id: string): void {
  const pane = panes.get(id)
  if (pane && !pane.view.webContents.isDestroyed()) pane.view.webContents.reload()
}

/** Tear down every pane (dock closed, window closing, or app shutdown). */
export function destroyAllPreviewPanes(): void {
  for (const pane of panes.values()) destroyPane(pane)
  panes.clear()
}

/** Validate that a URL is loopback before the renderer hands it to the OS browser. */
export function assertLoopbackUrl(url: string): URL {
  return validateLocalhostUrl(url)
}
