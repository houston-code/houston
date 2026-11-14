import { outboundFetch } from '../outbound-proxy'

/**
 * Ollama native-API helpers. Houston talks to Ollama through its OpenAI-compatible
 * `/v1` endpoint for chat, but capability metadata only lives on the native API.
 */

/**
 * Whether an Ollama model declares tool-calling support, via the native
 * `POST /api/show` `capabilities` array. Returns:
 *   - `true`  — the model lists the `tools` capability,
 *   - `false` — it definitively does not,
 *   - `null`  — undeterminable: server unreachable, not Ollama, model not pulled,
 *     or an Ollama too old to report `capabilities`.
 *
 * Callers MUST treat `null` as "unknown" and never warn on it — a false "no tool
 * support" warning (e.g. when Ollama is simply down) is worse than none.
 */
export async function ollamaSupportsTools(
  baseUrl: string,
  model: string,
  signal?: AbortSignal
): Promise<boolean | null> {
  // The OpenAI-compatible base ends in /v1; the native API sits at the server root.
  const root = baseUrl.replace(/\/v1\/?$/, '')
  let res: Response
  try {
    res = await outboundFetch(`${root}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `model` is the current field; `name` is the legacy alias — send both so the
      // probe works across Ollama versions. Unknown keys are ignored server-side.
      body: JSON.stringify({ model, name: model }),
      signal: signal ?? AbortSignal.timeout(4000)
    })
  } catch {
    return null // unreachable, timed out, or not an Ollama server
  }
  if (!res.ok) return null // 404 (no /api/show), model not pulled, etc.

  let data: unknown
  try {
    data = await res.json()
  } catch {
    return null
  }
  const caps = (data as { capabilities?: unknown }).capabilities
  if (!Array.isArray(caps)) return null // older Ollama: field absent → unknown
  return caps.includes('tools')
}

/**
 * The context window Ollama will actually run `model` with, in tokens, or null
 * when it can't be told. Ollama ignores the model's trained length unless asked
 * (its own default is a few thousand tokens), and its OpenAI-compatible endpoint
 * takes no `num_ctx`, so a prompt longer than that is cut from the front without
 * any error: the model silently loses Houston's instructions and the tool schemas.
 *
 * Read, in order of authority:
 *   - `GET /api/ps`: a loaded model's `context_length`, what it is running with now
 *     (reported by recent Ollama versions);
 *   - `POST /api/show`: a `num_ctx` the model's Modelfile sets.
 * Neither says what an `OLLAMA_CONTEXT_LENGTH` server setting is for a model that
 * isn't loaded yet, so that case is null (unknown), never a guess.
 */
export async function ollamaContextLength(
  baseUrl: string,
  model: string,
  signal?: AbortSignal
): Promise<{ contextLength: number; trained?: number } | null> {
  const root = baseUrl.replace(/\/v1\/?$/, '')
  const timeout = (): AbortSignal => signal ?? AbortSignal.timeout(4000)
  const json = async (path: string, init?: RequestInit): Promise<Record<string, unknown> | null> => {
    try {
      const res = await outboundFetch(`${root}${path}`, { ...init, signal: timeout() })
      if (!res.ok) return null
      const data = (await res.json()) as unknown
      return data && typeof data === 'object' ? (data as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  const positive = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined

  const show = await json('/api/show', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, name: model })
  })
  let trained: number | undefined
  const info = show?.model_info
  if (info && typeof info === 'object') {
    for (const [k, v] of Object.entries(info as Record<string, unknown>)) {
      if (k.endsWith('.context_length')) trained = positive(v) ?? trained
    }
  }
  const extra = trained ? { trained } : {}

  const ps = await json('/api/ps')
  const loaded = Array.isArray(ps?.models) ? (ps.models as Array<Record<string, unknown>>) : []
  const want = model.includes(':') ? model : `${model}:latest`
  const running = loaded.find((m) => m.name === model || m.model === model || m.name === want || m.model === want)
  const live = positive(running?.context_length)
  if (live) return { contextLength: live, ...extra }

  const params = typeof show?.parameters === 'string' ? show.parameters : ''
  const m = /^\s*num_ctx\s+(\d+)\s*$/m.exec(params)
  const set = m ? positive(Number(m[1])) : undefined
  return set ? { contextLength: set, ...extra } : null
}

/**
 * The notice for a run whose prompt (system prompt, tool schemas and conversation)
 * doesn't fit the context Ollama runs the model with, naming the fix. User-facing.
 */
export function ollamaContextNotice(model: string, contextLength: number, needed: number): string {
  const want = Math.max(32768, 2 ** Math.ceil(Math.log2(Math.max(needed, 1) * 1.5)))
  return (
    `Ollama is running ${model} with a ${contextLength.toLocaleString('en-US')}-token context, but this request ` +
    `needs about ${needed.toLocaleString('en-US')}, so Ollama will silently drop the start of it (Houston's ` +
    `instructions and tool definitions). Give it more room: start Ollama with OLLAMA_CONTEXT_LENGTH=${want}, ` +
    `or add "PARAMETER num_ctx ${want}" to the model's Modelfile and run "ollama create".`
  )
}

/** Whether a provider config points at an Ollama server (the built-in entry, or its port). */
export function isOllamaProvider(cfg: { id: string; kind: string; baseUrl?: string }): boolean {
  if (cfg.kind !== 'openai-compatible') return false
  if (cfg.id === 'ollama') return true
  try {
    return cfg.baseUrl ? new URL(cfg.baseUrl).port === '11434' : false
  } catch {
    return false
  }
}

/** Probed context lengths, briefly cached so back-to-back turns don't re-ask. */
const contextCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof ollamaContextLength>> }>()
const CONTEXT_CACHE_MS = 60_000

/** {@link ollamaContextLength}, remembered for a minute per server and model. */
export async function ollamaContextLengthCached(
  baseUrl: string,
  model: string,
  signal?: AbortSignal,
  now: () => number = Date.now
): Promise<Awaited<ReturnType<typeof ollamaContextLength>>> {
  const key = `${baseUrl}\n${model}`
  const hit = contextCache.get(key)
  if (hit && now() - hit.at < CONTEXT_CACHE_MS) return hit.value
  const value = await ollamaContextLength(baseUrl, model, signal)
  contextCache.set(key, { at: now(), value })
  return value
}

/** Forget cached probes (tests). */
export function resetOllamaContextCache(): void {
  contextCache.clear()
}
