/**
 * Catalog of known model hosts the user can add to their providers with one click.
 *
 * Every entry is just an `openai-compatible` preset. Houston already routes any
 * OpenAI-compatible endpoint through a single adapter (see
 * `src/main/providers/openai.ts`), so "adding a host" is data, not a new provider
 * kind — that keeps the host list from turning into a combinatorial set of adapters.
 *
 * The catalog is the *add menu* surfaced in Settings; it is deliberately NOT
 * auto-seeded into a user's provider list (that stays minimal — see
 * `src/shared/defaults.ts`). Entries are integration targets Houston *consumes*,
 * not services it bundles. Ollama and LM Studio are omitted because they ship as
 * built-in providers already.
 */
import type { ProviderConfig } from './types'

export interface CatalogEntry {
  /**
   * Stable id, reused verbatim as the provider id when added. Adding is therefore
   * idempotent — the same host can't be added twice, and a saved API key keeps
   * attaching to the same id across re-adds. Must not collide with a built-in
   * provider id (see `defaultProviders`); a test enforces this.
   */
  id: string
  label: string
  /** Default OpenAI-compatible base URL (the user can edit it after adding). */
  baseUrl: string
  /** Cloud aggregators need an API key; local/self-hosted servers usually don't. */
  requiresKey: boolean
  /** Where the host runs — used to group the picker. */
  category: 'cloud' | 'local'
  /** One-line description, shown as the option's hover title. */
  blurb: string
  /** Docs / sign-up URL. */
  docsUrl?: string
  /** Restrict the preset to a platform (e.g. oMLX is Apple-Silicon only). */
  platform?: 'darwin'
}

/**
 * Known hosts. Base URLs are the documented OpenAI-compatible endpoints for each
 * service. Cloud entries route through the host's own API key; local entries point
 * at a server the user runs themselves.
 */
export const PROVIDER_CATALOG: CatalogEntry[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    category: 'cloud',
    blurb: 'Unified routing to hundreds of models across many providers, one key.',
    docsUrl: 'https://openrouter.ai/docs'
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    requiresKey: true,
    category: 'cloud',
    blurb: 'Hosted open models (Llama, Qwen, DeepSeek, Mistral) at scale.',
    docsUrl: 'https://docs.together.ai'
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    requiresKey: true,
    category: 'cloud',
    blurb: 'Fast hosted open models with function calling.',
    docsUrl: 'https://docs.fireworks.ai'
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    requiresKey: true,
    category: 'cloud',
    blurb: 'Very low-latency inference (Llama, Qwen, and more).',
    docsUrl: 'https://console.groq.com/docs'
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    requiresKey: true,
    category: 'cloud',
    blurb: 'Low-cost hosted open models.',
    docsUrl: 'https://deepinfra.com/docs'
  },
  {
    id: 'hyperbolic',
    label: 'Hyperbolic',
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    requiresKey: true,
    category: 'cloud',
    blurb: 'Hosted open and base models.',
    docsUrl: 'https://docs.hyperbolic.xyz'
  },
  {
    // Bedrock's recommended OpenAI-compatible endpoint (bedrock-mantle) accepts an
    // Amazon Bedrock API key as a bearer token, so it rides the openai-compatible
    // path with no AWS SigV4 — the cheap cloud win. Region is in the host; the user
    // edits it. (IAM/SigV4 access is the separate Tier-2 work, not this preset.)
    id: 'bedrock',
    label: 'Amazon Bedrock',
    baseUrl: 'https://bedrock-mantle.us-east-1.api.aws/v1',
    requiresKey: true,
    category: 'cloud',
    blurb: 'AWS-hosted models via a Bedrock API key. Edit the region in the URL.',
    docsUrl:
      'https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions-mantle.html'
  },
  {
    id: 'omlx',
    label: 'oMLX (Apple Silicon)',
    baseUrl: 'http://localhost:8000/v1',
    requiresKey: false,
    category: 'local',
    blurb: 'Local MLX inference server for Apple Silicon. Default port 8000.',
    docsUrl: 'https://omlx.ai',
    platform: 'darwin'
  },
  {
    id: 'vllm',
    label: 'vLLM',
    baseUrl: 'http://localhost:8000/v1',
    requiresKey: false,
    category: 'local',
    blurb: 'Self-hosted high-throughput server. Default port 8000.',
    docsUrl: 'https://docs.vllm.ai'
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp server',
    baseUrl: 'http://localhost:8080/v1',
    requiresKey: false,
    category: 'local',
    blurb: 'Self-hosted llama.cpp OpenAI server. Default port 8080.',
    docsUrl: 'https://github.com/ggml-org/llama.cpp'
  }
]

/** The catalog filtered to entries available on the current platform. */
export function catalogForPlatform(isMac: boolean): CatalogEntry[] {
  return PROVIDER_CATALOG.filter((e) => e.platform !== 'darwin' || isMac)
}

/**
 * Turn a catalog entry into a fresh provider config ready to append to settings.
 * Always an `openai-compatible` provider with no key and an empty model list (the
 * user fetches or types models after adding).
 */
export function catalogEntryToProvider(entry: CatalogEntry): ProviderConfig {
  return {
    id: entry.id,
    kind: 'openai-compatible',
    label: entry.label,
    baseUrl: entry.baseUrl,
    models: [],
    requiresKey: entry.requiresKey,
    hasKey: false,
    builtIn: false
  }
}

/**
 * A stable `custom-<8 hex>` id for a user-supplied endpoint, derived from a UUID (or
 * any seed). Shared so every client (GUI Settings, TUI /login, CLI providers add)
 * mints the same shape — a bare `randomUUID().slice(0,8)` and a hand-rolled strip
 * had drifted apart. Falls back to `custom-endpoint` for an empty/degenerate seed.
 */
export function customProviderId(seed: string): string {
  const hex = seed.replace(/[^a-z0-9]/gi, '').slice(0, 8)
  return `custom-${hex || 'endpoint'}`
}

/**
 * Build a provider config for a user-supplied OpenAI-compatible endpoint (a label + a
 * base URL). Keyless by default like a local server — the user attaches a key
 * afterward if the endpoint needs one. Shared by all three clients so the shape can't
 * drift (mirrors {@link catalogEntryToProvider} for the known-host path).
 */
export function customEndpointToProvider(id: string, label: string, baseUrl: string): ProviderConfig {
  return {
    id,
    kind: 'openai-compatible',
    label,
    baseUrl,
    models: [],
    requiresKey: false,
    hasKey: false,
    builtIn: false
  }
}

/**
 * Validate a custom endpoint's label + base URL. Returns an error message, or null
 * when both are acceptable. One rule for every client so validation can't differ by
 * surface (the GUI used to accept a bare host or a non-http scheme).
 */
export function customEndpointError(label: string, url: string): string | null {
  if (!label.trim()) return 'a label is required'
  const u = url.trim()
  if (!u) return 'a base URL is required'
  if (!/^https?:\/\//i.test(u)) return 'the base URL must start with http:// or https://'
  return null
}
