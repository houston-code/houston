import { basename } from 'node:path'
import type { AgentEvent } from './agent'
import { APP_NAME } from './constants'
import { prNoticeFromToolResult } from './prNotice'

/**
 * "Is this event worth pulling the user back for?" — the one policy every client
 * signals from.
 *
 * It lived in main/notifications.ts, which imports Electron for the OS call. The
 * policy itself never needed Electron, and the terminal clients (which cannot
 * load it — the standalone CLI has no Electron at all) need the same answer to
 * ring a bell or set a tab title. Keeping two copies of "what matters" is how the
 * desktop and the terminal quietly disagree about when to interrupt someone.
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
    case 'plan_ready':
      // Blocking on a verdict, exactly like an approval: the run goes nowhere until
      // the user looks. The desktop has always had a docked panel in view; a
      // terminal user who wandered off has nothing telling them it stopped.
      return { title: `${APP_NAME} presented a plan${where}`, body: e.plan.title }
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

/**
 * The two attention sounds: a turn ended (finished or failed), or the run is blocked
 * on the user (an approval, a question, a plan to review, a server's input form).
 */
export type AttentionSound = 'done' | 'input'

/**
 * The sound for an agent event, or null. Same "worth interrupting for" line as
 * {@link notificationFor}: a turn the user stopped themselves stays silent, and only
 * events that end a turn or block on the user make a sound.
 */
export function soundFor(e: AgentEvent): AttentionSound | null {
  switch (e.type) {
    case 'done':
      return e.stopReason === 'aborted' ? null : 'done'
    case 'error':
      return 'done'
    case 'tool_approval':
    case 'tool_question':
    case 'plan_ready':
    case 'elicitation':
      return 'input'
    default:
      return null
  }
}

/**
 * What the desktop does for an event while its window is unfocused, given the user's
 * two switches: whether to show a notification (on unless turned off) and which
 * sound to play (only when sounds are turned on). Null when neither applies.
 */
export function attentionSignals(
  e: AgentEvent,
  prefs: { desktopNotifications?: boolean; attentionSounds?: boolean }
): { notify: boolean; sound: AttentionSound | null } | null {
  const sound = prefs.attentionSounds === true ? soundFor(e) : null
  const notify = prefs.desktopNotifications !== false && notificationFor(e) !== null
  return sound || notify ? { notify, sound } : null
}

/** A short project label for a workspace path (its basename), or undefined. */
export function workspaceLabel(workspace: string | undefined): string | undefined {
  if (!workspace) return undefined
  return basename(workspace) || undefined
}
