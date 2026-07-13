import type { AppSettings, ProviderConfig } from '@shared/types'
import {
  catalogForPlatform,
  catalogEntryToProvider,
  customEndpointError,
  customEndpointToProvider,
  customProviderId,
  type CatalogEntry
} from '@shared/provider-catalog'
import { providerKeyEnvVars } from '@shared/provider-keys'

/**
 * `houston providers` — CLI parity with the desktop Settings for registering model
 * hosts and their keys. Subcommands:
 *
 *   houston providers [list]        list configured providers + hosts you can add
 *   houston providers add <id>      add a catalog host (OpenRouter, Groq, …)
 *   houston providers add --url <url> [--label <l>] [--id <id>]   add a custom endpoint
 *   houston providers remove <id>   remove a non-built-in provider
 *   houston providers set-key <id> [key]   store a key in cli-credentials.json
 *   houston providers remove-key <id>      forget a stored key
 *
 * Pure and dependency-injected (settings/keys/output are passed in) so it unit-tests
 * without a real profile dir; cli/index.ts wires the real store + credential file.
 */

export interface ProvidersDeps {
  getSettings: () => AppSettings
  saveSettings: (s: AppSettings) => AppSettings
  /** True when a key resolves for this id (env or cli-credentials.json). */
  hasKey: (id: string) => boolean
  /** Persist a key; reports the env var currently shadowing it, if any. */
  setKey: (id: string, key: string) => { shadowedByEnv: string | null }
  /** Forget a stored key; true if one was removed. */
  removeKey: (id: string) => boolean
  out: (s: string) => void
  err: (s: string) => void
  isMac: boolean
  /** Generate an id for a custom endpoint (injected so this stays pure/testable). */
  newId?: () => string
  /** A secret piped on stdin when not given as an arg; null when stdin is a TTY. */
  readStdin?: () => Promise<string | null>
}

/** Route `houston providers <sub> …`. Returns a process exit code. */
export async function runProvidersCommand(args: string[], deps: ProvidersDeps): Promise<number> {
  const [sub, ...rest] = args
  switch (sub ?? 'list') {
    case 'list':
    case 'ls':
      return listProviders(deps)
    case 'add':
      return addProvider(rest, deps)
    case 'remove':
    case 'rm':
      return removeProvider(rest[0], deps)
    case 'set-key':
      return setKeyCommand(rest, deps)
    case 'remove-key':
      return removeKeyCommand(rest[0], deps)
    default:
      deps.err(`Unknown subcommand: providers ${sub}\n${PROVIDERS_USAGE}`)
      return 2
  }
}

export const PROVIDERS_USAGE = `Usage:
  houston providers [list]              list configured providers and hosts to add
  houston providers add <id>            add a catalog host (e.g. openrouter, groq)
  houston providers add --url <url> [--label <l>] [--id <id>]
                                        add a custom OpenAI-compatible endpoint
  houston providers remove <id>         remove a non-built-in provider
  houston providers set-key <id> [key]  store an API key (key from arg or stdin)
  houston providers remove-key <id>     forget a stored API key
`

/** One key-status label for a configured provider. */
function keyStatus(p: ProviderConfig, deps: ProvidersDeps): string {
  if (!p.requiresKey) return 'no key needed'
  return deps.hasKey(p.id) ? 'key set' : 'NO KEY'
}

function listProviders(deps: ProvidersDeps): number {
  const settings = deps.getSettings()
  const configured = new Set(settings.providers.map((p) => p.id))

  deps.out('Configured providers:\n')
  for (const p of settings.providers) {
    const label = p.label ?? p.id
    const models = p.models.length === 1 ? '1 model' : `${p.models.length} models`
    deps.out(`  ${p.id.padEnd(14)} ${keyStatus(p, deps).padEnd(12)} ${models}  (${label})\n`)
  }

  const addable = catalogForPlatform(deps.isMac).filter((e) => !configured.has(e.id))
  if (addable.length) {
    deps.out('\nAvailable to add (houston providers add <id>):\n')
    for (const e of addable) {
      deps.out(`  ${e.id.padEnd(14)} ${e.label}  — ${e.blurb}\n`)
    }
  }
  return 0
}

/** Parsed `providers add` args: a positional host id, plus custom-endpoint flags. */
interface AddArgs {
  positional?: string
  id?: string
  url?: string
  label?: string
}

/** Pull `--url`/`--label`/`--id` flags and the first positional out of `add`'s args. */
function parseAddArgs(rest: string[]): AddArgs {
  const out: AddArgs = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--url') out.url = rest[++i]
    else if (a === '--label') out.label = rest[++i]
    else if (a === '--id') out.id = rest[++i]
    else if (!a.startsWith('-') && out.positional === undefined) out.positional = a
  }
  return out
}

