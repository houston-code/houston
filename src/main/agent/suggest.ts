import type { ChatMessage, Provider } from '@shared/agent'
import { collectSecrets, getProvider, getSettings } from '../agentHost'
import { createProvider } from '../providers'
import { peekConversation } from '../conversations'
import { providerStreamError, withProviderRetry } from './retry'
import { titleRequestOptions, type TitleRequestOptions } from './title'
import { redactSecrets } from './redact'
import { smallModelFor, withSmallModel } from '@shared/smallModel'

/**
 * Suggested next prompt. When a turn ends, and only when the user has turned it on
 * (it costs a model call), the provider's small model is asked (falling back to the
 * conversation's own), the way a chat title
 * is (no tools, a tiny token cap, no history beyond the last exchange), for one short
 * message the user is likely to send next. The desktop app shows it as ghost text in
 * the empty message box; Tab accepts it. Best-effort throughout: any failure just
 * means no suggestion. The pure pieces are unit-tested without a provider.
 */

/** Characters of the last exchange fed to the model; a suggestion needs the gist. */
const SOURCE_CHAR_BUDGET = 1500
/** Longest suggestion kept. */
export const MAX_SUGGESTION_LEN = 120
/** How long to let the call run before giving up. */
const SUGGEST_TIMEOUT_MS = 15_000
/** Retries: the suggestion is a nicety, so few. */
const SUGGEST_RETRIES = 1

export const suggestSystemPrompt = `You predict the next message a developer will send to their coding assistant, from the end of their conversation. Reply with only that message, written as the developer would type it: one short line, under 15 words, no quotes, no preamble. Make it a natural follow-up to the assistant's last reply (a next step, a check, a fix). If no follow-up is likely, reply with nothing.`

const INSTRUCTION = 'Write the next message now. Output only its text.'

/**
 * The compact message list for the call: the latest user request and the reply that
 * ended the turn, clipped, as one synthetic user turn. Null when the conversation
 * doesn't end on a reply with text.
 */
export function buildSuggestionMessages(messages: ChatMessage[]): ChatMessage[] | null {
  const last = messages.at(-1)
  if (!last || last.role !== 'assistant' || !last.content.trim()) return null
  const user = [...messages].reverse().find((m) => m.role === 'user' && !m.steered)
  const clip = (s: string): string => {
    const t = s.trim().replace(/\s+/g, ' ')
    return t.length > SOURCE_CHAR_BUDGET ? `…${t.slice(-SOURCE_CHAR_BUDGET)}` : t
  }
  let content = ''
  if (user) content += `Developer's last message:\n${clip(user.content)}\n\n`
  content += `Assistant's reply:\n${clip(last.content)}\n\n${INSTRUCTION}`
  // A credential in the chat stays out of a request it isn't needed for.
  return [{ role: 'user', content: redactSecrets(content, collectSecrets()) }]
}

/**
 * Clean the model's raw output into a suggestion: the first non-empty line, without
 * wrapping quotes, list markers or a label, whitespace collapsed, capped. Null when
 * nothing usable remains. Pure.
 */
export function sanitizeSuggestion(raw: string): string | null {
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return null
  let t = line.replace(/\s+/g, ' ')
  t = t.replace(/^(?:[-*+]|\d+[.)])\s+/, '')
  t = t.replace(/^(?:next message|suggestion|developer)\s*:\s*/i, '')
  t = t.replace(/^["'`“”]+/, '').replace(/["'`“”]+$/, '').trim()
  if (!t || /^(?:nothing|none|n\/a)\.?$/i.test(t)) return null
  return t.length > MAX_SUGGESTION_LEN ? `${t.slice(0, MAX_SUGGESTION_LEN - 1)}…` : t
}

/** Ask the provider for a suggestion (no tools) and sanitize it. Throws on a provider error. */
export async function generateSuggestion(
  provider: Provider,
  model: string,
  messages: ChatMessage[],
  signal: AbortSignal,
  request: TitleRequestOptions
): Promise<string | null> {
  const built = buildSuggestionMessages(messages)
  if (!built) return null
  const text = await withProviderRetry(
    async () => {
      let acc = ''
      for await (const ev of provider.streamChat({ model, system: suggestSystemPrompt, messages: built, ...request, signal })) {
        if (ev.type === 'text') acc += ev.text
        else if (ev.type === 'error') throw providerStreamError(ev)
      }
      return acc
    },
    { signal, maxRetries: SUGGEST_RETRIES }
  )
  return sanitizeSuggestion(text)
}

/** Conversations with a suggestion call in flight (one at a time per chat). */
const inFlight = new Set<string>()

/**
 * Suggest the next prompt for a conversation whose turn just ended, if the user turned
 * suggestions on. `onSuggestion` gets the text; nothing happens on any miss.
 */
export async function maybeSuggestNext(opts: {
  conversationId: string
  providerId: string
  model: string
  onSuggestion: (text: string) => void
}): Promise<void> {
  try {
    if (getSettings().suggestNextPrompt !== true) return
  } catch {
    return
  }
  if (inFlight.has(opts.conversationId)) return
  let provider: Provider
  let providerConfig: ReturnType<typeof getProvider>
  let conv: ReturnType<typeof peekConversation>
  try {
    conv = peekConversation(opts.conversationId)
    providerConfig = getProvider(opts.providerId)
    if (!conv || !providerConfig) return
    provider = createProvider(providerConfig)
  } catch {
    return // no usable key, unknown provider, unreadable chat: no suggestion
  }
  inFlight.add(opts.conversationId)
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), SUGGEST_TIMEOUT_MS)
  try {
    const cfg = providerConfig
    const text = await withSmallModel(
      smallModelFor(cfg, opts.model),
      opts.model,
      (model) => {
        const caps = cfg.models.find((m) => m.id === model)?.caps
        const request = titleRequestOptions(cfg.kind, model, caps)
        return generateSuggestion(provider, model, conv!.messages, abort.signal, request)
      },
      abort.signal,
      // "Nothing to suggest" is an answer, not a failure: only an error tries again.
      { retryEmpty: false }
    )
    if (text) opts.onSuggestion(text)
  } catch {
    // no suggestion
  } finally {
    clearTimeout(timer)
    inFlight.delete(opts.conversationId)
  }
}
