/**
 * Helpers shared by the behavior probes: writing a workspace, seeding a conversation,
 * and the small text readers their graders use.
 *
 * Pure and mock-free, like the probes themselves: the registry is imported by plain
 * unit tests as well as by the eval suite, so nothing here may reach the loop.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { ChatMessage, ToolCall } from '@shared/agent'
import type { AgentCall, ProbeGrade } from '../types'

/** Write `files` (relative path to contents) into `ws`, creating folders as needed. */
export function writeFiles(ws: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(ws, ...rel.split('/'))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
}

/** Every file under `ws`, as forward-slash paths relative to it, sorted. */
export function listFiles(ws: string): string[] {
  return readdirSync(ws, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(ws, join(e.parentPath, e.name)).split('\\').join('/'))
    .sort()
}

/** A file's text, or undefined when it doesn't exist. */
export function readText(ws: string, rel: string): string | undefined {
  try {
    return readFileSync(join(ws, ...rel.split('/')), 'utf8')
  } catch {
    return undefined
  }
}

// ---- seeding ----
//
// A seeded conversation is written as the loop would have saved it. Every seeded tool
// result must be the loop's real output for that call: the scripted suite replays
// the calls and compares, so write `result` text from what that test reports.

export const seed = {
  user: (content: string): ChatMessage => ({ role: 'user', content }),
  /** One assistant turn calling tools, with no text. */
  calls: (...calls: ToolCall[]): ChatMessage => ({ role: 'assistant', content: '', toolCalls: calls }),
  call: (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, name, arguments: args }),
  result: (call: ToolCall, content: string): ChatMessage => ({
    role: 'tool',
    content,
    toolCallId: call.id,
    toolName: call.name
  })
}

// ---- grading ----

export const pass = (detail: string): ProbeGrade => ({ passed: true, detail })
export const fail = (detail: string): ProbeGrade => ({ passed: false, detail })

/** The bodies of the fenced code blocks in a message. */
export function codeBlocks(text: string): string[] {
  return [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1])
}

/**
 * The http(s) URLs in a text, without the punctuation that ends a sentence or a
 * markdown link around them, and without a trailing slash, so two spellings of one
 * page compare equal.
 */
export function urlsIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"'`()[\]{}]+/g)].map((m) => normalizeUrl(m[0]))
}

export function normalizeUrl(url: string): string {
  return url.replace(/[.,;:!?*_]+$/, '').replace(/\/+$/, '')
}

/** A shell command with its whitespace collapsed, so `node  check.mjs` is the same command. */
export function shellCommand(call: AgentCall): string | undefined {
  if (call.name !== 'run_shell' || typeof call.args.command !== 'string') return undefined
  return call.args.command.trim().replace(/\s+/g, ' ')
}

/** A call that writes files or runs something: what Plan mode forbids. */
export function changesThings(call: AgentCall): boolean {
  return call.kind === 'write' || call.kind === 'shell' || call.kind === 'mcp'
}

/** One call, for a grader's detail line: its name and the argument that says what it did. */
export function describeCall(call: AgentCall): string {
  const what = call.args.command ?? call.args.path ?? call.args.url ?? call.args.question
  return typeof what === 'string' ? `${call.name} ${what.replace(/\s+/g, ' ').slice(0, 80)}` : call.name
}

/** The first line of a tool result, for a grader's detail. */
export function firstLineOf(output: string | undefined): string {
  return (output ?? '').trim().split('\n')[0].slice(0, 160)
}
