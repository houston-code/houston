/**
 * Render a conversation to a single self-contained HTML document.
 *
 * The output is a complete `.html` string with inline CSS and no external assets,
 * scripts, or network references — it opens and renders identically offline. All
 * conversation-derived content is HTML-escaped, so a message or tool argument can
 * never inject markup or script into the document.
 *
 * The document also carries the conversation as JSON in an inert `<template>` so
 * Houston can import it again (see `html-import.ts`). That block holds only what
 * the page already shows, plus the tool-call ids that pair each tool result with
 * its call: no workspace path, attachments, or reasoning.
 */

import type { ChatMessage, Conversation, ToolCall } from './agent'
import { formatReceiptLines } from './evidence'

/** Id of the `<template>` that holds the importable conversation JSON. */
export const HTML_DATA_ELEMENT_ID = 'houston-conversation'
/** Exact opening tag of that block; the importer locates the block by this string. */
export const HTML_DATA_OPEN_TAG = `<template id="${HTML_DATA_ELEMENT_ID}">`
/** `format` marker inside the block, so a stray template with the same id isn't mistaken for one. */
export const HTML_DATA_FORMAT = 'houston-conversation'
/** Bump when the block's shape changes incompatibly; the importer refuses newer versions. */
export const HTML_DATA_VERSION = 1

/** The importable payload stored in the HTML data block. */
export interface HtmlConversationData {
  format: typeof HTML_DATA_FORMAT
  version: number
  title: string
  providerId?: string
  model?: string
  messages: ChatMessage[]
}

/** Escape the five characters that are significant in HTML text/attribute context. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** A human label for each chat role, used as the turn header. */
function roleLabel(role: ChatMessage['role']): string {
  switch (role) {
    case 'user':
      return 'User'
    case 'assistant':
      return 'Assistant'
    case 'tool':
      return 'Tool result'
    case 'system':
      return 'System'
    default:
      return role
  }
}

/** Render a single tool call (name + pretty-printed JSON arguments). */
function renderToolCall(call: ToolCall): string {
  let args: string
  try {
    args = JSON.stringify(call.arguments, null, 2)
  } catch {
    args = String(call.arguments)
  }
  return [
    '<div class="toolcall">',
    `<div class="toolcall__name">${escapeHtml(call.name)}</div>`,
    `<pre class="toolcall__args">${escapeHtml(args)}</pre>`,
    '</div>'
  ].join('')
}

/** Render one message turn: header, text body, any tool calls. */
function renderMessage(msg: ChatMessage): string {
  const parts: string[] = []
  parts.push(`<section class="turn turn--${escapeHtml(msg.role)}">`)
  parts.push(`<div class="turn__role">${escapeHtml(roleLabel(msg.role))}</div>`)
  if (msg.toolName) {
    parts.push(`<div class="turn__tool">${escapeHtml(msg.toolName)}</div>`)
  }
  if (msg.content) {
    parts.push(`<pre class="turn__body">${escapeHtml(msg.content)}</pre>`)
  }
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    parts.push('<div class="turn__toolcalls">')
    for (const call of msg.toolCalls) parts.push(renderToolCall(call))
    parts.push('</div>')
  }
  // What Houston recorded running that turn, shown as its own block under the message.
  // Not in the embedded data (see portableMessage): an import never carries a receipt.
  if (msg.receipt) {
    parts.push(`<pre class="turn__receipt">${escapeHtml(formatReceiptLines(msg.receipt).join('\n'))}</pre>`)
  }
  parts.push('</section>')
  return parts.join('')
}

/**
 * Reduce a message to the fields an import keeps (see `validateImportedConversation`).
 * Everything here is visible on the page except the tool-call ids.
 */
function portableMessage(msg: ChatMessage): ChatMessage {
  const out: ChatMessage = { role: msg.role, content: msg.content }
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    out.toolCalls = msg.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }))
  }
  if (msg.toolCallId) out.toolCallId = msg.toolCallId
  if (msg.toolName) out.toolName = msg.toolName
  return out
}

