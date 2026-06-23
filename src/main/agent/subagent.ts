import type { ChatMessage, Provider } from '@shared/agent'
import { getTool } from './tools'

/**
 * A read-only research subagent. The main agent delegates a scoped question to a
 * fresh nested loop with its own context; the subagent investigates with the
 * read-only tools and returns a synthesized report. Keeping it read-only means
 * it needs no approval prompts and can't make changes or leave the machine —
 * the parent agent does any writing, with the user in the loop as usual.
 */

/** Tools a subagent may use — local, read-only, no network egress. */
export const SUBAGENT_TOOLS = ['read_file', 'list_dir', 'glob', 'search_files'] as const
const SUBAGENT_TOOL_SET = new Set<string>(SUBAGENT_TOOLS)

const MAX_SUBAGENT_ITERATIONS = 16
const SUBAGENT_MAX_TOKENS = 4096

function subAgentSystemPrompt(workspace: string): string {
  return `You are a research subagent working inside the project at ${workspace}. Another agent has delegated a focused question to you.

You can only READ: read_file, list_dir, glob, search_files. You cannot edit files, run commands, or access the network.

Investigate efficiently, then answer the question directly. Your final message is your entire report back to the calling agent — make it self-contained: include the concrete findings (file paths, key code, answers) it needs, not a narration of your steps. Be concise.`
}

export interface SubAgentOptions {
  provider: Provider
  model: string
  workspace: string
  /** The task/question delegated to the subagent. */
  prompt: string
  signal: AbortSignal
}

/** Run a read-only subagent loop to completion and return its final report text. */
export async function runSubAgent(opts: SubAgentOptions): Promise<string> {
  const { provider, model, workspace, prompt, signal } = opts
  const tools = SUBAGENT_TOOLS.map((name) => getTool(name)!.schema)
  const system = subAgentSystemPrompt(workspace)
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }]
  let lastText = ''

  for (let iter = 0; iter < MAX_SUBAGENT_ITERATIONS; iter++) {
    if (signal.aborted) return lastText.trim() || '[subagent aborted]'

    let text = ''
    const calls: { id: string; name: string; arguments: Record<string, unknown> }[] = []
    try {
      for await (const ev of provider.streamChat({
        model,
        system,
        messages,
        tools,
        maxTokens: SUBAGENT_MAX_TOKENS,
        signal
      })) {
        if (ev.type === 'text') text += ev.text
        else if (ev.type === 'tool_call') calls.push(ev.call)
        else if (ev.type === 'error') return `[subagent error: ${ev.message}]`
      }
    } catch (e) {
      if (signal.aborted) return lastText.trim() || '[subagent aborted]'
      return `[subagent error: ${(e as Error).message}]`
    }

    if (text.trim()) lastText = text
    messages.push({ role: 'assistant', content: text, ...(calls.length ? { toolCalls: calls } : {}) })

    if (calls.length === 0) return text.trim() || '[subagent returned no answer]'

    for (const call of calls) {
      const tool = SUBAGENT_TOOL_SET.has(call.name) ? getTool(call.name) : undefined
      let output: string
      if (!tool) {
        output = `Tool not available to a read-only subagent: ${call.name}`
      } else {
        try {
          output = await tool.execute(call.arguments, { workspace, allowNetwork: false, signal })
        } catch (e) {
          output = `Error: ${(e as Error).message}`
        }
      }
      messages.push({ role: 'tool', content: output, toolCallId: call.id, toolName: call.name })
    }
  }

  return lastText.trim() || '[subagent reached its step limit without a final answer]'
}
