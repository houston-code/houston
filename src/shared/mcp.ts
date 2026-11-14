/**
 * Pure helpers for the Model Context Protocol (MCP) integration. MCP tools are
 * namespaced so they can't collide with Houston's built-in tools or each other:
 * `mcp__<serverId>__<toolName>`. The server id is constrained to [\w-]+, so the
 * boundary is unambiguous.
 */

import type { ElicitationField, ElicitationResult } from './agent'
import { MAX_ATTACHMENTS, exceedsImageSizeLimit, isSupportedImageType, type ImageAttachment } from './images'

const MCP_PREFIX = 'mcp__'

/** Namespaced tool name for an MCP server's tool. */
export function mcpToolName(serverId: string, toolName: string): string {
  return `${MCP_PREFIX}${serverId}__${toolName}`
}

/**
 * Parse a namespaced MCP tool name back into its server id and original tool name.
 * The server id capture is non-greedy so the FIRST `__` after the prefix is the
 * boundary — server ids never contain `__` (see sanitizeServerId), so the rest,
 * which may itself contain `__`, is the tool name.
 */
export function parseMcpToolName(name: string): { serverId: string; toolName: string } | null {
  const m = /^mcp__([\w-]+?)__(.+)$/.exec(name)
  return m ? { serverId: m[1], toolName: m[2] } : null
}

/** Whether a tool name belongs to an MCP server. */
export function isMcpToolName(name: string): boolean {
  return parseMcpToolName(name) !== null
}

/**
 * Sanitize a user-supplied server id to the namespacing-safe charset. Collapses
 * `__` to `_` so the id can never contain the `__` boundary delimiter.
 */
export function sanitizeServerId(id: string): string {
  return id
    .trim()
    .replace(/[^\w-]+/g, '-')
    .replace(/_{2,}/g, '_')
    .replace(/^-+|-+$/g, '')
}

/**
 * Parse a textarea of "Name: value" lines into a map, plus the non-blank lines that
 * could not be read (no separator, or nothing before it), so an editor can keep and
 * flag them instead of silently dropping them. Keys and values are trimmed.
 *
 * Headers split on the first `:`. Environment variables (`env`) also take the
 * `NAME=value` form a shell or `.env` file uses, splitting on whichever of `=` and
 * `:` comes first: a variable name never contains either, while a value often does
 * (`DATABASE_URL=postgres://u:p@h`).
 */
export function parseKeyValueLines(
  text: string,
  opts: { env?: boolean } = {}
): { values: Record<string, string>; invalid: string[] } {
  const values: Record<string, string> = {}
  const invalid: string[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const colon = line.indexOf(':')
    const equals = opts.env ? line.indexOf('=') : -1
    const idx = colon === -1 ? equals : equals === -1 ? colon : Math.min(colon, equals)
    const key = idx > 0 ? line.slice(0, idx).trim() : ''
    if (!key) {
      invalid.push(line.trim())
      continue
    }
    values[key] = line.slice(idx + 1).trim()
  }
  return { values, invalid }
}

/**
 * Parse a textarea of "Name: value" lines into an HTTP headers map. Blank lines
 * and lines without a colon are skipped; keys/values are trimmed.
 */
export function parseHeaderLines(text: string): Record<string, string> {
  return parseKeyValueLines(text).values
}

// ---- Elicitation (server asks the user for input mid-call) ----

/**
 * The allowed values of a single-select enum property, in either shape the spec
 * defines: a plain `enum` array, or (since 2025-11-25) a titled `oneOf`/`anyOf` list
 * of `{ const, title }` options. Only string values count; anything else is []
 * (the field is then a plain string input).
 */
function elicitationEnumValues(p: Record<string, unknown>): string[] {
  if (Array.isArray(p.enum)) return p.enum.filter((v): v is string => typeof v === 'string')
  const options = Array.isArray(p.oneOf) ? p.oneOf : Array.isArray(p.anyOf) ? p.anyOf : null
  if (!options) return []
  const values: string[] = []
  for (const o of options) {
    const c = o && typeof o === 'object' ? (o as { const?: unknown }).const : undefined
    if (typeof c === 'string') values.push(c)
  }
  return values
}