/** The conversation as importable JSON, HTML-escaped so it stays inert text inside the template. */
function renderDataBlock(conv: Conversation): string {
  const data: HtmlConversationData = {
    format: HTML_DATA_FORMAT,
    version: HTML_DATA_VERSION,
    title: conv.title,
    providerId: conv.providerId || undefined,
    model: conv.model || undefined,
    messages: conv.messages.map(portableMessage)
  }
  return `${HTML_DATA_OPEN_TAG}${escapeHtml(JSON.stringify(data))}</template>`
}

/** Inline stylesheet — kept minimal and self-contained (no @import, no url()). */
const STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2rem 1rem;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #f7f7f8;
    color: #1a1a1a;
  }
  main { max-width: 820px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 0.25rem; word-break: break-word; }
  .meta { color: #6b6b6b; font-size: 0.85rem; margin-bottom: 2rem; }
  .turn {
    border: 1px solid #e3e3e6;
    border-radius: 10px;
    padding: 1rem 1.25rem;
    margin-bottom: 1rem;
    background: #fff;
  }
  .turn--user { background: #eef4ff; }
  .turn--system { background: #fff8e6; }
  .turn--tool { background: #f3f3f5; }
  .turn__role { font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: #555; margin-bottom: 0.5rem; }
  .turn__tool { font-size: 0.8rem; color: #777; margin-bottom: 0.5rem; }
  .turn__body { margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; }
  .turn__toolcalls { margin-top: 0.75rem; }
  .turn__receipt {
    margin: 0.75rem 0 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid #d9c9a8;
    border-radius: 6px;
    font: 0.8rem/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    white-space: pre-wrap;
    word-break: break-word;
    color: #555;
  }
  .toolcall { border-left: 3px solid #c8c8cc; padding-left: 0.75rem; margin-top: 0.75rem; }
  .toolcall__name { font-weight: 600; font-size: 0.85rem; margin-bottom: 0.25rem; }
  .toolcall__args, .turn__body {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .toolcall__args {
    margin: 0;
    padding: 0.5rem 0.75rem;
    background: #f3f3f5;
    border-radius: 6px;
    overflow-x: auto;
    font-size: 0.85rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1c; color: #e8e8ea; }
    .turn { background: #232326; border-color: #38383c; }
    .turn--user { background: #1e2a40; }
    .turn--system { background: #322c18; }
    .turn--tool { background: #2a2a2d; }
    .turn__role { color: #aaa; }
    .toolcall__args, .turn--tool { background: #18181a; }
    .meta { color: #999; }
    .turn__receipt { border-color: #5a5040; color: #bbb; }
  }
`.trim()

/**
 * Convert a conversation into a self-contained HTML document string.
 *
 * Pure: no I/O, no globals. The returned string references no external resources,
 * so it renders fully offline. Every piece of conversation data is escaped.
 */
export function conversationToHtml(conv: Conversation): string {
  const title = conv.title || 'Conversation'
  const created = new Date(conv.createdAt).toISOString()
  const metaBits = [
    conv.model ? `Model: ${conv.model}` : '',
    conv.providerId ? `Provider: ${conv.providerId}` : '',
    `Exported: ${new Date().toISOString()}`,
    `Created: ${created}`
  ].filter(Boolean)

  const body = conv.messages.map(renderMessage).join('\n')

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    // Defense-in-depth: the document is fully escaped and self-contained, but a CSP
    // makes that structural — no scripts, no network, only the inline stylesheet —
    // so a future templating regression can't turn the export into an active page.
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLES}</style>`,
    renderDataBlock(conv),
    '</head>',
    '<body>',
    '<main>',
    `<h1>${escapeHtml(title)}</h1>`,
    `<div class="meta">${escapeHtml(metaBits.join(' · '))}</div>`,
    body,
    '</main>',
    '</body>',
    '</html>',
    ''
  ].join('\n')
}
