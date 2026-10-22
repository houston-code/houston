import type { SteerOutcome } from '@shared/queue'

/** What became of a message typed while a run was going. */
export type MidRunDelivery = 'answered' | 'steered' | 'queued' | 'sent' | 'queued-elsewhere' | 'given-back'

export interface MidRunDeps {
  /** The agent's open `ask_user` question, if it is waiting on one. */
  openQuestionId: string | null
  /** The conversation the message was typed in (null: none yet). */
  conversationId: string | null
  /** Whether a model is selected to send it with. */
  canSend: boolean
  answer: (callId: string, text: string) => void
  /** Main's steer-or-queue decision (see the agentSteer handler). */
  steer: (conversationId: string, text: string) => Promise<SteerOutcome>
  /** Whether `conversationId` is still the one on screen. */
  isOpen: (conversationId: string) => boolean
  /** Start a turn in the open conversation. */
  sendNow: (text: string) => void
  /** Queue into a conversation that is no longer on screen. */
  enqueue: (conversationId: string, text: string) => void
  /** Nothing stored it: put the text back in its chat's message box. */
  giveBack: (text: string, conversationId: string | null, failed: boolean) => void
}

/**
 * Deliver a message typed mid-run so that it always ends up somewhere the user can
 * see it: as the answer to the agent's open question (the run can't read a steer
 * until that is settled), steered into the run or queued behind it (main's call,
 * stored before it replies), sent as a turn when the run has already ended, or,
 * when nothing could take it, back in the message box. Never dropped.
 */
export async function deliverMidRunMessage(text: string, d: MidRunDeps): Promise<MidRunDelivery> {
  if (d.openQuestionId) {
    d.answer(d.openQuestionId, text)
    return 'answered'
  }
  const cid = d.conversationId
  if (!cid || !d.canSend) {
    d.giveBack(text, cid, false)
    return 'given-back'
  }
  let outcome: SteerOutcome
  try {
    outcome = await d.steer(cid, text)
  } catch {
    d.giveBack(text, cid, true)
    return 'given-back'
  }
  if (outcome.status !== 'idle') return outcome.status
  // The run ended before the message reached it: its own turn, in its own chat.
  if (d.isOpen(cid)) {
    d.sendNow(text)
    return 'sent'
  }
  d.enqueue(cid, text)
  return 'queued-elsewhere'
}
