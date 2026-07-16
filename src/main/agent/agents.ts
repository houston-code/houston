import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from '@shared/frontmatter'

/**
 * Custom subagents defined in `.houston/agents/*.md`. Each file is a specialized
 * agent: optional front-matter `description`, and the body is the agent's system
 * prompt. The main agent can target one by name via dispatch_agent({ agent:
 * "<name>", ... }) for read-only work.
 *
 * By default a custom agent is read-only (no edits/shell/network), so it needs no
 * approvals. Front-matter `write: true` opts it into a WRITABLE agent that can edit
 * files and run shell commands (still sandboxed to the project, no network); it is
 * reachable via dispatch_writable_agent, whose call is approval-gated like any other
 * write. See src/main/agent/subagent.ts.
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
   * Optional allow-list from front-matter `tools:` (comma/space separated). When
   * present, narrows the tools this agent may use within its tier — it can only
   * restrict the tier's set, never widen it (a read-only agent can't gain write
   * tools this way; a writable agent's set already includes them).
   */
  tools?: string[]
  /**
   * Front-matter `write: true` — the agent may edit files and run shell commands
   * (sandboxed to the project, no network). Absent/false keeps it read-only. Only
   * dispatch_writable_agent honors this; dispatch_agent always runs read-only.
   */
  write?: boolean
  /**
   * Front-matter `model:` — the model this agent runs on instead of the parent
   * run's, so routine delegated work can run on a cheaper/faster sibling model.
   * Matched against the current provider's configured model ids at dispatch time;
   * when it isn't one of them (the file is checked in, providers vary per machine)
   * the dispatch falls back to the parent's model rather than failing.
   */
  model?: string
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

/** Parse a truthy front-matter flag (`true`/`yes`/`on`/`1`). */
function parseBool(value: string | undefined): boolean {
  return value !== undefined && /^(true|yes|on|1)$/i.test(value.trim())
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
    const write = parseBool(data.write)
    const model = data.model?.trim()
    agents.push({
      name,
      description: data.description || firstLine(systemPrompt) || name,
      systemPrompt,
      ...(tools ? { tools } : {}),
      ...(write ? { write: true } : {}),
      ...(model ? { model } : {})
    })
  }
  agents.sort((a, b) => a.name.localeCompare(b.name))
  return agents
}
