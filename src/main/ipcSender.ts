import type { ipcMain } from 'electron'
import { isAllowedNavigation } from './navigation'
import { chatWindows } from './windows'
import { log } from './logger'

/**
 * Who may call the main process's IPC handlers.
 *
 * Every handler (agent runs, terminal spawn, secrets, file dialogs, git actions) is
 * reachable from any renderer that can talk to `ipcMain`, and none of them looked at
 * who sent the request. Today only the chat windows load the preload, and their
 * navigation is pinned (navigation.ts), but that is a single layer: a helper window,
 * a preview pane, or a subframe that ever gained an IPC path (a future preload, a
 * `nodeIntegrationInSubFrames` slip) would hold the whole privileged surface.
 *
 * So every registration goes through {@link guardIpcHandle} / {@link guardIpcOn},
 * which drop a request unless
 *   1. its sender is a registered chat window's webContents (windows.ts),
 *   2. it came from that window's main frame, not a subframe, and
 *   3. that frame is showing the app's own document: the start URL (with any
 *      `#route` or `?query`), or in development the dev server's origin.
 *
 * The start URL is configured once from index.ts, before any window loads. Until it
 * is, nothing is trusted.
 */

/** The parts of a WebFrameMain the check reads. */
export interface FrameLike {
  url: string
  parent: FrameLike | null
  processId?: number
  routingId?: number
}

/** The parts of an IPC event the check reads. */
export interface SenderEventLike {
  sender?: unknown
  senderFrame?: FrameLike | null
}

export interface IpcSenderPolicy {
  /** The renderer's start document (a file:// URL in a packaged build). */
  startUrl: string
  /** The Vite dev server URL, in development only. */
  devUrl?: string
  /**
   * Whether a webContents belongs to a registered chat window. Defaults to the live
   * window registry; tests that model app-window events supply their own registry.
   */
  isAppContents?: (contents: unknown) => boolean
}

let policy: IpcSenderPolicy | null = null

/** Set the trusted renderer document. Called from index.ts before the first window loads. */
export function configureIpcSenderPolicy(next: IpcSenderPolicy): void {
  policy = next
}

/** Whether `contents` is the webContents of an open, registered chat window. */
function isChatWindowContents(contents: unknown): boolean {
  return chatWindows().some((w) => !w.isDestroyed() && w.webContents === contents)
}

/** Lowercased on Windows and macOS, whose file systems ignore case by default. */
function filePathKey(u: URL): string {
  let p: string
  try {
    p = decodeURIComponent(u.pathname)
  } catch {
    p = u.pathname
  }
  return process.platform === 'linux' ? p : p.toLowerCase()
}

/**
 * Whether `frameUrl` is the app's own document. Reuses the navigation allowlist, and
 * for a file:// start document also compares the decoded path, so a spelling
 * difference between how Chromium reports the loaded file and how Node built the
 * start URL (percent-encoding, drive-letter case) never locks the app out.
 */
export function isAppDocumentUrl(frameUrl: string, startUrl: string, devUrl?: string): boolean {
  if (typeof frameUrl !== 'string' || !frameUrl) return false
  if (isAllowedNavigation(frameUrl, startUrl, devUrl)) return true
  let frame: URL
  let start: URL
  try {
    frame = new URL(frameUrl)
    start = new URL(startUrl)
  } catch {
    return false
  }
  return (
    start.protocol === 'file:' &&
    frame.protocol === 'file:' &&
    frame.host === start.host &&
    filePathKey(frame) === filePathKey(start)
  )
}

/** Whether an IPC event came from the main frame of a chat window showing the app. */
export function isTrustedIpcEvent(event: unknown, p: IpcSenderPolicy | null = policy): boolean {
  if (!p || !event || typeof event !== 'object') return false
  const e = event as SenderEventLike
  const sender = e.sender as { mainFrame?: FrameLike | null } | null | undefined
  if (!sender || typeof sender !== 'object') return false
  if (!(p.isAppContents ?? isChatWindowContents)(sender)) return false
  let frame: FrameLike | null | undefined
  let main: FrameLike | null | undefined
  try {
    // Both getters can throw once the frame is gone (a navigation or a crash).
    frame = e.senderFrame
    main = sender.mainFrame
  } catch {
    return false
  }
  if (!frame || !main) return false
  if (frame.parent !== null) return false
  const sameFrame =
    frame === main ||
    (frame.processId !== undefined &&
      frame.routingId !== undefined &&
      frame.processId === main.processId &&
      frame.routingId === main.routingId)
  if (!sameFrame) return false
  return isAppDocumentUrl(frame.url, p.startUrl, p.devUrl)
}

/** Refusals are logged once per channel, so a misbehaving page can't flood the log. */
const warned = new Set<string>()
function noteRefusal(channel: string): void {
  if (warned.has(channel)) return
  warned.add(channel)
  log.warn(`refused IPC "${channel}" from a sender that is not the app's own window`)
}

/** The error an `invoke` from an untrusted sender rejects with. */
export const UNTRUSTED_SENDER_ERROR = 'This request did not come from the app window.'

type Handle = typeof ipcMain.handle
type On = typeof ipcMain.on

/** `ipcMain.handle`, refusing (rejecting the invoke) any request an untrusted sender makes. */
export function guardIpcHandle(handle: Handle, check: (event: unknown) => boolean = isTrustedIpcEvent): Handle {
  return (channel, listener) =>
    handle(channel, (event, ...args) => {
      if (!check(event)) {
        noteRefusal(channel)
        throw new Error(UNTRUSTED_SENDER_ERROR)
      }
      return listener(event, ...args)
    })
}

/** `ipcMain.on`, dropping any message an untrusted sender sends. */
export function guardIpcOn(on: On, check: (event: unknown) => boolean = isTrustedIpcEvent): On {
  return ((channel: string, listener: Parameters<On>[1]) =>
    on(channel, (event, ...args) => {
      if (!check(event)) {
        noteRefusal(channel)
        return
      }
      listener(event, ...args)
    })) as On
}
