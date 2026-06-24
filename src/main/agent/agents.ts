import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from '@shared/frontmatter'

/**
 * Custom subagents defined in `.houston/agents/*.md`. Each file is a specialized
 * read-only research agent: optional front-matter `description`, and the body is
 * the agent's system prompt. The main agent can target one by name via
 * dispatch_agent({ agent: "<name>", ... }). Like the built-in subagent, custom
 * agents are read-only (no edits/shell/network), so they need no approvals.
 */

export const AGENTS_DIR = '.houston/agents'
const MAX_AGENTS = 50
const MAX_PROMPT_CHARS = 16_000

export interface CustomAgent {
  name: string
  description: string
  /** The agent's system prompt (front-matter stripped). */
  systemPrompt: string
  /**
   * Optional allow-list from front-matter `tools:` (comma/space separated).
   * When present, narrows the read-only tools this agent may use; it can only
   * restrict the default set, never grant write/shell/network access.
   */
  tools?: string[]
}

function firstLine(s: string): string {
  return (s.split('\n', 1)[0] ?? '').replace(/^#+\s*/, '').trim().slice(0, 100)
}

/** Parse a front-matter `tools:` field (comma/space separated) into a name list. */
function parseTools(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  const tools = value
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean)
  return tools.length ? tools : undefined
}

export async function loadAgents(workspace: string): Promise<CustomAgent[]> {
  let entries
  try {
    entries = await fs.readdir(join(workspace, AGENTS_DIR), { withFileTypes: true })
  } catch {
    return []
  }

  const agents: CustomAgent[] = []
  for (const e of entries) {
    if (agents.length >= MAX_AGENTS) break
    if (!e.isFile() || !e.name.endsWith('.md')) continue
    const name = e.name.slice(0, -'.md'.length)
    if (!/^[\w-]+$/.test(name)) continue
    let raw: string
    try {
      raw = (await fs.readFile(join(workspace, AGENTS_DIR, e.name), 'utf8')).trim()
    } catch {
      continue
    }
    if (!raw) continue
    const { data, body } = parseFrontmatter(raw)
    const systemPrompt = (body || raw).slice(0, MAX_PROMPT_CHARS)
    if (!systemPrompt) continue
    const tools = parseTools(data.tools)
    agents.push({
      name,
      description: data.description || firstLine(systemPrompt) || name,
      systemPrompt,
      ...(tools ? { tools } : {})
    })
  }
  agents.sort((a, b) => a.name.localeCompare(b.name))
  return agents
}
