import type { AppSettings, ModelOption, ProviderConfig } from '@shared/types'
import { isRedactedHeaderValue, providerHeaderScope } from '@shared/types'
import { customEndpointError, providerSetupFields } from '@shared/provider-catalog'
import { providerKeyEnvVars } from '@shared/provider-keys'
import { summarizeFetch } from '@shared/model-listing'
import type { Painter } from './tui'
import { stripControlChars } from './tui-wrap'

/**
 * Provider management in the terminal, beyond the /login key menu: remove an added
 * provider, forget a stored key, edit a provider's address fields and custom headers,
 * and refresh a provider's model list. The same operations as the desktop's
 * Settings > Providers & models page, over the same settings and key store.
 */

export type LoginOp =
  | { op: 'menu' }
  | { op: 'remove' | 'forget-key' | 'edit'; provider: string }
  | { op: 'usage' }

export const LOGIN_USAGE =
  'usage: /login   ·   /login edit <provider>   ·   /login remove <provider>   ·   /login forget-key <provider>'

/** Parse the argument of /login (and /providers). Bare command → the key menu. */
export function parseLoginArgs(arg: string): LoginOp {
  const [verb, ...rest] = arg.trim().split(/\s+/).filter(Boolean)
  if (!verb) return { op: 'menu' }
  // The rest is the provider: an id, or a label (which may have spaces).
  const provider = rest.join(' ')
  const v = verb.toLowerCase()
  const op =
    v === 'edit'
      ? 'edit'
      : v === 'remove' || v === 'rm' || v === 'delete'
        ? 'remove'
        : v === 'forget-key' || v === 'remove-key' || v === 'logout'
          ? 'forget-key'
          : null
  if (op && provider) return { op, provider }
  return { op: 'usage' }
}

export interface ProviderCommandDeps {
  getSettings: () => AppSettings
  updateSettings?: (patch: Partial<AppSettings>) => void
  /** Forget a stored API key; true if one was removed. Absent ⇒ no writable key store. */
  removeKey?: (id: string) => boolean
  readLine: (prompt: string, opts?: { discardPending?: boolean }) => Promise<string | null>
  /** A read that does not echo. Header values are never read without it. */
  readSecret?: (prompt: string) => Promise<string | null>
  /** False where settings saves can't persist header VALUES (the standalone CLI). */
  canStoreHeaderSecrets?: boolean
  /** Ask a provider for its models (the desktop's "Fetch models"). */
  fetchModels?: (provider: ProviderConfig) => Promise<ModelOption[]>
  /** The provider this chat runs on, which /login remove refuses to pull out from under it. */
  activeProviderId?: string
  /** The model this chat runs on, to warn when a refresh no longer lists it. */
  activeModel?: string
  out: (text: string) => void
}

const clean = (s: string): string => stripControlChars(s)

/** Find a configured provider by id, or by id/label ignoring case. */
export function findProvider(settings: AppSettings, query: string): ProviderConfig | undefined {
  const q = query.trim()
  const exact = settings.providers.find((p) => p.id === q)
  if (exact) return exact
  const lower = q.toLowerCase()
  return settings.providers.find((p) => p.id.toLowerCase() === lower || p.label?.toLowerCase() === lower)
}

function noSuchProvider(query: string, deps: ProviderCommandDeps, paint: Painter): void {
  const ids = deps.getSettings().providers.map((p) => p.id).join(', ')
  deps.out(paint(`· no provider "${clean(query)}". Configured: ${ids || 'none'}\n`, 'yellow'))
}

const isYes = (answer: string | null): boolean => /^\s*y(es)?\s*$/i.test(answer ?? '')

/** Run a parsed /login subcommand other than the menu (the caller owns that one). */
export async function runLoginOp(
  op: Exclude<LoginOp, { op: 'menu' }>,
  deps: ProviderCommandDeps,
  paint: Painter
): Promise<void> {
  if (op.op === 'usage') return void deps.out(paint(`· ${LOGIN_USAGE}\n`, 'dim'))
  const provider = findProvider(deps.getSettings(), op.provider)
  if (!provider) return noSuchProvider(op.provider, deps, paint)
  if (op.op === 'remove') return removeProvider(provider, deps, paint)
  if (op.op === 'forget-key') return forgetKey(provider, deps, paint)
  return editProvider(provider, deps, paint)
}

