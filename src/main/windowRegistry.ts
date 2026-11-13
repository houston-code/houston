/**
 * The app's chat windows, in the order they were opened, and which one the user used
 * last. Pure (no Electron) so the window policy is unit-tested; ./windows.ts binds it
 * to BrowserWindow.
 *
 * - The **primary** window is the oldest one still open. It alone remembers its size
 *   and position across launches, so with a single window nothing changes.
 * - The **target** window is where an app-level action lands (a menu item, a dialog, a
 *   link, a notification about a chat no window shows): the focused window when there
 *   is one, else the one focused most recently, else the primary.
 * - Each window reports the chat it shows, so an action about a chat can go to the
 *   window already showing it.
 */

export interface RegistryWindow {
  /** A stable id (BrowserWindow.id). */
  id: number
  /** The renderer's WebContents id, which IPC events carry. */
  webContentsId: number
  isDestroyed(): boolean
}

export class WindowRegistry<W extends RegistryWindow> {
  private windows: W[] = []
  /** Window ids, most recently focused last. */
  private focusOrder: number[] = []
  /** Window id → the chat it shows (null: a new chat). */
  private showing = new Map<number, string | null>()

  add(win: W): void {
    if (this.windows.some((w) => w.id === win.id)) return
    this.windows.push(win)
  }

  remove(win: Pick<W, 'id'>): void {
    this.windows = this.windows.filter((w) => w.id !== win.id)
    this.focusOrder = this.focusOrder.filter((id) => id !== win.id)
    this.showing.delete(win.id)
  }

  /** Open windows, oldest first. */
  list(): W[] {
    return this.windows.filter((w) => !w.isDestroyed())
  }

  size(): number {
    return this.list().length
  }

  has(win: Pick<W, 'id'>): boolean {
    return this.list().some((w) => w.id === win.id)
  }

  primary(): W | undefined {
    return this.list()[0]
  }

  isPrimary(win: Pick<W, 'id'>): boolean {
    return this.primary()?.id === win.id
  }

  noteFocus(win: Pick<W, 'id'>): void {
    if (!this.has(win)) return
    this.focusOrder = [...this.focusOrder.filter((id) => id !== win.id), win.id]
  }

  /** The window an app-level action lands in (see the file comment). */
  target(focused?: Pick<W, 'id'> | null): W | undefined {
    const open = this.list()
    if (focused) {
      const f = open.find((w) => w.id === focused.id)
      if (f) return f
    }
    for (let i = this.focusOrder.length - 1; i >= 0; i--) {
      const w = open.find((o) => o.id === this.focusOrder[i])
      if (w) return w
    }
    return open[0]
  }

  byWebContentsId(webContentsId: number): W | undefined {
    return this.list().find((w) => w.webContentsId === webContentsId)
  }

  /** Record the chat a window shows (reported by its renderer). */
  setShowing(win: Pick<W, 'id'>, conversationId: string | null): void {
    if (this.has(win)) this.showing.set(win.id, conversationId)
  }

  showingIn(win: Pick<W, 'id'>): string | null {
    return this.showing.get(win.id) ?? null
  }

  /**
   * The open window showing this chat, preferring the target window when several do,
   * so a notification click lands where the user last was.
   */
  windowShowing(conversationId: string, focused?: Pick<W, 'id'> | null): W | undefined {
    const showingIt = this.list().filter((w) => this.showing.get(w.id) === conversationId)
    if (showingIt.length === 0) return undefined
    const target = this.target(focused)
    return showingIt.find((w) => w.id === target?.id) ?? showingIt[showingIt.length - 1]
  }
}
