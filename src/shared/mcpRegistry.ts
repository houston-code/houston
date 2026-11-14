import type { McpServerConfig } from './types'
import { sanitizeServerId } from './mcp'
import type { McpDraft, McpDraftInput } from './mcpCatalog'

/**
 * The official MCP Registry (registry.modelcontextprotocol.io), read-only.
 *
 * Everything in a registry entry is written by whoever published it, so it is
 * untrusted display data: `normalizeRegistryPage` keeps only the fields Houston
 * shows or converts, as plain capped strings with control and bidi characters
 * removed, and `registryInstallOptions` turns an entry into a server config for the
 * user to review. Nothing here runs a command or puts registry text in a prompt; the
 * converted config is saved switched off, through the same review form as the
 * built-in catalog, and only the user can switch it on.
 *
 * Commands are chosen by Houston from the package type (npx, uvx, docker), never
 * taken from the entry's `runtimeHint` or runtime arguments, and every package is
 * pinned to an exact version.
 */

export const MCP_REGISTRY_ORIGIN = 'https://registry.modelcontextprotocol.io'

/** A required (or optional) environment variable or header an entry asks for. */
export type RegistryInput = McpDraftInput

export interface RegistryArgument {
  type: 'positional' | 'named'
  /** Flag name for a named argument (`--port`). */
  name?: string
  value?: string
  valueHint?: string
  required: boolean
}

export interface RegistryPackage {
  /** npm, pypi, oci, or another type Houston can't install (shown, not converted). */
  registryType: string
  identifier: string
  version?: string
  /** stdio, streamable-http or sse. */
  transport: string
  env: RegistryInput[]
  packageArguments: RegistryArgument[]
  /** Kept only to tell the user what was left out (Houston picks runtime flags itself). */
  runtimeArguments: RegistryArgument[]
}

export interface RegistryRemote {
  /** streamable-http or sse. */
  type: string
  url: string
  headers: RegistryInput[]
}

export interface RegistryServer {
  /** Reverse-DNS name, e.g. `io.github.owner/server`. */
  name: string
  title?: string
  description: string
  version: string
  /** https:// only. */
  repositoryUrl?: string
  websiteUrl?: string
  /** active, deprecated, ... (from the registry's own metadata). */
  status?: string
  packages: RegistryPackage[]
  remotes: RegistryRemote[]
}

export interface RegistryPage {
  servers: RegistryServer[]
  nextCursor?: string
}

export type RegistrySearchResult = { ok: true; page: RegistryPage } | { ok: false; error: string }
export type RegistryGetResult = { ok: true; server: RegistryServer } | { ok: false; error: string }

const MAX_SERVERS = 100
const MAX_ITEMS = 12
const MAX_ARGS = 16

// C0/C1 controls (ESC included, so no terminal escapes), and the bidi overrides and
// isolates that can make text read differently from what it is.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/** Registry text made safe to show: a string, no control or bidi characters, collapsed spaces, capped. */
export function cleanRegistryText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const s = value.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}