/**
 * Parse an elicitation `requestedSchema` (the MCP spec's flat object-of-primitives
 * subset of JSON Schema) into renderable field descriptors. Defensive at the trust
 * boundary: a missing/foreign schema yields [] (a message-only confirmation), and
 * an exotic property type degrades to a plain string input rather than failing.
 */
export function parseElicitationFields(schema: unknown): ElicitationField[] {
  if (!schema || typeof schema !== 'object') return []
  const props = (schema as { properties?: unknown }).properties
  if (!props || typeof props !== 'object') return []
  const required = (schema as { required?: unknown }).required
  const requiredSet = new Set(Array.isArray(required) ? required.filter((r) => typeof r === 'string') : [])
  const fields: ElicitationField[] = []
  for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
    const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const enumValues = elicitationEnumValues(p)
    const kind: ElicitationField['kind'] = enumValues.length
      ? 'enum'
      : p.type === 'number' || p.type === 'integer' || p.type === 'boolean'
        ? p.type
        : 'string'
    fields.push({
      name,
      kind,
      ...(typeof p.title === 'string' ? { title: p.title } : {}),
      ...(typeof p.description === 'string' ? { description: p.description } : {}),
      ...(requiredSet.has(name) ? { required: true } : {}),
      ...(enumValues.length ? { options: enumValues } : {}),
      ...(typeof p.format === 'string' ? { format: p.format } : {})
    })
  }
  return fields
}

/**
 * Turn raw per-field user input (strings, as a form/terminal collects them) into
 * a typed elicitation `content` map, or a per-field error message. Booleans accept
 * y/yes/true/1 and n/no/false/0; enums must match an allowed value; a blank
 * optional field is omitted, a blank required field is an error.
 */
export function buildElicitationContent(
  fields: ElicitationField[],
  raw: Record<string, string>
): { content: NonNullable<ElicitationResult['content']> } | { error: string } {
  const content: NonNullable<ElicitationResult['content']> = {}
  for (const f of fields) {
    const value = (raw[f.name] ?? '').trim()
    if (!value) {
      if (f.required) return { error: `"${f.name}" is required.` }
      continue
    }
    if (f.kind === 'number' || f.kind === 'integer') {
      const n = Number(value)
      if (!Number.isFinite(n)) return { error: `"${f.name}" must be a number.` }
      if (f.kind === 'integer' && !Number.isInteger(n)) return { error: `"${f.name}" must be an integer.` }
      content[f.name] = n
    } else if (f.kind === 'boolean') {
      if (/^(y|yes|true|1)$/i.test(value)) content[f.name] = true
      else if (/^(n|no|false|0)$/i.test(value)) content[f.name] = false
      else return { error: `"${f.name}" must be yes or no.` }
    } else if (f.kind === 'enum') {
      const match = f.options?.find((o) => o === value) ?? f.options?.find((o) => o.toLowerCase() === value.toLowerCase())
      if (!match) return { error: `"${f.name}" must be one of: ${f.options?.join(', ')}.` }
      content[f.name] = match
    } else {
      content[f.name] = value
    }
  }
  return { content }
}

/** Most images one MCP result can attach; the rest are noted in the text. */
export const MAX_MCP_IMAGES = MAX_ATTACHMENTS

/** Most characters of one embedded resource's text inlined into a result. */
export const MAX_EMBEDDED_RESOURCE_CHARS = 20_000

/** Longest server-supplied label (uri, name, mime type) quoted in a placeholder. */
const MAX_LABEL_CHARS = 500

/**
 * What to do with image blocks while flattening (see {@link flattenMcpContent}).
 * With `attachImage`, each valid image is handed to it (the tool-image pipeline that
 * built-in tools use) and the text notes it; without, the text says the image was not
 * shown, and why (`noImageReason`).
 */
