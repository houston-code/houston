import type { ChatMessage, ChatRequest, Provider } from '@shared/agent'
import { modelHasReasoning } from '@shared/model-facts'
import type { ModelCaps, ProviderKind } from '@shared/types'
import { getProvider } from '../agentHost'
import { createProvider } from '../providers'
import { getConversation, needsGeneratedTitle, setGeneratedTitle } from '../conversations'
import { providerStreamError, withProviderRetry } from './retry'

/**
 * Auto-titling. A fresh chat shows the truncated first message as an instant
 * placeholder; as soon as the first turn starts we ask the conversation's own model,
 * in parallel with the turn, for a short, specific title and quietly replace it (so
 * the sidebar updates within seconds, not after a long agentic turn). If that attempt
 * misses, the turn's natural completion tries once more with the reply as extra
 * context. Best-effort throughout — any failure (no key, offline, a weak local model,
 * a timeout) just leaves the placeholder in place. The pure pieces (prompt building, output sanitizing) are
 * unit-tested without a provider; {@link maybeGenerateTitle} drives the one impure
 * step and the persistence.
 */

/** Tokens the title call may produce — a title is a few words, so keep it tiny. */
export const TITLE_MAX_TOKENS = 32

/**
 * The cap for a reasoning model on an adapter that passes the cap straight through.
 * Those hosts count reasoning against `max_tokens`, so at {@link TITLE_MAX_TOKENS} a
 * model that thinks by default spends the whole budget thinking and returns no text.
 * Paired with the lowest effort, this leaves room for a short think plus the title.
 */
export const TITLE_REASONING_MAX_TOKENS = 1024

/**
 * Kinds whose adapter sizes `max_tokens` around its own thinking budget (the Claude
 * and Gemini ones), so a reasoning model there already gets room for the reply.
 */
const SELF_BUDGETING_KINDS: ReadonlySet<ProviderKind> = new Set(['anthropic', 'bedrock', 'vertex', 'foundry', 'gemini'])

/** Hard cap on the persisted title length (matches the first-message placeholder). */
const MAX_TITLE_LEN = 60

/** Per-source character budget fed to the model — a title needs the gist, not the whole turn. */
const SOURCE_CHAR_BUDGET = 1000

/** How long to let the title call run before abandoning it (keeps the placeholder). */
const TITLE_TIMEOUT_MS = 20_000

/**
 * Far fewer retries than a turn gets. A title is cosmetic and already bounded by
 * TITLE_TIMEOUT_MS, so the default budget couldn't finish inside the window anyway — it
 * would just spend it on backoff and still produce nothing. Two quick retries cover the
 * blip this is actually worth defending against; past that, the placeholder is fine.
 */
const TITLE_RETRIES = 2

/**
 * Conversations with a title call already in flight. The turn-start and turn-end
 * triggers can overlap (a short turn finishes before its title arrives); this keeps
 * that to one provider call per chat instead of two racing ones.
 */
const inFlight = new Set<string>()

/** System prompt for the title call: prose only, short, no decoration. */
export const titleSystemPrompt = `You write a short, specific title for a coding-assistant conversation from its opening exchange. Reply with only the title: no quotes, no markdown, no trailing punctuation, no preamble or explanation. Use 3 to 6 words in Title Case that name the concrete task or topic (for example: "Fix flaky auth test", "Add dark mode toggle", "Explain the build pipeline"). Never exceed 60 characters.`

const TITLE_INSTRUCTION = 'Write the title now. Output only the title text.'

/**
 * Build the (compact) message list for the title call from a conversation's opening
 * turn — the first user request and the first non-empty assistant reply, each clipped
 * to a small budget and framed as one synthetic user turn so it behaves identically
 * across every provider's message-shape rules. Pure. Returns null when there's no
 * user message to summarize.
 */
export function buildTitleMessages(messages: ChatMessage[]): ChatMessage[] | null {
  const firstUser = messages.find((m) => m.role === 'user')
  if (!firstUser) return null
  const firstAssistant = messages.find((m) => m.role === 'assistant' && m.content.trim())
  const clip = (s: string): string => {
    const t = s.trim().replace(/\s+/g, ' ')
    return t.length > SOURCE_CHAR_BUDGET ? `${t.slice(0, SOURCE_CHAR_BUDGET)}…` : t
  }
  let content = `User's first message:\n${clip(firstUser.content)}`
  if (firstAssistant) content += `\n\nAssistant's reply:\n${clip(firstAssistant.content)}`
  content += `\n\n${TITLE_INSTRUCTION}`
  return [{ role: 'user', content }]
}

/**
 * Clean a model's raw title output into something safe to persist: first non-empty
 * line, stripped of wrapping quotes/backticks and trailing periods, whitespace
 * collapsed, capped at {@link MAX_TITLE_LEN}. Returns null when nothing usable
 * remains. Pure.
 */
