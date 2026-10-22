import { isReasoningEffort, type ReasoningEffort } from '@shared/agent'
import { parseApprovalPolicy, type ApprovalPolicy } from '@shared/types'

/** The Settings pages a command can open on. */
export type SettingsSection = 'models' | 'mcp' | 'hooks' | 'permissions' | 'appearance'

/**
 * What the desktop app does for one of the built-in commands it shares with the
 * terminal. Pure, so the mapping is testable; App carries the action out.
 *
 * Each one lands on the desktop's own surface for the job (the Changes panel, the
 * model picker, Settings), so a command learned in the terminal does the same thing
 * here instead of being sent to the model as a message.
 */
export type DesktopCommandAction =
  | { kind: 'settings'; section: SettingsSection }
  | { kind: 'model'; query: string }
  | { kind: 'changes' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'retry' }
  | { kind: 'fork' }
  | { kind: 'resume'; query: string }
  | { kind: 'btw'; question: string }
  | { kind: 'btw-clear' }
  | { kind: 'cost' }
  | { kind: 'cwd' }
  | { kind: 'share' }
  /** No policy: report the current one. `invalid` is a word that named none. */
  | { kind: 'approval'; policy?: ApprovalPolicy; invalid?: string }
  | { kind: 'reasoning'; effort?: ReasoningEffort; invalid?: string }

export function desktopCommandAction(name: string, args: string): DesktopCommandAction | null {
  const arg = args.trim()
  switch (name) {
    case 'settings':
      return { kind: 'settings', section: 'models' }
    case 'login':
      return { kind: 'settings', section: 'models' }
    case 'mcp':
      return { kind: 'settings', section: 'mcp' }
    case 'hooks':
      return { kind: 'settings', section: 'hooks' }
    case 'trust':
      return { kind: 'settings', section: 'permissions' }
    case 'theme':
      return { kind: 'settings', section: 'appearance' }
    case 'model':
      return { kind: 'model', query: arg }
    case 'changes':
      return { kind: 'changes' }
    case 'undo':
      return { kind: 'undo' }
    case 'redo':
      return { kind: 'redo' }
    case 'retry':
      return { kind: 'retry' }
    case 'fork':
      return { kind: 'fork' }
    case 'resume':
      return { kind: 'resume', query: arg }
    case 'btw':
      return arg.toLowerCase() === 'clear' ? { kind: 'btw-clear' } : { kind: 'btw', question: arg }
    case 'cost':
      return { kind: 'cost' }
    case 'cwd':
      return { kind: 'cwd' }
    case 'share':
      return { kind: 'share' }
    case 'approval': {
      if (!arg) return { kind: 'approval' }
      const policy = parseApprovalPolicy(arg)
      return policy ? { kind: 'approval', policy } : { kind: 'approval', invalid: arg }
    }
    case 'reasoning': {
      if (!arg) return { kind: 'reasoning' }
      const effort = arg.toLowerCase()
      return isReasoningEffort(effort) ? { kind: 'reasoning', effort } : { kind: 'reasoning', invalid: arg }
    }
    default:
      return null
  }
}
