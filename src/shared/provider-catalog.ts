/**
 * Catalog of known model hosts the user can add to their providers with one click.
 *
 * Most entries are just an `openai-compatible` preset. Houston already routes any
 * OpenAI-compatible endpoint through a single adapter (see
 * `src/main/providers/openai.ts`), so "adding a host" is usually data, not a new
 * provider kind — that keeps the host list from turning into a combinatorial set of
 * adapters. An entry only sets `kind` when the host genuinely can't be reached that
 * way: the cloud-hosted Claude backends sign requests with the cloud's own
 * credentials rather than a bearer token, which no base URL can express. They still
 * share the Anthropic adapter's streaming logic (see `src/main/providers/anthropic.ts`).
 *
 * The catalog is the *add menu* surfaced in Settings; it is deliberately NOT
 * auto-seeded into a user's provider list (that stays minimal — see
 * `src/shared/defaults.ts`). Entries are integration targets Houston *consumes*,
 * not services it bundles. Ollama and LM Studio are omitted because they ship as
 * built-in providers already.
 */
import type { ProviderConfig, ProviderKind } from './types'

/**
 * Claude models on Bedrock, addressed with Bedrock's `anthropic.` vendor prefix.
 * Bedrock exposes no Models API, so this curated list is both what an added provider
 * starts with and what "Fetch" returns (see `listModels` in main/providers/index.ts).
 * A starting point like every other seeded model list: which of them an account can
 * actually invoke depends on its region and model access, so the user edits it.
 */
export const BEDROCK_MODELS: string[] = [
  'anthropic.claude-opus-4-8',
  'anthropic.claude-sonnet-4-6',
  'anthropic.claude-haiku-4-5',
  'anthropic.claude-opus-4-7'
]

/**
 * Claude models on Vertex AI, addressed with the bare id. Vertex also accepts a dated
 * snapshot with an `@` separator (`claude-opus-4-5@20251101`), which the id
 * heuristics handle. Like Bedrock, Vertex has no Models API — same curated-list
 * contract as {@link BEDROCK_MODELS}.
 */
export const VERTEX_MODELS: string[] = [
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-opus-4-7'
]

export interface CatalogEntry {
  /**
   * Stable id, reused verbatim as the provider id when added. Adding is therefore
   * idempotent — the same host can't be added twice, and a saved API key keeps
   * attaching to the same id across re-adds. Must not collide with a built-in
   * provider id (see `defaultProviders`); a test enforces this.
   */
  id: string
  label: string
  /**
   * The adapter this host needs. Defaults to `openai-compatible` — set it only for a
   * host that can't be reached over an OpenAI-compatible base URL.
   */
  kind?: ProviderKind
  /**
   * Default OpenAI-compatible base URL (the user can edit it after adding). Absent
   * for native kinds, which derive their endpoint from the region instead.
   */
  baseUrl?: string
  /**
   * Default cloud region, for kinds that address models by region rather than URL.
   * Pre-filled on add so the provider works without a trip to the docs.
   */
  region?: string
  /**
   * Models an added provider starts with, for hosts that serve a fixed Claude lineup
   * and have no Models API. Absent elsewhere: the user fetches the live list.
   */
  models?: string[]
  /**
   * Whether a Houston-stored API key is required. Cloud aggregators need one; local
   * servers don't, and neither do the cloud-hosted Claude kinds, which resolve
   * ambient credentials (an AWS profile, gcloud ADC) on their own.
   */
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
    // edits it. `bedrock-aws` below is the SigV4/IAM counterpart; this entry keeps
    // its id (and so its stored key) untouched for anyone already on it.
    id: 'bedrock',
    label: 'Amazon Bedrock (API key)',
    baseUrl: 'https://bedrock-mantle.us-east-1.api.aws/v1',
    requiresKey: true,
    category: 'cloud',
    blurb: 'AWS-hosted models via a Bedrock API key. Edit the region in the URL.',
    docsUrl:
      'https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions-mantle.html'
  },
  {
    // Claude on Bedrock through the AWS credential chain — the IAM/SigV4 path the
    // preset above can't reach, since a bearer token is the only thing a base URL can
    // carry. A distinct id: `bedrock` is taken, and reusing it would silently
    // re-point an existing user's stored key at a different adapter.
    id: 'bedrock-aws',
    kind: 'bedrock',
    label: 'Amazon Bedrock (AWS credentials)',
    region: 'us-east-1',
    models: BEDROCK_MODELS,
    requiresKey: false,
    category: 'cloud',
    blurb: 'Claude on Bedrock, signed with your AWS credentials (profile, SSO, or IAM role).',
    docsUrl: 'https://docs.aws.amazon.com/bedrock/latest/userguide/what-is-bedrock.html'
  },
  {
    id: 'vertex',
    kind: 'vertex',
    label: 'Google Vertex AI',
    // Claude on Vertex is regional; us-east5 has the broadest model coverage, and the
    // user switches it in Settings.
    region: 'us-east5',
    models: VERTEX_MODELS,
    requiresKey: false,
    category: 'cloud',
    blurb: 'Claude on Vertex AI, authenticated with your Google Cloud credentials.',
    docsUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude'
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
 * An `openai-compatible` provider with no key and an empty model list unless the
 * entry says otherwise (the user fetches or types models after adding); a native
 * kind carries its adapter, region and curated model list through instead.
 *
 * Optional fields are omitted rather than set to `undefined`, so the config
 * round-trips through settings.json without gaining empty keys.
 */
export function catalogEntryToProvider(entry: CatalogEntry): ProviderConfig {
  return {
    id: entry.id,
    kind: entry.kind ?? 'openai-compatible',
    label: entry.label,
    ...(entry.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
    ...(entry.region !== undefined ? { region: entry.region } : {}),
    models: (entry.models ?? []).map((id) => ({ id })),
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