export function sanitizeTitle(raw: string): string | null {
  const firstLine = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!firstLine) return null
  let t = firstLine.replace(/\s+/g, ' ').trim()
  // Despite "no markdown" in the prompt, models (small local ones especially) answer
  // with "## Fix auth", "**Fix auth**" or "Title: Fix auth". The sidebar and title bar
  // show the text literally, so strip the block markers, a leading label, and inline
  // emphasis/code/links down to the words.
  t = t.replace(/^(?:#{1,6}|>|[-*+]|\d+[.)])\s+/, '')
  t = t.replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(^|\s)[*_](\S(?:.*?\S)?)[*_](?=\s|$)/g, '$1$2')
  t = t.replace(/`([^`]+)`/g, '$1')
  // A link keeps its text: "[README](./README.md)" → "README". An image drops entirely.
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  t = t.replace(/^(?:chat\s+)?title\s*[:\-–—]\s*/i, '').trim()
  // Drop wrapping quotes/backticks some models add, then any trailing sentence period.
  t = t.replace(/^["'`“”]+/, '').replace(/["'`“”]+$/, '').trim()
  t = t.replace(/[.]+$/, '').replace(/\s+/g, ' ').trim()
  if (!t) return null
  return t.length > MAX_TITLE_LEN ? `${t.slice(0, MAX_TITLE_LEN - 1)}…` : t
}

/** The token cap and reasoning fields for a title call. */
export type TitleRequestOptions = Pick<ChatRequest, 'maxTokens' | 'reasoningEffort' | 'reasoningCapable'>

/**
 * Size the title call for the model serving it. A reasoning model behind an
 * OpenAI-style adapter gets the lowest effort and a cap with room to think: some
 * (OpenRouter's Qwen 3.8 Max, for one) reason by default at their highest effort and
 * can't turn it off, so the tiny cap alone always comes back empty. Everything else
 * keeps the tiny cap. Host capability metadata wins over the id heuristic, as on a
 * turn. Pure.
 */
export function titleRequestOptions(kind: ProviderKind, model: string, caps?: ModelCaps): TitleRequestOptions {
  const reasons = caps?.reasoning ?? modelHasReasoning(model)
  if (!reasons || SELF_BUDGETING_KINDS.has(kind)) return { maxTokens: TITLE_MAX_TOKENS }
  return {
    maxTokens: TITLE_REASONING_MAX_TOKENS,
    reasoningEffort: 'low',
    ...(caps?.reasoning !== undefined ? { reasoningCapable: caps.reasoning } : {})
  }
}

/**
 * Ask the provider for a title and sanitize it. Tools are omitted so the model can
 * only reply with prose. Returns null when the model produces nothing usable; throws
 * on a provider error event so the caller can swallow it.
 */
export async function generateTitle(
  provider: Provider,
  model: string,
  messages: ChatMessage[],
  signal: AbortSignal,
  request: TitleRequestOptions = { maxTokens: TITLE_MAX_TOKENS }
): Promise<string | null> {
  const built = buildTitleMessages(messages)
  if (!built) return null
  const text = await withProviderRetry(
    async () => {
      let acc = ''
      for await (const ev of provider.streamChat({
        model,
        system: titleSystemPrompt,
        messages: built,
        ...request,
        signal
      })) {
        if (ev.type === 'text') acc += ev.text
        else if (ev.type === 'error') throw providerStreamError(ev)
      }
      return acc
    },
    { signal, maxRetries: TITLE_RETRIES }
  )
  return sanitizeTitle(text)
}

/**
 * Give a still-auto-titled conversation a concise, model-written title (at most once
 * per chat; a call already in flight for it makes this a no-op). Builds its own
 * provider from the run's provider/model and bounds the call with a timeout so a slow
 * model can't leave a request hanging. Entirely best-effort: on any miss the placeholder title
 * stays. `onTitle` fires only when the new title actually persisted (a racing manual
 * rename wins inside {@link setGeneratedTitle}), so callers can push it live.
 */
export async function maybeGenerateTitle(opts: {
  conversationId: string
  providerId: string
  model: string
  onTitle?: (title: string) => void
}): Promise<void> {
  if (inFlight.has(opts.conversationId)) return
  const conv = getConversation(opts.conversationId)
  if (!conv || !needsGeneratedTitle(conv)) return

  const providerConfig = getProvider(opts.providerId)
  if (!providerConfig) return
  let provider: Provider
  try {
    provider = createProvider(providerConfig)
  } catch {
    return // no usable key / unknown provider — keep the placeholder
  }

  inFlight.add(opts.conversationId)
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TITLE_TIMEOUT_MS)
  try {
    const caps = providerConfig.models.find((m) => m.id === opts.model)?.caps
    const request = titleRequestOptions(providerConfig.kind, opts.model, caps)
    const title = await generateTitle(provider, opts.model, conv.messages, abort.signal, request)
    if (title && setGeneratedTitle(opts.conversationId, title)) opts.onTitle?.(title)
  } catch {
    // network/abort/provider error — silently keep the placeholder title.
  } finally {
    clearTimeout(timer)
    inFlight.delete(opts.conversationId)
  }
}
