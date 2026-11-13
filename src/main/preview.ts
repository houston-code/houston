/**
 * Live preview panes for the renderer's Preview dock.
 *
 * The dock shows the dev servers the agent started (a `run_shell` background
 * process whose loopback URL we sniffed — see agent/shells.ts) as live, scrollable
 * pages. Unlike `view_localhost`, which screenshots an offscreen window for the
 * *model*, this renders interactive pages for the *user*.
 *
 * Each pane is a `WebContentsView` overlaid on the window whose dock shows it, and
 * positioned to match a placeholder that window's renderer measures in the DOM (the renderer owns layout;
 * we only paint native views into the rectangles it reports). A native view always
 * paints above the window's HTML, so the renderer also tells us to hide the panes
 * whenever the dock is closed or a modal/overlay is on top — otherwise a preview
 * would obscure Settings or the command palette. Every window has its own panes, so
 * two windows can show different servers (or the same one) without fighting over a
 * view.
 *
 * Security mirrors view_localhost exactly: the page is untrusted dev-server output,
 * so each view is sandboxed, context-isolated, has no Node integration, runs in a
 * private session whose subresource requests can't reach private/LAN/metadata
 * hosts (and which refuses downloads and every device/notification permission —
 * see {@link hardenUntrustedSession}), and is pinned to loopback — any attempt to
 * navigate or redirect the top frame off loopback (or to open a new window) is
 * refused.
 */

import { WebContentsView, session, type BaseWindow, type Session } from 'electron'
import { isLoopbackHost, validateLocalhostUrl } from './agent/loopback'
import { hardenUntrustedSession } from './hardenedSession'
import type { PreviewPaneBounds, PreviewPaneSpec } from '@shared/preview'

interface Pane {
  id: string
  view: WebContentsView
  url: string
}

/** Each window's panes, by pane id. */
const panesByHost = new Map<BaseWindow, Map<string, Pane>>()

/** The locked-down session the preview panes share (installed once). */
const PREVIEW_PARTITION = 'preview-pane'
let filterInstalled = false
function previewSession(): Session {
  const ses = session.fromPartition(PREVIEW_PARTITION)
  if (!filterInstalled) {
    // Subresource egress filter + download block + permission denial, shared with
    // the offscreen view_localhost capture so the two untrusted-page surfaces stay
    // locked down identically.
    hardenUntrustedSession(ses)
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

function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname
  } catch {
    return '' // malformed → treated as off-host below
  }
}

function createPane(host: BaseWindow, spec: PreviewPaneSpec): Pane {
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
  host.contentView.addChildView(view)
  return pane
}

function destroyPane(host: BaseWindow, pane: Pane): void {
  if (!host.isDestroyed()) host.contentView.removeChildView(pane.view)
  const wc = pane.view.webContents as { close?: () => void; isDestroyed?: () => boolean }
  if (wc && !wc.isDestroyed?.()) wc.close?.()
}

/**
 * Reconcile the live panes to `specs`: create new ones, drop removed ones, reload
 * any whose URL changed, and position + show/hide the rest. Passing `visible:
 * false` keeps the panes that exist (so they don't reload on every overlay toggle)
 * but hides them, and creates none; passing an empty `specs` tears them all down.
 */
export function syncPreviewPanes(host: BaseWindow | null, specs: PreviewPaneSpec[], visible: boolean): void {
  if (!host || host.isDestroyed()) return
  // Defense in depth: only ever load loopback URLs, even if a renderer bug sends
  // something else. The per-view nav guard blocks *navigation* off loopback; this
  // also blocks the *initial* load.
  specs = specs.filter((s) => isLoopbackHost(hostOf(s.url)))
  const wanted = new Map(specs.map((s) => [s.id, s]))
  let panes = panesByHost.get(host)
  if (!panes) {
    if (specs.length === 0) return
    panes = new Map()
    panesByHost.set(host, panes)
  }

  // Drop panes the renderer no longer wants.
  for (const [id, pane] of panes) {
    if (!wanted.has(id)) {
      destroyPane(host, pane)
      panes.delete(id)
    }
  }

  for (const spec of specs) {
    let pane = panes.get(spec.id)
    if (!pane) {
      // A pane nobody can see yet is not started: each one is a whole renderer process
      // loading a dev server's page. The dock syncs again when it becomes visible (its
      // tab is chosen, the overlay over it closes), and the pane is created then.
      if (!visible) continue
      pane = createPane(host, spec)
      panes.set(spec.id, pane)
    } else if (pane.url !== spec.url) {
      // Same slot, different server URL — point the existing view at it.
      pane.url = spec.url
      void pane.view.webContents.loadURL(spec.url).catch(() => {})
    }
    pane.view.setVisible(visible)
    if (visible) pane.view.setBounds(roundBounds(spec.bounds))
  }
  if (panes.size === 0) panesByHost.delete(host)
}

/** Reload one of a window's panes (the dock's per-pane refresh, e.g. after the server starts). */
export function reloadPreviewPane(host: BaseWindow | null, id: string): void {
  const pane = host ? panesByHost.get(host)?.get(id) : undefined
  if (pane && !pane.view.webContents.isDestroyed()) pane.view.webContents.reload()
}

/** Tear down one window's panes (that window is closing). */
export function destroyPreviewPanesOf(host: BaseWindow): void {
  const panes = panesByHost.get(host)
  if (!panes) return
  for (const pane of panes.values()) destroyPane(host, pane)
  panesByHost.delete(host)
}

/** Tear down every pane in every window (app shutdown). */
export function destroyAllPreviewPanes(): void {
  for (const host of [...panesByHost.keys()]) destroyPreviewPanesOf(host)
}

/** Validate that a URL is loopback before the renderer hands it to the OS browser. */
export function assertLoopbackUrl(url: string): URL {
  return validateLocalhostUrl(url)
}