async function removeProvider(p: ProviderConfig, deps: ProviderCommandDeps, paint: Painter): Promise<void> {
  const name = clean(p.label ?? p.id)
  if (!deps.updateSettings) return void deps.out(paint('· removing a provider is unavailable here\n', 'dim'))
  if (p.builtIn) {
    deps.out(
      paint(
        `· ${name} is built in and can't be removed. Leave its key unset to keep it out of the way` +
          `${p.hasKey ? ', or forget its key with /login forget-key ' + p.id : ''}.\n`,
        'yellow'
      )
    )
    return
  }
  if (deps.activeProviderId === p.id) {
    deps.out(paint(`· this chat runs on ${name}. Switch to another model with /model first.\n`, 'yellow'))
    return
  }
  const ok = await deps.readLine(`Remove ${name} (${p.id}) and its model list? [y/N] `, { discardPending: true })
  if (!isYes(ok)) return void deps.out(paint('· nothing changed\n', 'dim'))
  const current = deps.getSettings()
  deps.updateSettings({ providers: current.providers.filter((q) => q.id !== p.id) })
  deps.out(paint(`· removed ${name}\n`, 'dim'))
  if (!p.hasKey || !deps.removeKey) return
  const forget = await deps.readLine(`Also forget its stored API key? [y/N] `, { discardPending: true })
  if (isYes(forget)) forgetKeyNow(p, deps, paint)
  else deps.out(paint(`· key kept. Forget it later with /login forget-key ${p.id}\n`, 'dim'))
}

async function forgetKey(p: ProviderConfig, deps: ProviderCommandDeps, paint: Painter): Promise<void> {
  if (!deps.removeKey) return void deps.out(paint('· forgetting a key is unavailable here\n', 'dim'))
  const name = clean(p.label ?? p.id)
  const ok = await deps.readLine(`Forget the stored API key for ${name}? [y/N] `, { discardPending: true })
  if (!isYes(ok)) return void deps.out(paint('· nothing changed\n', 'dim'))
  forgetKeyNow(p, deps, paint)
}

function forgetKeyNow(p: ProviderConfig, deps: ProviderCommandDeps, paint: Painter): void {
  const name = clean(p.label ?? p.id)
  const removed = deps.removeKey?.(p.id) ?? false
  deps.out(paint(removed ? `· forgot the stored key for ${name}\n` : `· no stored key for ${name}\n`, 'dim'))
  const env = providerKeyEnvVars(p.id).find((v) => process.env[v])
  if (env) deps.out(paint(`· ${env} is still set in your environment, so ${name} still has a key.\n`, 'yellow'))
}

/** One editable address field of a provider: the base URL or a kind's setup field. */
interface EditField {
  key: 'baseUrl' | 'region' | 'projectId' | 'endpoint' | 'apiVersion' | 'resource'
  label: string
  placeholder: string
  envVars: string[]
  required: boolean
}

/** Whether the desktop shows Base URL and Custom headers for this provider. */
function takesBaseUrl(p: ProviderConfig): boolean {
  return p.kind === 'openai-compatible' || p.baseUrl !== undefined
}

/** The address fields `/login edit` asks about, in the desktop's order. */
export function editableFields(p: ProviderConfig): EditField[] {
  const fields: EditField[] = []
  if (takesBaseUrl(p)) {
    fields.push({
      key: 'baseUrl',
      label: 'Base URL',
      placeholder: 'https://host/v1',
      envVars: [],
      required: p.kind === 'openai-compatible'
    })
  }
  for (const f of providerSetupFields(p.kind)) fields.push({ ...f })
  return fields
}

/** A valid HTTP header name (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/**
 * /login edit: walk the provider's address fields with today's values as the
 * Enter-to-keep answer, then its custom headers. Header values are secrets: read
 * without echo, saved through the settings store (which moves them to the
 * encrypted store), and never printed. Ctrl-D at any prompt cancels with nothing saved.
 */
