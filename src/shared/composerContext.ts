/**
 * Non-image "context" attachments the composer's `+` menu can add to a message:
 * an attached file's contents, a folder listing, the working-tree diff, or a link.
 *
 * Unlike {@link ImageAttachment}s (which travel as provider image blocks), context
 * attachments are rendered into the outgoing message text as clearly-delimited
 * blocks — so no agent/IPC message-schema change is needed. The formatting and
 * size-capping helpers are pure, so they run on both sides of the IPC boundary and
 * are unit-tested without Electron.
 */

import type { ImageAttachment } from './images'

/** The kinds of non-image context the `+` menu can attach. */
export type ContextKind = 'file' | 'folder' | 'diff' | 'link'

/** A single non-image attachment shown as a chip above the composer. */
export interface ContextAttachment {
  /** Stable id for list keys / removal. */
  id: string
  kind: ContextKind
  /** Short chip label (a basename, "Uncommitted changes", a URL…). */
  label: string
  /** Optional secondary chip text (size, file count, +/− stat). */
  detail?: string
  /** The fully-formatted block injected into the outgoing message. */
  text: string
}

/** A file the main process read after the user picked it in the native dialog. */
export interface PickedFile {
  /** Absolute path the user chose. */
  path: string
  /** Basename, used for the chip label. */
  name: string
  /** Total file size in bytes (before any cap). */
  bytes: number
  /** UTF-8 contents, capped to {@link MAX_FILE_TEXT_BYTES}; null when binary/unreadable. */
  content: string | null
  /** True when {@link content} was capped to the byte limit. */
  truncated: boolean
  /** True when the file looked binary (a NUL byte in its head) — contents omitted. */
  binary: boolean
}

/** What the clipboard yielded when the user chose "Paste from clipboard". */
export interface ClipboardContent {
  text: string
  image: ImageAttachment | null
}

/** Per-file content cap when attaching a text file (bytes of UTF-8). */
export const MAX_FILE_TEXT_BYTES = 96_000
/** Cap on the working-tree diff text injected for "Add current changes". */
export const MAX_DIFF_TEXT_BYTES = 192_000
/** Max files read from a single "Attach files" pick. */
export const MAX_ATTACHMENT_FILES = 10
/** Max context chips on the composer at once (separate from the image cap). */
export const MAX_CONTEXT_ATTACHMENTS = 12

/** True if a byte buffer looks binary (a NUL within its leading bytes). */
export function looksBinary(bytes: Uint8Array, sniff = 8000): boolean {
  const n = Math.min(bytes.length, sniff)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}

/** Human-readable byte size, e.g. "812 B" / "12.3 KB" / "1.4 MB". */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Trim `text` to at most `maxBytes` of UTF-8 without splitting a multi-byte
 * codepoint. Returns the (possibly shortened) text and whether it was cut.
 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const enc = new TextEncoder()
  if (enc.encode(text).length <= maxBytes) return { text, truncated: false }
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (enc.encode(text.slice(0, mid)).length <= maxBytes) lo = mid
    else hi = mid - 1
  }
  return { text: text.slice(0, lo), truncated: true }
}

/** A fenced-code language hint for a path's extension (empty when unknown). */
export function fenceLang(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path)
  const ext = m ? m[1].toLowerCase() : ''
  const map: Record<string, string> = {
    ts: 'ts',
    tsx: 'tsx',
    js: 'js',
    jsx: 'jsx',
    mjs: 'js',
    cjs: 'js',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cs: 'csharp',
    php: 'php',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    sql: 'sql',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    md: 'markdown',
    html: 'html',
    css: 'css',
    scss: 'scss'
  }
  return map[ext] ?? ''
}

/**
 * Pick a fence delimiter that won't collide with backtick runs inside `content`,
 * so a file/diff containing a ``` fence still nests cleanly.
 */
function fenceFor(content: string): string {
  let longest = 0
  for (const run of content.matchAll(/`+/g)) longest = Math.max(longest, run[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** Format an attached file's contents as a labelled, fenced block. */
export function formatFileContext(
  name: string,
  content: string | null,
  opts: { truncated?: boolean; binary?: boolean } = {}
): string {
  if (opts.binary) return `File: ${name} (binary file — contents omitted)`
  if (content === null) return `File: ${name} (could not be read)`
  const header = opts.truncated ? `File: ${name} (truncated)` : `File: ${name}`
  const fence = fenceFor(content)
  const lang = fenceLang(name)
  return `${header}\n${fence}${lang}\n${content}\n${fence}`
}

/** Format a picked folder's path and a (capped) file listing. */
export function formatFolderContext(
  path: string,
  files: string[],
  opts: { truncated?: boolean } = {}
): string {
  const head = opts.truncated
    ? `Folder: ${path} (showing first ${files.length} files)`
    : `Folder: ${path} (${files.length} file${files.length === 1 ? '' : 's'})`
  if (files.length === 0) return head
  return `${head}\n${files.map((f) => `- ${f}`).join('\n')}`
}

/** Format the working-tree diff text as a labelled, fenced block. */
export function formatDiffContext(
  diff: string,
  opts: {
    branch?: string | null
    files?: number
    added?: number
    removed?: number
    truncated?: boolean
  } = {}
): string {
  const onBranch = opts.branch ? ` on branch ${opts.branch}` : ''
  const stat =
    opts.files != null ? ` (${opts.files} file${opts.files === 1 ? '' : 's'}, +${opts.added ?? 0} −${opts.removed ?? 0})` : ''
  const note = opts.truncated ? ' [truncated]' : ''
  const fence = fenceFor(diff)
  return `Uncommitted changes${onBranch}${stat}${note}:\n${fence}diff\n${diff}\n${fence}`
}

/** Format a link the user added so the agent knows to consider it. */
export function formatLinkContext(url: string): string {
  return `Link: ${url}`
}

/**
 * Combine the typed message with any context blocks. Context follows the user's
 * text, separated by a blank line; when the field is empty the blocks stand alone.
 */
export function buildMessageWithContext(userText: string, atts: ContextAttachment[]): string {
  const blocks = atts.map((a) => a.text.trim()).filter(Boolean)
  const head = userText.trim()
  if (blocks.length === 0) return head
  const body = blocks.join('\n\n')
  return head ? `${head}\n\n${body}` : body
}

/** Normalize a user-typed link: add an https:// scheme when none is present. */
export function normalizeLink(raw: string): string {
  const url = raw.trim()
  if (!url) return ''
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) ? url : `https://${url}`
}
