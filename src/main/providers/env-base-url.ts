/**
 * The base URL a first-party SDK client really sends to: the configured one, else the
 * one its SDK reads from the environment when none is passed (`ANTHROPIC_BASE_URL`,
 * `OPENAI_BASE_URL`, trimmed, empty meaning unset, as the SDKs read them).
 *
 * Every "is this the first-party host" gate (gateway auth headers, the built-in web
 * search tool, `prompt_cache_key`, the local-server idle window) must test this value.
 * Testing only the configured one let an exported variable send requests to a gateway
 * while Houston still treated them as going to the first-party API.
 */
export function effectiveBaseUrl(
  configured: string | undefined,
  envVar: 'ANTHROPIC_BASE_URL' | 'OPENAI_BASE_URL'
): string | undefined {
  return configured || process.env[envVar]?.trim() || undefined
}

/**
 * Whether the built-in OpenAI provider goes through a gateway: a base URL, configured or
 * from `OPENAI_BASE_URL`, on any host but OpenAI's own. A gateway gets the Chat Completions
 * adapter (no PDFs, no `xhigh`, no hosted search, no `prompt_cache_key`); OpenAI's own host
 * keeps the Responses API, whichever way its URL was given. An unparseable URL counts as a
 * gateway, since the SDK would send to it as given.
 */
export function openaiUsesGateway(configured: string | undefined): boolean {
  const url = effectiveBaseUrl(configured, 'OPENAI_BASE_URL')
  if (!url) return false
  try {
    return new URL(url).hostname !== 'api.openai.com'
  } catch {
    return true
  }
}
