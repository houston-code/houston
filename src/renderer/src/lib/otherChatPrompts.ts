import type { ChatStatusMap, PendingPrompt } from '@shared/chatStatus'

/** A prompt that just started blocking a chat other than the one on screen. */
export interface ArrivedPrompt {
  id: string
  waitingOn: PendingPrompt
}

/** One key per pending prompt, so the same prompt in two snapshots compares equal. */
function keysOf(status: ChatStatusMap, id: string): Set<string> {
  return new Set(
    (status[id]?.pending ?? []).map((p, i) => `${i}\u0000${p.kind}\u0000${p.label ?? ''}`)
  )
}

/**
 * The prompts in `next` that were not in `prev`, in chats other than `currentId` (the
 * open chat shows its own prompts inline). Newest last, so a caller showing one note
 * shows the latest.
 */
export function arrivedPrompts(
  prev: ChatStatusMap,
  next: ChatStatusMap,
  currentId: string | null
): ArrivedPrompt[] {
  const out: ArrivedPrompt[] = []
  for (const id of Object.keys(next)) {
    if (id === currentId) continue
    const before = keysOf(prev, id)
    ;(next[id].pending ?? []).forEach((prompt, i) => {
      if (!before.has(`${i}\u0000${prompt.kind}\u0000${prompt.label ?? ''}`)) out.push({ id, waitingOn: prompt })
    })
  }
  return out
}

/** What the note says about a chat that is now waiting on the user. */
export function waitingToastText(title: string, prompt: PendingPrompt): string {
  const name = title.trim() || 'Another chat'
  switch (prompt.kind) {
    case 'approval':
      return prompt.label ? `${name} needs your approval: ${prompt.label}` : `${name} needs your approval`
    case 'question':
      return `${name} has a question for you`
    case 'plan':
      return `${name} has a plan for you to review`
    case 'elicitation':
      return prompt.label ? `${name} needs your input for ${prompt.label}` : `${name} needs your input`
  }
}
