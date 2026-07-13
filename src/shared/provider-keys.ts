/**
 * Conventional API-key environment-variable names per provider id, and the
 * guidance shown when a required key is missing. Single source of truth shared by
 * the CLI's credential resolution + redaction (src/cli/credentials.ts) and the
 * host-neutral missing-key preflight (src/main/headless.ts), so the two can't
 * drift. Pure and dependency-free (no Electron, no Node APIs) so both the main and
 * CLI graphs — and the unit tests — can import it.
 */

/**
 * Well-known env vars for each provider id's key, tried before the generic
 * `HOUSTON_API_KEY_<ID>` form. Covers the built-in providers plus the cloud hosts
 * in the provider catalog (see provider-catalog.ts), using each service's
 * documented variable name so a user who already exports it just works.
 */
const PROVIDER_KEY_ENV_VARS: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  groq: ['GROQ_API_KEY'],
  deepinfra: ['DEEPINFRA_API_KEY'],
  hyperbolic: ['HYPERBOLIC_API_KEY'],
  bedrock: ['AWS_BEARER_TOKEN_BEDROCK']
}

/** `HOUSTON_API_KEY_<ID>` with the id uppercased and non-alphanumerics collapsed to `_`. */
export function genericKeyEnvVar(id: string): string {
  return `HOUSTON_API_KEY_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
}

/**
 * The env var names that resolve a key for `id`, in precedence order: the
 * provider's documented name(s), then the generic `HOUSTON_API_KEY_<ID>` fallback.
 * An unknown id (a user's custom provider) gets just the generic form.
 */
export function providerKeyEnvVars(id: string): string[] {
  return [...(PROVIDER_KEY_ENV_VARS[id] ?? []), genericKeyEnvVar(id)]
}

/** Every documented provider key env var name (for the CLI's redaction scanner). */
export function allProviderKeyEnvVars(): string[] {
  return Object.values(PROVIDER_KEY_ENV_VARS).flat()
}

/**
 * Actionable message for a provider whose required API key isn't set. Replaces the
 * raw provider error (e.g. `invalid x-api-key`) that a keyless run otherwise fails
 * with. Names the primary env var and points at the CLI's other credential sources;
 * the desktop app is mentioned since this path is shared with its headless mode.
 */
export function missingKeyHint(id: string): string {
  const vars = providerKeyEnvVars(id)
  const generic = genericKeyEnvVar(id)
  const envPart = vars.length > 1 ? `${vars[0]} (or ${generic})` : generic
  return (
    `No API key set for provider "${id}". Set ${envPart}, or add "${id}" to ` +
    `cli-credentials.json in your profile dir, then re-run. ` +
    `(The CLI's "houston providers" command can set this up; the desktop app uses Settings.)`
  )
}
