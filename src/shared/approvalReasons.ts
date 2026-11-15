import type { AgentEvent } from './agent'

type TripwireFlags = Pick<Extract<AgentEvent, { type: 'tool_approval' }>, 'discardsWork' | 'escapesWorkspace'>

/**
 * Why a shell command is asking when it is one of the checks that hold in every mode
 * (full auto and "Allow for this chat" included): it can throw away work, or it reaches
 * outside the workspace. Each client shows these lines on the approval, so a prompt in
 * full auto doesn't look like a bug. Empty when neither applies.
 */
export function approvalAskReasons(ev: TripwireFlags): string[] {
  const out: string[] = []
  if (ev.discardsWork) {
    out.push(
      'It can throw away work in the project (such as uncommitted changes), and shell changes are not checkpointed, so Houston asks in every mode.'
    )
  }
  if (ev.escapesWorkspace) {
    out.push('It reaches outside the project folder, so Houston asks in every mode.')
  }
  return out
}

/** The same reasons as one short phrase for a log line, or null when none apply. */
export function approvalAskReasonShort(ev: TripwireFlags): string | null {
  const parts: string[] = []
  if (ev.discardsWork) parts.push('can throw away work')
  if (ev.escapesWorkspace) parts.push('reaches outside the project folder')
  return parts.length ? parts.join(', ') : null
}
