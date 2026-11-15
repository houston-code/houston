import type { PlanDecision } from './agent'

/**
 * Upper bound on free text a person sends back to a blocked tool call: an `ask_user`
 * answer, a plan "Suggest changes" note, or a hand-edited plan. Real answers are a
 * short option label or a few lines; anything past this would become an oversized tool
 * result the model must carry. Every client applies it (the desktop's at the IPC
 * boundary, the terminal before it resolves), so the cap is the same everywhere.
 */
export const MAX_QUESTION_ANSWER_LEN = 100_000

/**
 * What the agent is told when the person dismisses an `ask_user` question without
 * answering (Ctrl-D in the terminal, declining in an editor): words, never an empty
 * string the model could read as a blank choice.
 */
export const QUESTION_DISMISSED_ANSWER =
  '[The user dismissed the question without answering. Proceed using your best judgment.]'

/** An `ask_user` answer cut to the cap. */
export function capAnswer(answer: string): string {
  return answer.slice(0, MAX_QUESTION_ANSWER_LEN)
}

/** A plan decision with its free text (a note, an edited body) cut to the cap. */
export function capPlanDecision(decision: PlanDecision): PlanDecision {
  if (decision.kind === 'suggest') return { kind: 'suggest', note: capAnswer(decision.note) }
  if (decision.kind === 'accept' && decision.editedBody !== undefined) {
    return { kind: 'accept', mode: decision.mode, editedBody: capAnswer(decision.editedBody) }
  }
  return decision
}
