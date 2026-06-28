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
    res = await fetch(`${root}/api/show`, {
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