export interface McpImageOptions {
  attachImage?: (img: ImageAttachment) => void
  noImageReason?: string
}

/** A server-supplied label, made safe to quote on one line. */
function label(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  if (!flat) return fallback
  return flat.length > MAX_LABEL_CHARS ? `${flat.slice(0, MAX_LABEL_CHARS)}…` : flat
}

/** A byte count for a placeholder: "812 B", "14 KB", "2.1 MB". */
function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** The image type a payload's first bytes show, or null when they match none Houston sends. */
function sniffImageType(bytes: Uint8Array): string | null {
  const at = (i: number, ...sig: number[]): boolean => sig.every((b, j) => bytes[i + j] === b)
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  return null
}

/** Decode the first bytes of a base64 payload (enough to sniff its type). */
function headBytes(base64: string): Uint8Array {
  const chunk = base64.slice(0, 24)
  const bin = typeof atob === 'function' ? atob(chunk.slice(0, chunk.length - (chunk.length % 4))) : ''
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * An image block from a server, checked before it can reach a provider (which rejects
 * the whole request over one bad image): base64 that decodes, under the per-image size
 * cap, and bytes that really are a PNG, JPEG, GIF or WebP. The type sent is the one
 * the bytes show, since a mislabelled image is rejected too. Returns the attachment, or
 * why it can't be one.
 */
function checkImage(data: unknown, mimeType: unknown): { image: ImageAttachment; bytes: number } | { problem: string } {
  const claimed = label(mimeType, 'unknown type')
  if (typeof data !== 'string' || !data) return { problem: `image (${claimed}) with no data` }
  const b64 = data.replace(/\s+/g, '')
  if (b64.length % 4 !== 0 || !BASE64.test(b64)) return { problem: `image (${claimed}) that is not valid base64` }
  const bytes = Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)
  if (exceedsImageSizeLimit(b64)) {
    return { problem: `image (${claimed}, ${byteSize(bytes)}): too large to show; the limit is 5 MB` }
  }
  const sniffed = sniffImageType(headBytes(b64))
  if (!sniffed || !isSupportedImageType(sniffed)) {
    return { problem: `image (${claimed}, ${byteSize(bytes)}) in a format that cannot be shown` }
  }
  return { image: { mediaType: sniffed, data: b64 }, bytes }
}

/** The text for one image block: attached, or noted with why it was not. */
function imagePart(
  data: unknown,
  mimeType: unknown,
  opts: McpImageOptions,
  attached: { count: number }
): string {
  const checked = checkImage(data, mimeType)
  if ('problem' in checked) return `[${checked.problem}]`
  const { image, bytes } = checked
  const size = byteSize(bytes)
  if (!opts.attachImage) {
    return `[image (${image.mediaType}, ${size}): not shown, ${opts.noImageReason ?? 'images cannot be shown here'}]`
  }
  if (attached.count >= MAX_MCP_IMAGES) {
    return `[image (${image.mediaType}, ${size}): not shown, a result can attach at most ${MAX_MCP_IMAGES} images]`
  }
  attached.count++
  opts.attachImage(image)
  return `[image (${image.mediaType}, ${size}): attached below]`
}

