import type { ChatMessage, Provider } from '@shared/agent'
import { getProvider } from '../agentHost'
import { createProvider } from '../providers'
import { getConversation, needsGeneratedTitle, setGeneratedTitle } from '../conversations'

/**
 * Auto-titling. A fresh chat shows the truncated first message as an instant
 * placeholder; once the first turn finishes we ask the conversation's own model for
 * a short, specific title and quietly replace it. Best-effort throughout — any
 * failure (no key, offline, a weak local model, a timeout) just leaves the
 * placeholder in place. The pure pieces (prompt building, output sanitizing) are
 * unit-tested without a provider; {@link maybeGenerateTitle} drives the one impure
 * step and the persistence.
 */

/** Tokens the title call may produce — a title is a few words, so keep it tiny. */
export const TITLE_MAX_TOKENS = 32

/** Hard cap on the persisted title length (matches the first-message placeholder). */
const MAX_TITLE_LEN = 60

/** Per-source character budget fed to the model — a title needs the gist, not the whole turn. */
const SOURCE_CHAR_BUDGET = 1000

/** How long to let the title call run before abandoning it (keeps the placeholder). */
const TITLE_TIMEOUT_MS = 20_000

/** System prompt for the title call: prose only, short, no decoration. */
export const titleSystemPrompt = `You write a short, specific title for a coding-assistant conversation from its opening exchange. Reply with ONLY the title — no quotes, no markdown, no trailing punctuation, no preamble or explanation. Use 3 to 6 words in Title Case that name the concrete task or topic (for example: "Fix flaky auth test", "Add dark mode toggle", "Explain the build pipeline"). Never exceed 60 characters.`

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
  // Drop wrapping quotes/backticks some models add, then any trailing sentence period.
  t = t.replace(/^["'`“”]+/, '').replace(/["'`“”]+$/, '').trim()
  t = t.replace(/[.]+$/, '').trim()
  if (!t) return null
  return t.length > MAX_TITLE_LEN ? `${t.slice(0, MAX_TITLE_LEN - 1)}…` : t
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
  signal: AbortSignal
): Promise<string | null> {
  const built = buildTitleMessages(messages)
  if (!built) return null
  let text = ''
  for await (const ev of provider.streamChat({
    model,
    system: titleSystemPrompt,
    messages: built,
    maxTokens: TITLE_MAX_TOKENS,
    signal
  })) {
    if (ev.type === 'text') text += ev.text
    else if (ev.type === 'error') throw new Error(ev.message)
  }
  return sanitizeTitle(text)
}

/**
 * After a turn completes, give a still-auto-titled conversation a concise,
 * model-written title (at most once per chat). Builds its own provider from the
 * run's provider/model and bounds the call with a timeout so a slow model can't
 * leave a request hanging. Entirely best-effort: on any miss the placeholder title
 * stays. `onTitle` fires only when the new title actually persisted (a racing manual
 * rename wins inside {@link setGeneratedTitle}), so callers can push it live.
 */
export async function maybeGenerateTitle(opts: {
  conversationId: string
  providerId: string
  model: string
  onTitle?: (title: string) => void
}): Promise<void> {
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

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TITLE_TIMEOUT_MS)
  try {
    const title = await generateTitle(provider, opts.model, conv.messages, abort.signal)
    if (title && setGeneratedTitle(opts.conversationId, title)) opts.onTitle?.(title)
  } catch {
    // network/abort/provider error — silently keep the placeholder title.
  } finally {
    clearTimeout(timer)
  }
}
