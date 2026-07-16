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

/** A short project label for a workspace path (its basename), or undefined. */
export function workspaceLabel(workspace: string | undefined): string | undefined {
  if (!workspace) return undefined
  return basename(workspace) || undefined
}
