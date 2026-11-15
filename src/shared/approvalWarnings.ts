import type { AgentEvent } from './agent'

/**
 * The warnings an approval prompt carries, in the order a client shows them.
 *
 * Every one that applies is listed: a shell command can run unsandboxed AND change a
 * credential file, and showing only the first would hide the second from the person
 * deciding. Clients word each kind themselves; this only decides which apply.
 */
export type ApprovalWarning = 'unsandboxed' | 'sensitiveRead' | 'protectedWrite' | 'sensitiveWrite'

type ApprovalFlags = Pick<
  Extract<AgentEvent, { type: 'tool_approval' }>,
  'kind' | 'sandboxed' | 'sensitiveRead' | 'sensitiveWrite' | 'protectedWrite'
>

export function approvalWarnings(ev: ApprovalFlags): ApprovalWarning[] {
  const out: ApprovalWarning[] = []
  if (ev.kind === 'shell' && ev.sandboxed === false) out.push('unsandboxed')
  if (ev.sensitiveRead) out.push('sensitiveRead')
  // A control file is also a sensitive write; it gets the stronger warning instead.
  if (ev.sensitiveWrite && ev.protectedWrite) out.push('protectedWrite')
  else if (ev.sensitiveWrite) out.push('sensitiveWrite')
  return out
}
