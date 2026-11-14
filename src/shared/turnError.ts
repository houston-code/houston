/**
 * Why a turn failed, in the user's terms, and what they can do about it.
 *
 * The loop names the cause when it can tell from the failure itself (an HTTP status,
 * a network error code, a missing key). A failure saved before causes were recorded,
 * or one the loop couldn't place, is read from its message as a fallback. The raw
 * message always stays available beside the explanation.
 *
 * Pure and Electron-free: the desktop shows it in the failed-turn bar, and the
 * terminal clients can print the same wording.
 */

export type TurnErrorCause =
  | 'auth'
  | 'rate-limit'
  | 'quota'
  | 'provider-down'
  | 'network'
  | 'model-not-found'
  | 'context-too-long'
  | 'tools-unsupported'

export const TURN_ERROR_CAUSES: readonly TurnErrorCause[] = [
  'auth',
  'rate-limit',
  'quota',
  'provider-down',
  'network',
  'model-not-found',
  'context-too-long',
  'tools-unsupported'
]

export function isTurnErrorCause(v: unknown): v is TurnErrorCause {
  return typeof v === 'string' && (TURN_ERROR_CAUSES as readonly string[]).includes(v)
}

/** A next step the failed-turn bar can offer. */
export type TurnErrorAction = 'retry' | 'provider-settings' | 'doctor' | 'switch-model'

export interface TurnErrorHelp {
  /** One plain sentence: what went wrong. */
  summary: string
  /** What to do about it, in a sentence or two. */
  hint: string
  /** Buttons to offer, most useful first. */
  actions: TurnErrorAction[]
}

const HELP: Record<TurnErrorCause, TurnErrorHelp> = {
  auth: {
    summary: 'The provider did not accept the API key, or none is set.',
    hint: 'Check the key in the provider settings, then retry.',
    actions: ['provider-settings', 'doctor', 'retry']
  },
  'rate-limit': {
    summary: 'The provider is limiting how fast requests can be sent.',
    hint: 'Wait a minute and retry, or switch to another model.',
    actions: ['retry', 'switch-model']
  },
  quota: {
    summary: "The provider account is out of credit or over its usage quota.",
    hint: "Add credit or raise the limit in the provider's billing settings, or switch to another model.",
    actions: ['switch-model', 'provider-settings']
  },
  'provider-down': {
    summary: 'The provider had a server problem and could not answer.',
    hint: 'This is usually brief. Retry in a moment, or switch to another model.',
    actions: ['retry', 'switch-model']
  },
  network: {
    summary: "Houston couldn't reach the provider.",
    hint: 'Check your internet connection (and any proxy or VPN), then retry. The doctor can test the connection.',
    actions: ['retry', 'doctor']
  },
  'model-not-found': {
    summary: "The provider doesn't offer this model, or not to this key.",
    hint: 'Pick another model, then retry.',
    actions: ['switch-model', 'retry']
  },
  'context-too-long': {
    summary: 'The conversation is too long for this model.',
    hint: 'Start a new chat, remove large attachments, or switch to a model with a larger context window.',
    actions: ['switch-model']
  },
  'tools-unsupported': {
    summary: "This model can't call tools, which the agent needs.",
    hint: 'Pick a model that supports tool calling.',
    actions: ['switch-model']
  }
}

/**
 * A credit check against the reply's full output allowance rather than an empty
 * account: some providers (OpenRouter) hold back the cost of the longest reply the
 * request allows before starting, and refuse when the balance can't cover it, even
 * though the turn would have cost far less. Said apart from "out of credit", which
 * reads as wrong to a user who can see money left on the account.
 */
const CREDIT_RESERVATION = /can only afford|fewer max_tokens/i

const QUOTA_RESERVATION: TurnErrorHelp = {
  summary: "The provider account doesn't have enough credit left for this request.",
  hint:
    'The provider holds back credit for the longest reply the model could write, so a low balance can block even a short turn. ' +
    "Add credit in the provider's billing settings and retry, or switch to another model.",
  actions: ['provider-settings', 'switch-model', 'retry']
}

const UNKNOWN: TurnErrorHelp = {
  summary: 'The last turn failed.',
  hint: 'Retry, or run the doctor to check your setup.',
  actions: ['retry', 'doctor']
}

/**
 * A cause read from an error message alone, for failures saved without one. Matches
 * only phrasings that say plainly what happened; anything else stays unknown rather
 * than sending the user down the wrong path.
 */
export function causeFromMessage(message: string): TurnErrorCause | undefined {
  const m = message.toLowerCase()
  if (/no api key set|invalid[ _-]?(?:x-)?api[ _-]?key|incorrect api key|api key not valid|authentication_error|\b401\b|unauthorized|permission_denied|\b403\b/.test(m))
    return 'auth'
  if (
    /insufficient_quota|exceeded your current quota|credit balance is too low|billing|requires more credits|insufficient credits|payment required/.test(m) ||
    /^\s*402\b/.test(m)
  )
    return 'quota'
  if (/doesn't recognize the model|model_not_found|not_found_error/.test(m)) return 'model-not-found'
  if (/doesn't support tool calling|does not support tools/.test(m)) return 'tools-unsupported'
  if (/too large for this model's context window|context[_ ]length|prompt is too long|maximum context length/.test(m))
    return 'context-too-long'
  if (/rate.?limit|too many requests|\b429\b/.test(m)) return 'rate-limit'
  if (/overloaded|internal server error|bad gateway|service unavailable|\b50[0-4]\b|\b529\b/.test(m)) return 'provider-down'
  if (/connection error|fetch failed|econnrefused|econnreset|enotfound|eai_again|etimedout|socket hang up|network/.test(m))
    return 'network'
  return undefined
}

/** The explanation and next steps for a failed turn. */
export function turnErrorHelp(cause: TurnErrorCause | undefined, message: string): TurnErrorHelp {
  const c = cause ?? causeFromMessage(message)
  if (c === 'quota' && CREDIT_RESERVATION.test(message)) return QUOTA_RESERVATION
  return c ? HELP[c] : UNKNOWN
}

/** Button label for each next step. */
export const TURN_ERROR_ACTION_LABEL: Record<TurnErrorAction, string> = {
  retry: 'Retry',
  'provider-settings': 'Open provider settings',
  doctor: 'Run the doctor',
  'switch-model': 'Switch model'
}