/** An embedded `resource` block: its text inlined (capped), or a binary noted (or attached, for an image). */
function embeddedResourcePart(resource: unknown, opts: McpImageOptions, attached: { count: number }): string {
  if (!resource || typeof resource !== 'object') return '[resource content]'
  const r = resource as { uri?: unknown; mimeType?: unknown; text?: unknown; blob?: unknown }
  const uri = label(r.uri, 'no uri')
  const mime = label(r.mimeType)
  const head = `[resource ${uri}${mime ? ` (${mime})` : ''}]`
  if (typeof r.text === 'string') {
    if (r.text.length <= MAX_EMBEDDED_RESOURCE_CHARS) return `${head}\n${r.text}`
    return `${head}\n${r.text.slice(0, MAX_EMBEDDED_RESOURCE_CHARS)}\n[resource text cut at ${MAX_EMBEDDED_RESOURCE_CHARS} of ${r.text.length} characters]`
  }
  if (typeof r.blob === 'string') {
    if (/^image\//i.test(mime)) return `${head}\n${imagePart(r.blob, r.mimeType, opts, attached)}`
    return `${head.slice(0, -1)}, binary, ${r.blob.length} base64 chars, not shown]`
  }
  return head
}

/** A `resource_link` block: what it points at, for the agent to fetch if it needs it. */
function resourceLinkPart(block: Record<string, unknown>): string {
  const uri = label(block.uri, 'no uri')
  const name = label(block.title) || label(block.name)
  const mime = label(block.mimeType)
  const description = label(block.description)
  const details = [mime, description].filter(Boolean).join(', ')
  return `[resource link${name ? `: ${name}` : ''} <${uri}>${details ? ` (${details})` : ''}]`
}

/**
 * Flatten an MCP tool result's `content` array into plain text for the agent. Text
 * blocks are concatenated. Image blocks are attached through `opts.attachImage` (at
 * most {@link MAX_MCP_IMAGES}, each checked, see checkImage) and noted in the text, or
 * noted as not shown when there is no `attachImage`. An embedded `resource` has its text
 * inlined (capped at {@link MAX_EMBEDDED_RESOURCE_CHARS}); a `resource_link` is given
 * as its name, URI and type. Other blocks (audio, unknown types) are noted by type.
 * Everything here is server-written: the caller fences the text as untrusted.
 */
export function flattenMcpContent(content: unknown, opts: McpImageOptions = {}): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : ''
  }
  const attached = { count: 0 }
  const parts: string[] = []
  for (const raw of content as unknown[]) {
    if (!raw || typeof raw !== 'object') continue
    const block = raw as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push(imagePart(block.data, block.mimeType, opts, attached))
    else if (block.type === 'resource') parts.push(embeddedResourcePart(block.resource, opts, attached))
    else if (block.type === 'resource_link') parts.push(resourceLinkPart(block))
    else if (typeof block.type === 'string') parts.push(`[${label(block.type, 'unknown')} content]`)
  }
  return parts.join('\n').trim()
}

/**
 * Flatten an MCP `prompts/get` result into plain text for the agent: the prompt
 * description (when present) followed by each message as `role: text`. Non-text
 * message content is noted by type, mirroring {@link flattenMcpContent}.
 */
export function flattenMcpPromptMessages(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const { description, messages } = result as { description?: unknown; messages?: unknown }
  const parts: string[] = []
  if (typeof description === 'string' && description.trim()) parts.push(description.trim())
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue
      const { role, content } = m as { role?: unknown; content?: unknown }
      const text = flattenMcpContent(Array.isArray(content) ? content : [content])
      if (text) parts.push(`${typeof role === 'string' ? role : 'user'}: ${text}`)
    }
  }
  return parts.join('\n\n').trim()
}

/**
 * Flatten an MCP `resources/read` result's `contents` array into plain text.
 * Text contents are concatenated; a binary (base64 `blob`) content is noted with
 * its uri/mime rather than dumped, so a large binary can't flood the context.
 */
export function flattenMcpResourceContents(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const contents = (result as { contents?: unknown }).contents
  if (!Array.isArray(contents)) return ''
  const parts: string[] = []
  for (const c of contents) {
    if (!c || typeof c !== 'object') continue
    const item = c as { text?: unknown; blob?: unknown; mimeType?: unknown; uri?: unknown }
    if (typeof item.text === 'string') {
      parts.push(item.text)
    } else if (typeof item.blob === 'string') {
      const uri = typeof item.uri === 'string' ? item.uri : ''
      const mime = typeof item.mimeType === 'string' ? item.mimeType : 'application/octet-stream'
      parts.push(`[binary resource ${uri} (${mime}), ${item.blob.length} base64 chars]`.replace(/\s+/g, ' '))
    }
  }
  return parts.join('\n').trim()
}
