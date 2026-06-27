import { Notification, type BrowserWindow } from 'electron'
import { basename } from 'node:path'
import type { AgentEvent } from '@shared/agent'
import { APP_NAME } from '@shared/constants'
import { prNoticeFromToolResult } from '@shared/prNotice'

/**
 * Native desktop notifications for agent events. We ping the user when a turn
 * finishes, the agent needs them (approval / question / error), or a pull request
 * is opened/merged — *while Houston isn't the focused window* — so they can wander
 * off during a long turn and get pulled back when it matters, without being nagged
 * while they're already watching.
 *
 * `notificationFor` is pure (no Electron) so the "which events are worth a ping"
 * policy is unit-tested; `notifyAgentEvent` adds the focus gate and the OS call.
 */

export interface NotifySpec {
  title: string
  body: string
}

/**
 * The notification to show for an agent event, or null if the event isn't worth
 * interrupting the user for. `workspaceName` (a short project label) is folded
 * into the title for context when several chats run in different folders.
 */
export function notificationFor(e: AgentEvent, workspaceName?: string): NotifySpec | null {
  const where = workspaceName ? ` · ${workspaceName}` : ''
  switch (e.type) {
    case 'done':
      // The user explicitly stopped this run — they're present, don't ping them.
      if (e.stopReason === 'aborted') return null
      return { title: `${APP_NAME}${where}`, body: 'Finished responding.' }
    case 'tool_approval':
      return { title: `${APP_NAME} needs approval${where}`, body: `${e.name}: ${e.summary}` }
    case 'tool_question':
      return { title: `${APP_NAME} has a question${where}`, body: e.question }
    case 'error':
      return { title: `${APP_NAME} hit a problem${where}`, body: e.message }
    case 'tool_result': {
      // A PR opening or merging (from gh_pr_create / gh_pr_view) is worth a ping.
      const pr = prNoticeFromToolResult(e.name, e.ok, e.output)
      if (!pr) return null
      const num = pr.number ? ` #${pr.number}` : ''
      return {
        title: `${APP_NAME}${where}`,
        body: pr.event === 'created' ? `Opened pull request${num}` : `Pull request${num} merged`
      }
    }
    default:
      return null
  }
}

/** A short project label for a workspace path (its basename), or undefined. */
export function workspaceLabel(workspace: string | undefined): string | undefined {
  if (!workspace) return undefined
  return basename(workspace) || undefined
}

/**
 * Fire a native notification for a notable agent event when Houston isn't focused.
 * No-op when notifications are disabled, the platform can't show them, the window
 * is focused (the user is already watching), or the event isn't notable. Clicking
 * the notification brings the window back to the front.
 */
export function notifyAgentEvent(
  e: AgentEvent,
  win: BrowserWindow | null,
  opts: { enabled: boolean; workspaceName?: string }
): void {
  if (!opts.enabled || !Notification.isSupported()) return
  // Focused window → the user is already watching; don't interrupt.
  if (win && !win.isDestroyed() && win.isFocused()) return
  const spec = notificationFor(e, opts.workspaceName)
  if (!spec) return
  const n = new Notification({ title: spec.title, body: spec.body })
  n.on('click', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  n.show()
}
