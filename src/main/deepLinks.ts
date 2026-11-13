import { parseDeepLink, type DeepLink, type DeepLinkSettingsPage } from '@shared/deepLink'

/**
 * Acting on `houston://` links (parsed by @shared/deepLink). Links reach the app
 * from the OS: `open-url` on macOS, and argv on Windows and Linux, either at launch
 * or forwarded by the single-instance lock to the running app. A link is untrusted
 * input from whatever page or program produced it, so the router:
 *
 * - drops anything that doesn't parse as one of the supported actions;
 * - opens a folder only if it is an existing directory, and asks first when Houston
 *   has never opened it (no recent entry, no chat in it);
 * - opens a chat only if it exists, and Settings only at a known page;
 * - never starts a run, sends a prompt, or changes a setting.
 *
 * Links that arrive before the window's UI is listening are held and delivered,
 * in order, once it reports ready. Electron is reached only through `deps`, so the
 * policy is unit-tested without it.
 */
export interface DeepLinkDeps {
  /** Bring the app's window to the front, creating one if none is open. */
  focusWindow(): void
  /** Start a new chat in this folder (the File > Open Recent path). */
  openFolder(path: string): void
  openChat(conversationId: string): void
  openSettings(page?: DeepLinkSettingsPage): void
  /** The folder's canonical path when it is an existing directory, else null. */
  resolveDirectory(path: string): string | null
  /** Whether Houston has opened this (canonical) folder before. */
  isKnownFolder(path: string): boolean
  conversationExists(id: string): boolean
  /** Ask whether to open a folder Houston hasn't seen; resolves true to open it. */
  confirmFolder(path: string): Promise<boolean>
  /** Tell the user why a link did nothing (a missing folder or chat). */
  warn(message: string, detail?: string): void
  log(message: string): void
}

export interface DeepLinkRouter {
  /** Handle a raw link from the OS. Resolves once it has been acted on (or queued). */
  handle(raw: unknown): Promise<void>
  /** The window's UI is listening: deliver any held links. */
  markReady(): Promise<void>
  /** The UI went away (window closed or reloading): hold links again until it is back. */
  markNotReady(): void
}

/** Most links held while the UI loads; older ones are dropped past this. */
const MAX_PENDING = 8

export function createDeepLinkRouter(deps: DeepLinkDeps): DeepLinkRouter {
  let ready = false
  let pending: DeepLink[] = []

  const act = async (link: DeepLink): Promise<void> => {
    deps.focusWindow()
    switch (link.type) {
      case 'open-folder': {
        const dir = deps.resolveDirectory(link.path)
        if (!dir) {
          deps.warn('That folder no longer exists.', link.path)
          return
        }
        if (!deps.isKnownFolder(dir) && !(await deps.confirmFolder(dir))) return
        deps.openFolder(dir)
        return
      }
      case 'open-chat':
        if (!deps.conversationExists(link.conversationId)) {
          deps.warn('That chat no longer exists.')
          return
        }
        deps.openChat(link.conversationId)
        return
      case 'open-settings':
        deps.openSettings(link.page)
        return
    }
  }

  return {
    async handle(raw) {
      const link = parseDeepLink(raw)
      if (!link) {
        // The raw link is never logged: it may carry a path the user considers private.
        deps.log('ignored an unsupported houston:// link')
        deps.focusWindow()
        return
      }
      if (!ready) {
        pending.push(link)
        if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING)
        deps.focusWindow()
        return
      }
      await act(link)
    },
    async markReady() {
      ready = true
      const held = pending
      pending = []
      for (const link of held) await act(link)
    },
    markNotReady() {
      ready = false
    }
  }
}