async function editProvider(p: ProviderConfig, deps: ProviderCommandDeps, paint: Painter): Promise<void> {
  if (!deps.updateSettings) return void deps.out(paint('· editing a provider is unavailable here\n', 'dim'))
  const name = clean(p.label ?? p.id)
  const fields = editableFields(p)
  const showHeaders = takesBaseUrl(p)
  if (!fields.length && !showHeaders) {
    deps.out(paint(`· ${name} has no address fields to edit. Set its key with /login.\n`, 'dim'))
    return
  }
  deps.out(paint(`Editing ${name} (${p.id}). Enter keeps a value, - clears an optional one, Ctrl-D cancels.\n`, 'bold'))
  const next: ProviderConfig = { ...p }
  const changed: string[] = []
  for (const f of fields) {
    const current = p[f.key]
    const env = f.envVars.find((v) => process.env[v])
    const hint = current ? `now ${clean(current)}` : f.required ? `e.g. ${f.placeholder}` : 'Enter to skip'
    deps.out(paint(`${f.label} (${hint})${env ? `; ${env} is set in your environment` : ''}:`, 'dim') + '\n')
    const answer = await deps.readLine(paint(`${f.key} › `, 'green'))
    if (answer === null) return void deps.out(paint('· cancelled, nothing changed\n', 'dim'))
    const value = answer.trim()
    if (!value) continue
    if (value === '-') {
      if (!current) continue
      if (f.required) {
        deps.out(paint(`· ${f.label} is required; kept ${clean(current)}\n`, 'yellow'))
        continue
      }
      delete next[f.key]
      changed.push(`${f.label} cleared`)
      continue
    }
    if ((f.key === 'baseUrl' || f.key === 'endpoint') && customEndpointError(name || p.id, value)) {
      deps.out(
        paint(`· ${f.label} must start with http:// or https://; kept ${current ? clean(current) : 'it unset'}\n`, 'yellow')
      )
      continue
    }
    if (value !== current) {
      next[f.key] = value
      changed.push(`${f.label} → ${clean(value)}`)
    }
  }

  if (showHeaders) {
    const headers = await editHeaders(p, deps, paint)
    if (headers === null) return void deps.out(paint('· cancelled, nothing changed\n', 'dim'))
    if (headers.changed.length) {
      next.headers = Object.keys(headers.value).length ? headers.value : undefined
      changed.push(...headers.changed)
    }
  }

  if (!changed.length) return void deps.out(paint('· nothing changed\n', 'dim'))
  const current = deps.getSettings()
  deps.updateSettings({ providers: current.providers.map((q) => (q.id === p.id ? { ...q, ...pickEdited(next) } : q)) })
  deps.out(paint(`· saved ${name}: ${changed.join(', ')}\n`, 'dim'))
}

/** The fields /login edit owns, so a save never writes back a stale copy of the rest. */
function pickEdited(p: ProviderConfig): Partial<ProviderConfig> {
  return {
    baseUrl: p.baseUrl,
    region: p.region,
    projectId: p.projectId,
    endpoint: p.endpoint,
    apiVersion: p.apiVersion,
    resource: p.resource,
    headers: p.headers
  }
}

/**
 * The custom-headers step of /login edit. Returns the new header map (stored values
 * kept as their mask, which the store reads as "unchanged") and what changed, by
 * name only. Null when the user cancels.
 */