function addProvider(rest: string[], deps: ProvidersDeps): number {
  const args = parseAddArgs(rest)
  // `--url` → a custom OpenAI-compatible endpoint (GUI parity with "Add custom").
  if (args.url !== undefined) return addCustomEndpoint(args, deps)

  const id = args.positional
  if (!id) {
    deps.err(`Pass a host id, e.g. "houston providers add openrouter", or --url for a custom endpoint.\n${PROVIDERS_USAGE}`)
    return 2
  }
  const settings = deps.getSettings()
  if (settings.providers.some((p) => p.id === id)) {
    deps.out(`Provider "${id}" is already configured. Set its key with: houston providers set-key ${id}\n`)
    return 0
  }
  const entry: CatalogEntry | undefined = catalogForPlatform(deps.isMac).find((e) => e.id === id)
  if (!entry) {
    const ids = catalogForPlatform(deps.isMac)
      .map((e) => e.id)
      .join(', ')
    deps.err(`Unknown host "${id}". Known hosts: ${ids}  (or add a custom one with --url)\n`)
    return 2
  }
  deps.saveSettings({
    ...settings,
    providers: [...settings.providers, catalogEntryToProvider(entry)]
  })
  deps.out(`Added ${entry.label} (${entry.id}) at ${entry.baseUrl}.\n`)
  if (entry.requiresKey) {
    deps.out(`Set its key with: houston providers set-key ${entry.id}\n`)
  }
  return 0
}

/** Add a custom OpenAI-compatible endpoint from `--url` (+ optional `--label`/`--id`). */
function addCustomEndpoint(args: AddArgs, deps: ProvidersDeps): number {
  const url = args.url?.trim() ?? ''
  const label = args.label?.trim() || 'Custom endpoint'
  const err = customEndpointError(label, url)
  if (err) {
    deps.err(`${err} (e.g. --url https://router.internal/v1)\n`)
    return 2
  }
  const settings = deps.getSettings()
  const id = args.id?.trim() || customProviderId(deps.newId?.() ?? '')
  if (settings.providers.some((p) => p.id === id)) {
    deps.err(`A provider with id "${id}" already exists (pass a different --id).\n`)
    return 2
  }
  const provider = customEndpointToProvider(id, label, url)
  deps.saveSettings({ ...settings, providers: [...settings.providers, provider] })
  deps.out(`Added ${label} (${id}) at ${url}.\n`)
  deps.out(`If it needs a key:  houston providers set-key ${id}\n`)
  deps.out(`Pick a model at run time with:  --model ${id}/<model-id>\n`)
  return 0
}

function removeProvider(id: string | undefined, deps: ProvidersDeps): number {
  if (!id) {
    deps.err(`Pass a provider id, e.g. "houston providers remove openrouter".\n${PROVIDERS_USAGE}`)
    return 2
  }
  const settings = deps.getSettings()
  const p = settings.providers.find((pr) => pr.id === id)
  if (!p) {
    deps.err(`No configured provider "${id}".\n`)
    return 2
  }
  if (p.builtIn) {
    deps.err(`"${id}" is a built-in provider and can't be removed (leave its key unset to disable it).\n`)
    return 2
  }
  deps.saveSettings({
    ...settings,
    providers: settings.providers.filter((pr) => pr.id !== id)
  })
  deps.out(`Removed provider "${id}". Any stored key is kept; forget it with: houston providers remove-key ${id}\n`)
  return 0
}

async function setKeyCommand(rest: string[], deps: ProvidersDeps): Promise<number> {
  const [id, ...keyArgs] = rest
  if (!id) {
    deps.err(`Pass a provider id, e.g. "houston providers set-key openrouter".\n${PROVIDERS_USAGE}`)
    return 2
  }
  // Key from a positional arg / --key, else piped stdin (so it isn't echoed or left
  // in shell history). We never solicit it interactively with a visible prompt.
  const flagIdx = keyArgs.indexOf('--key')
  let key: string | undefined = flagIdx >= 0 ? keyArgs[flagIdx + 1] : keyArgs[0]
  if (!key && deps.readStdin) key = (await deps.readStdin()) ?? undefined
  key = key?.trim()
  if (!key) {
    deps.err(
      `No key given. Pass it as an argument, or pipe it in:\n` +
        `  houston providers set-key ${id} <key>\n` +
        `  printf %s "<key>" | houston providers set-key ${id}\n`
    )
    return 2
  }

  const known = deps.getSettings().providers.some((p) => p.id === id)
  if (!known) {
    deps.err(`Note: "${id}" isn't a configured provider yet — add it with: houston providers add ${id}\n`)
  }
  const { shadowedByEnv } = deps.setKey(id, key)
  deps.out(`Saved key for "${id}" to cli-credentials.json (0600).\n`)
  if (shadowedByEnv) {
    deps.out(
      `Note: ${shadowedByEnv} is set in your environment and takes precedence over the stored key.\n`
    )
  }
  return 0
}

function removeKeyCommand(id: string | undefined, deps: ProvidersDeps): number {
  if (!id) {
    deps.err(`Pass a provider id, e.g. "houston providers remove-key openrouter".\n${PROVIDERS_USAGE}`)
    return 2
  }
  const removed = deps.removeKey(id)
  if (removed) {
    deps.out(`Removed stored key for "${id}".\n`)
    const stillEnv = providerKeyEnvVars(id).find((name) => process.env[name])
    if (stillEnv) {
      deps.out(`Note: ${stillEnv} is still set in your environment, so "${id}" still has a key.\n`)
    }
    return 0
  }
  deps.out(`No stored key for "${id}" in cli-credentials.json (nothing to remove).\n`)
  return 0
}
