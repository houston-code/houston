import { app, BrowserWindow, dialog } from 'electron'
import type { Event as ElectronEvent } from 'electron'
import { APP_NAME } from '@shared/constants'
import { activeRunCount } from './agent/loop'
import { listShells } from './agent/shells'
import { terminalCount } from './terminal'
import { log } from './logger'
import {
  quitConfirmButton,
  quitConfirmDetail,
  quitConfirmMessage,
  shouldConfirmQuit,
  type LiveWork,
  type QuitReason
} from './quit-guard'

// Quit-confirmation state, shared by every guard below. `quitConfirmed` lets the
// re-issued quit (or the update's quit-and-install) pass straight through;
// `quitPrompting` swallows repeat quit gestures while the dialog is already open.
let quitConfirmed = false
let quitPrompting = false

/** Everything a quit would tear down: live chat runs + running background tasks. */
function liveWork(): LiveWork {
  const shells = listShells().filter((s) => s.running).length
  return { chats: activeRunCount(), tasks: shells + terminalCount() }
}

function dialogParent(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined
}

/** Ask whether to tear down live work. Resolves true when the user confirms. */
async function confirmLiveWork(
  win: BrowserWindow | undefined,
  work: LiveWork,
  reason: QuitReason
): Promise<boolean> {
  const options = {
    type: 'warning' as const,
    buttons: [quitConfirmButton(reason), 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: APP_NAME,
    message: quitConfirmMessage(work),
    detail: quitConfirmDetail(work, reason)
  }
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  return response === 0
}

/**
 * Shared guard for both quit paths: cancel the in-progress quit/close, confirm if
 * anything is live, and re-issue the quit only once the user agrees. Wired to
 * `before-quit` (⌘Q and File→Quit, where a window is still alive) and, on
 * Windows/Linux, to the window's `close` (the usual quit gesture there — and the
 * only place a dialog can still be parented, since `before-quit` fires after the
 * window is destroyed). Nothing live → the quit proceeds untouched.
 */
export function guardQuitWithLiveWork(e: ElectronEvent, win: BrowserWindow | undefined): void {
  if (quitConfirmed) return
  const work = liveWork()
  if (!shouldConfirmQuit(work)) return
  e.preventDefault()
  if (quitPrompting) return
  quitPrompting = true
  confirmLiveWork(win ?? dialogParent(), work, 'quit')
    .then((ok) => {
      quitPrompting = false
      if (ok) {
        quitConfirmed = true
        app.quit()
      }
    })
    .catch((err) => {
      // A failed prompt must not trap the user: clear the flag so the next quit
      // attempt re-prompts rather than silently swallowing every future quit.
      quitPrompting = false
      log.error('quit confirmation dialog failed', err)
    })
}

/**
 * Gate a restart-to-install. Must run BEFORE `quitAndInstall()`: that call closes
 * every window first and only then emits `before-quit`, where a preventDefault can
 * no longer stop the install and there is no window to parent a dialog. So we ask
 * up front and, on a yes, mark the quit confirmed so the guards above let it through.
 * Resolves true when the restart may proceed.
 */
export async function confirmRestartForUpdate(): Promise<boolean> {
  if (quitConfirmed) return true
  const work = liveWork()
  if (shouldConfirmQuit(work)) {
    if (quitPrompting) return false
    quitPrompting = true
    try {
      if (!(await confirmLiveWork(dialogParent(), work, 'restart'))) return false
    } catch (err) {
      log.error('restart confirmation dialog failed', err)
      return false
    } finally {
      quitPrompting = false
    }
  }
  quitConfirmed = true
  return true
}

/** Undo a confirmation whose restart never happened (quitAndInstall threw), so the
 *  next quit is guarded again. */
export function resetQuitConfirmation(): void {
  quitConfirmed = false
}