async function editHeaders(
  p: ProviderConfig,
  deps: ProviderCommandDeps,
  paint: Painter
): Promise<{ value: Record<string, string>; changed: string[] } | null> {
  const value: Record<string, string> = { ...(p.headers ?? {}) }
  const names = Object.keys(value)
  deps.out(
    paint(`Custom headers: ${names.length ? names.map(clean).join(', ') : 'none'} (values are never shown)\n`, 'dim')
  )
  if (deps.canStoreHeaderSecrets === false) {
    deps.out(
      paint(
        `· this terminal can't store header values; put them in cli-headers.json under the scope "${providerHeaderScope(p.id)}"\n`,
        'dim'
      )
    )
    return { value, changed: [] }
  }
  const changed: string[] = []
  for (;;) {
    const line = await deps.readLine(paint('header name (Enter when done, -Name removes one) › ', 'green'))
    if (line === null) return null
    const raw = line.trim()
    if (!raw) break
    const removing = raw.startsWith('-')
    const headerName = removing ? raw.slice(1).trim() : raw.replace(/:$/, '')
    if (!HEADER_NAME.test(headerName)) {
      deps.out(paint('· not a header name (letters, digits and - only, no spaces or colons)\n', 'yellow'))
      continue
    }
    const existing = Object.keys(value).find((k) => k.toLowerCase() === headerName.toLowerCase())
    if (removing) {
      if (!existing) {
        deps.out(paint(`· no header ${headerName}\n`, 'yellow'))
        continue
      }
      delete value[existing]
      changed.push(`header ${existing} removed`)
      continue
    }
    if (!deps.readSecret) {
      deps.out(paint("· this terminal can't read a value without showing it; set headers in the desktop app\n", 'yellow'))
      return { value, changed }
    }
    const secret = await deps.readSecret(paint(`value for ${headerName} (hidden) › `, 'green'))
    if (secret === null) return null
    const v = secret.trim()
    if (!v || isRedactedHeaderValue(v)) {
      deps.out(paint('· no value entered, header unchanged\n', 'dim'))
      continue
    }
    if (existing && existing !== headerName) delete value[existing]
    value[headerName] = v
    changed.push(`header ${headerName} ${existing ? 'replaced' : 'added'}`)
  }
  return { value, changed }
}

/**
 * `/model refresh [provider]`: ask the provider for its models and adopt the list,
 * keeping a label the user curated for an id, as the desktop's Fetch models does.
 * An empty answer keeps the current list rather than wiping it.
 */
export async function refreshProviderModels(
  query: string | undefined,
  deps: ProviderCommandDeps,
  paint: Painter
): Promise<void> {
  const settings = deps.getSettings()
  const p = query ? findProvider(settings, query) : settings.providers.find((q) => q.id === deps.activeProviderId)
  if (!p) return query ? noSuchProvider(query, deps, paint) : void deps.out(paint('· usage: /model refresh [provider]\n', 'dim'))
  const name = clean(p.label ?? p.id)
  if (!deps.fetchModels || !deps.updateSettings) {
    return void deps.out(paint('· fetching models is unavailable here\n', 'dim'))
  }
  if (p.requiresKey && !p.hasKey && !providerKeyEnvVars(p.id).some((v) => process.env[v])) {
    return void deps.out(paint(`· ${name} has no API key yet. Set one with /login first.\n`, 'yellow'))
  }
  deps.out(paint(`· asking ${name} for its models…\n`, 'dim'))
  let fetched: ModelOption[]
  try {
    fetched = await deps.fetchModels(p)
  } catch (e) {
    return void deps.out(paint(`· could not fetch models from ${name}: ${clean((e as Error).message)}\n`, 'yellow'))
  }
  if (!fetched.length) return void deps.out(paint(`· ${name} listed no models; kept the current list\n`, 'yellow'))
  const latest = deps.getSettings().providers.find((q) => q.id === p.id) ?? p
  const before = latest.models
  const prev = new Map(before.map((m) => [m.id, m]))
  const models = fetched.map((m) => {
    const had = prev.get(m.id)
    return { ...m, label: m.label ?? had?.label, ...(had?.addedAt ? { addedAt: had.addedAt } : {}) }
  })
  deps.updateSettings({
    providers: deps.getSettings().providers.map((q) => (q.id === p.id ? { ...q, models } : q))
  })
  const s = summarizeFetch(p.kind, before, models)
  const list = (ids: string[]): string => (ids.length > 5 ? `${ids.slice(0, 5).join(', ')}, …` : ids.join(', '))
  const parts = [`${s.total} model${s.total === 1 ? '' : 's'}`]
  if (s.added.length) parts.push(`${s.added.length} new: ${list(s.added.map(clean))}`)
  if (s.removed.length) parts.push(`${s.removed.length} no longer listed: ${list(s.removed.map(clean))}`)
  deps.out(paint(`· ${name}: ${parts.join('; ')}\n`, 'dim'))
  if (s.unrecognised.length) {
    deps.out(paint(`· not yet known to this version (no price shown): ${list(s.unrecognised.map(clean))}\n`, 'dim'))
  }
  if (deps.activeProviderId === p.id && deps.activeModel && !models.some((m) => m.id === deps.activeModel)) {
    deps.out(paint(`· this chat's model ${clean(deps.activeModel)} is no longer listed; /model picks another\n`, 'yellow'))
  }
}
