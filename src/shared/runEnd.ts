import type { ChatMessage, ConversationError, RunEndRecord, RunLimitReason } from './agent'

/**
 * Why a run stopped short, as every client words it: the live `limit` notice and the
 * record a reload or resume shows, so the two read the same.
 */
export function limitNoticeText(reason: RunLimitReason): string {
  switch (reason) {
    case 'max-steps':
      return 'Reached the step limit for one turn and stopped. Send a message to have me continue.'
    case 'stalled':
      return 'Stopped: I appeared to be repeating myself without making progress. Send a message with more direction to continue.'
    case 'max-output':
      return 'The reply was cut off at the model’s output limit. Ask me to continue it.'
    case 'max-cost':
      return 'Reached the cost limit for one turn and stopped. Send a message to have me continue, or raise the limit.'
  }
}

/** The notice a saved run-end record shows: the error, "Stopped.", or the limit's wording. */
export function runEndNoticeText(r: RunEndRecord): string {
  if (r.reason === 'limit') return limitNoticeText(r.limit ?? 'max-steps')
  if (r.reason === 'error' && r.message) return r.message
  return r.reason === 'error' ? 'The run failed.' : 'Stopped.'
}

/**
 * Every run-end record a message holds, oldest first: the older `unanswered`
 * records (saved before `runEnds` existed) and then the current ones.
 */
export function runEndRecords(m: ChatMessage | undefined): RunEndRecord[] {
  if (!m) return []
  return [...(m.unanswered ?? []), ...(m.runEnds ?? [])]
}

/** The record of how the log's latest run ended, when it ended other than by finishing. */
export function latestRunEnd(messages: ChatMessage[]): RunEndRecord | undefined {
  return runEndRecords(messages.at(-1)).at(-1)
}

/** How a conversation's latest run ended, for a report on it. */
export interface RunOutcome {
  outcome: 'done' | 'error' | 'limit' | 'stopped'
  limit?: RunLimitReason
  /** The error, for `error`. */
  message?: string
}

/**
 * How a conversation's latest run ended, read from the record on its last message,
 * falling back to its stored last error (chats saved before records were written
 * after a reply).
 */
export function runOutcome(messages: ChatMessage[], lastError?: ConversationError | null): RunOutcome {
  const r = latestRunEnd(messages)
  if (r?.reason === 'limit') return { outcome: 'limit', limit: r.limit ?? 'max-steps' }
  if (r?.reason === 'aborted') return { outcome: 'stopped' }
  if (r?.reason === 'error') return { outcome: 'error', message: r.message ?? lastError?.message ?? 'The run failed.' }
  if (lastError) return { outcome: 'error', message: lastError.message }
  return { outcome: 'done' }
}

/** One short phrase for a run's outcome ("finished", "failed", "hit the step limit", ...). */
export function runOutcomePhrase(o: Pick<RunOutcome, 'outcome' | 'limit'>): string {
  switch (o.outcome) {
    case 'done':
      return 'finished'
    case 'error':
      return 'failed'
    case 'stopped':
      return 'was stopped'
    case 'limit':
      return o.limit === 'stalled'
        ? 'stalled without making progress'
        : o.limit === 'max-output'
          ? 'hit the model’s output limit'
          : o.limit === 'max-cost'
            ? 'hit the cost limit'
            : 'hit the step limit'
  }
}
