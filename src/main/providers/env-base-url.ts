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