/** An https:// URL with a host, or undefined. */
export function safeHttpsUrl(value: unknown): string | undefined {
  const s = cleanRegistryText(value, 500)
  if (!s || /\s/.test(s)) return undefined
  try {
    const u = new URL(s)
    return u.protocol === 'https:' && u.hostname ? u.toString() : undefined
  } catch {
    return undefined
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function list(v: unknown, max: number): Record<string, unknown>[] {
  if (!Array.isArray(v)) return []
  return v.slice(0, max).map(obj).filter((x): x is Record<string, unknown> => x !== null)
}

function readInputs(v: unknown, kind: 'env' | 'header'): RegistryInput[] {
  const out: RegistryInput[] = []
  for (const raw of list(v, MAX_ITEMS)) {
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!(kind === 'env' ? ENV_NAME : HEADER_NAME).test(name)) continue
    if (out.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue
    const format = cleanRegistryText(raw.value ?? raw.placeholder, 120)
    const fallback = cleanRegistryText(raw.default, 120)
    out.push({
      kind,
      name,
      description: cleanRegistryText(raw.description, 300),
      required: raw.isRequired === true,
      secret: raw.isSecret === true,
      ...(format ? { format } : {}),
      ...(fallback ? { default: fallback } : {})
    })
  }
  return out
}

function readArguments(v: unknown): RegistryArgument[] {
  const out: RegistryArgument[] = []
  for (const raw of list(v, MAX_ARGS)) {
    const type = raw.type === 'named' ? 'named' : raw.type === 'positional' ? 'positional' : null
    if (!type) continue
    const name = cleanRegistryText(raw.name, 80)
    const value = cleanRegistryText(raw.value ?? raw.default, 200)
    const valueHint = cleanRegistryText(raw.valueHint, 80)
    if (type === 'named' && !name) continue
    out.push({
      type,
      ...(name ? { name } : {}),
      ...(value ? { value } : {}),
      ...(valueHint ? { valueHint } : {}),
      required: raw.isRequired === true
    })
  }
  return out
}

function readServer(entry: unknown): RegistryServer | null {
  const wrap = obj(entry)
  const s = obj(wrap?.server) ?? null
  if (!s) return null
  const name = cleanRegistryText(s.name, 200)
  if (!name) return null
  const meta = obj(obj(wrap?._meta)?.['io.modelcontextprotocol.registry/official'])
  const title = cleanRegistryText(s.title, 120)
  const repositoryUrl = safeHttpsUrl(obj(s.repository)?.url)
  const websiteUrl = safeHttpsUrl(s.websiteUrl)
  const status = cleanRegistryText(meta?.status, 30)
  const packages: RegistryPackage[] = []
  for (const p of list(s.packages, MAX_ITEMS)) {
    const registryType = cleanRegistryText(p.registryType, 30).toLowerCase()
    const identifier = cleanRegistryText(p.identifier, 300)
    if (!registryType || !identifier) continue
    const version = cleanRegistryText(p.version, 80)
    packages.push({
      registryType,
      identifier,
      ...(version ? { version } : {}),
      transport: cleanRegistryText(obj(p.transport)?.type, 30) || 'stdio',
      env: readInputs(p.environmentVariables, 'env'),
      packageArguments: readArguments(p.packageArguments),
      runtimeArguments: readArguments(p.runtimeArguments)
    })
  }
  const remotes: RegistryRemote[] = []
  for (const r of list(s.remotes, MAX_ITEMS)) {
    const type = cleanRegistryText(r.type, 30)
    const url = cleanRegistryText(r.url, 500)
    if (!type || !url) continue
    remotes.push({ type, url, headers: readInputs(r.headers, 'header') })
  }
  return {
    name,
    ...(title ? { title } : {}),
    description: cleanRegistryText(s.description, 400),
    version: cleanRegistryText(s.version, 80),
    ...(repositoryUrl ? { repositoryUrl } : {}),
    ...(websiteUrl ? { websiteUrl } : {}),
    ...(status ? { status } : {}),
    packages,
    remotes
  }
}

/** One page of a `GET /v0.1/servers` answer, reduced to safe display data. Throws on a wrong shape. */
export function normalizeRegistryPage(json: unknown): RegistryPage {
  const root = obj(json)
  if (!root || !Array.isArray(root.servers)) throw new Error('The registry sent an answer Houston could not read.')
  const servers = root.servers
    .slice(0, MAX_SERVERS)
    .map(readServer)
    .filter((s): s is RegistryServer => s !== null)
  const cursor = cleanRegistryText(obj(root.metadata)?.nextCursor, 300)
  return { servers, ...(cursor ? { nextCursor: cursor } : {}) }
}

/** One `GET /v0.1/servers/{name}/versions/latest` answer. Throws on a wrong shape. */
export function normalizeRegistryServer(json: unknown): RegistryServer {
  const s = readServer(json)
  if (!s) throw new Error('The registry sent an answer Houston could not read.')
  return s
}

// --- Converting an entry into a server config -----------------------------------

/** A way to install an entry, or why Houston can't use it. */
export type RegistryOption =
  | { label: string; kind: 'stdio' | 'remote'; draft: McpDraft }
  | { label: string; kind: 'stdio' | 'remote'; unsupported: string }

/** An exact version: no ranges, tags like `latest`, or wildcards. */
export function isExactVersion(v: string | undefined): v is string {
  if (!v || v.length > 64) return false
  if (/^(latest|next|stable|main|master|head|\*)$/i.test(v)) return false
  return /^v?\d[0-9A-Za-z.+_-]*$/.test(v)
}

const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i
const PYPI_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
// registry/namespace/name[:tag][@sha256:digest]; lowercase path, as Docker requires.
const OCI_REF = /^[a-z0-9][a-z0-9._-]*(?::\d+)?(\/[a-z0-9][a-z0-9._-]*)*(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(@sha256:[a-f0-9]{64})?$/

/** The pinned image reference for an oci package, or null when it can't be pinned. */
export function pinnedImage(identifier: string, version: string | undefined): string | null {
  if (!OCI_REF.test(identifier)) return null
  if (identifier.includes('@sha256:')) return identifier
  const last = identifier.slice(identifier.lastIndexOf('/') + 1)
  const tag = last.includes(':') ? last.slice(last.indexOf(':') + 1) : null
  if (tag) return isExactVersion(tag) ? identifier : null
  return isExactVersion(version) ? `${identifier}:${version}` : null
}

/** A suggested server id from a registry name: its last path part. */
export function registryServerId(name: string): string {
  const tail = name.slice(name.lastIndexOf('/') + 1)
  return sanitizeServerId(tail).slice(0, 48) || 'server'
}

/** `{name}` for an argument the user must supply, so the review form asks for it. */
function placeholder(a: RegistryArgument): string {
  const word = (a.valueHint || a.name || 'value').replace(/^-+/, '').replace(/[{}\s]/g, '_')
  return `{${word || 'value'}}`
}

function argumentWords(args: RegistryArgument[]): string[] {
  const out: string[] = []
  for (const a of args) {
    if (a.type === 'named') {
      if (a.value) out.push(a.name as string, a.value)
      else if (a.required) out.push(a.name as string, placeholder(a))
    } else if (a.value) out.push(a.value)
    else if (a.required) out.push(placeholder(a))
  }
  return out
}

function describeArgs(args: RegistryArgument[]): string {
  return args.map((a) => [a.name, a.value].filter(Boolean).join(' ') || a.valueHint || '').filter(Boolean).join(' ')
}

const LISTED_NOTE = 'Listed in the MCP Registry. Its description and settings come from the publisher; check them before switching it on.'

function packageLabel(p: RegistryPackage): string {
  const kind = p.registryType === 'npm' ? 'npm' : p.registryType === 'pypi' ? 'PyPI' : p.registryType === 'oci' ? 'Docker' : p.registryType
  return `${kind} ${p.identifier}${p.version ? ` ${p.version}` : ''}`
}

function packageOption(server: RegistryServer, p: RegistryPackage): RegistryOption {
  const label = packageLabel(p)
  if (p.transport !== 'stdio') {
    return { label, kind: 'stdio', unsupported: 'Runs as a local web server. Start it yourself, then add its URL by hand.' }
  }
  let command: string
  let head: string[]
  let needs: string
  if (p.registryType === 'npm') {
    if (!NPM_NAME.test(p.identifier)) return { label, kind: 'stdio', unsupported: 'The package name is not a valid npm name.' }
    if (!isExactVersion(p.version)) return { label, kind: 'stdio', unsupported: 'No exact version to pin.' }
    command = 'npx'
    head = ['-y', `${p.identifier}@${p.version}`]
    needs = 'Node.js (npx)'
  } else if (p.registryType === 'pypi') {
    if (!PYPI_NAME.test(p.identifier)) return { label, kind: 'stdio', unsupported: 'The package name is not a valid PyPI name.' }
    if (!isExactVersion(p.version)) return { label, kind: 'stdio', unsupported: 'No exact version to pin.' }
    command = 'uvx'
    head = [`${p.identifier}@${p.version}`]
    needs = 'uv (uvx)'
  } else if (p.registryType === 'oci') {
    const image = pinnedImage(p.identifier, p.version)
    if (!image) return { label, kind: 'stdio', unsupported: 'No exact image tag or digest to pin.' }
    command = 'docker'
    // Docker passes a variable into the container only when named with -e.
    head = ['run', '-i', '--rm', ...p.env.flatMap((e) => ['-e', e.name]), image]
    needs = 'Docker'
  } else {
    return { label, kind: 'stdio', unsupported: `Houston can't install ${p.registryType} packages.` }
  }
  const args = [...head, ...argumentWords(p.packageArguments)]
  const left = describeArgs(p.runtimeArguments)
  const leftOut = left ? ` Left out the publisher's ${command} options (${left}); add any you need.` : ''
  const draft: McpDraft = {
    key: `${server.name}#${label}`,
    name: server.title || server.name,
    publisher: server.name,
    note: `${LISTED_NOTE}${leftOut}`,
    needs,
    server: {
      id: registryServerId(server.name),
      transport: 'stdio',
      command,
      args,
      ...(p.env.length ? { env: Object.fromEntries(p.env.map((e) => [e.name, ''])) } : {}),
      enabled: false
    },
    inputs: p.env
  }
  return { label, kind: 'stdio', draft }
}

function remoteOption(server: RegistryServer, r: RegistryRemote): RegistryOption {
  const transport = r.type === 'streamable-http' ? 'http' : r.type === 'sse' ? 'sse' : null
  const label = `Remote ${r.type === 'sse' ? 'SSE' : 'HTTP'} ${r.url}`
  if (!transport) return { label, kind: 'remote', unsupported: `Unknown transport ${r.type}.` }
  if (!/^https:\/\/[^\s/]+/i.test(r.url)) return { label, kind: 'remote', unsupported: 'Only https:// addresses are accepted.' }
  const config: McpServerConfig = {
    id: registryServerId(server.name),
    transport,
    command: '',
    args: [],
    url: r.url,
    ...(r.headers.length ? { headers: Object.fromEntries(r.headers.map((h) => [h.name, ''])) } : {}),
    enabled: false
  }
  return {
    label,
    kind: 'remote',
    draft: { key: `${server.name}#${label}`, name: server.title || server.name, publisher: server.name, note: LISTED_NOTE, server: config, inputs: r.headers }
  }
}

/** Every way to install an entry, packages first, each converted or with the reason it can't be. */
export function registryInstallOptions(server: RegistryServer): RegistryOption[] {
  return [...server.packages.map((p) => packageOption(server, p)), ...server.remotes.map((r) => remoteOption(server, r))]
}

/** One line on how an entry is delivered: package types and versions, then remotes. */
export function registryDelivery(server: RegistryServer): string {
  const parts = [
    ...server.packages.map((p) => `${packageLabel(p)} (${p.transport})`),
    ...server.remotes.map((r) => `remote ${r.type}`)
  ]
  return parts.join(' · ') || 'no install details'
}
