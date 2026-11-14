import { realpathSync } from 'node:fs'
import type { ReasoningEffort } from '@shared/agent'
import type { Command } from '@shared/commands'
import { resolveModelArg } from '@shared/modelArg'
import { commandTurn, type InvokedTurn } from '@shared/promptInvocation'
import { folderTrustState, type AppSettings, type PermissionRule } from '@shared/types'
import { loadProjectConfig } from './projectConfig'
import { parseToolList } from './toolScope'
import { expandCommandContext, type ContextConsent } from './commandContext'
import type { ShellCapture } from '../userShell'

/**
 * Running a custom command whose frontmatter asks for more than a prompt.
 *
 * A `.houston/commands` file can name the model and thinking effort its turn runs
 * on, a subagent to hand the prompt to, and tools to pre-approve for that one turn.
 * Every client (the terminal, the desktop app through IPC, ACP) prepares the turn
 * here, so the trust rules below are decided in one place and in the main process,
 * never from what a renderer or an editor sends.
 *
 * The trust boundary: a project command comes from the repository, which is
 * attacker-controlled in a folder the user has not trusted. Its `allowed-tools`
 * would auto-approve tool calls on the user's behalf, so there it is ignored, with a
 * note saying so. Its `model`, `effort` and `agent` only choose how the turn runs
 * (every tool call still goes through the rules and the approval policy), so they
 * apply, and each is named in a note rather than applied silently. A user-level
 * command (`~/.houston/commands`) is the user's own and is honored in full.
 *
 * A template's `@file` and `` !`command` `` context is filled in here too, before
 * anything is sent (see commandContext.ts for its own trust rules).
 */

/** A custom command turn, ready to send, plus how this one turn runs. */
export interface PreparedCommandRun {
  turn: InvokedTurn
  /** The model this turn runs on instead of the chat's own (never saved to the chat). */
  model?: { providerId: string; model: string }
  /** The thinking effort for this turn only. */
  effort?: ReasoningEffort
  /** Tools pre-approved for this run only (`AgentRunRequest.turnAllowRules`). */
  turnAllowRules?: PermissionRule[]
  /** One-line notes for the user, shown dim before the turn runs. */
  notes: string[]
}

export type CommandRunResult = { ok: true; run: PreparedCommandRun } | { ok: false; error: string }

export interface CommandRunContext {
  settings: AppSettings
  /** Whether the workspace's project config is trusted (see {@link workspaceTrusted}). */
  trusted: boolean
  /** The workspace the command runs in, for its `@file` and shell context. */
  workspace: string
  /**
   * Ask the user to allow a template's shell commands or credential-file reads.
   * Absent where nobody can be asked (an editor over ACP): those are refused.
   */
  confirmContext?: (consent: ContextConsent) => Promise<boolean>
  /** Run one shell command for the context (tests inject it). */
  runShell?: (command: string) => Promise<ShellCapture>
}

/**
 * Whether the user trusted this folder's elevating project config, as it is on disk
 * now: the same test the run loop applies before honoring project allow rules.
 */
export async function workspaceTrusted(workspace: string, trustedFolders: AppSettings['trustedFolders']): Promise<boolean> {
  const cfg = await loadProjectConfig(workspace)
  if (!cfg.elevatedHash) return false
  let path = workspace
  try {
    path = realpathSync(workspace)
  } catch {
    // Keep the raw path; trust records normalize the same way.
  }
  return folderTrustState(trustedFolders, path, cfg.elevatedHash) === 'trusted'
}

/**
 * Parse `allowed-tools` into this turn's allow rules. Each entry is a tool name or
 * `tool(pattern)`, the permission-rule syntax the headless `--allowed-tools` uses.
 */
export function parseAllowedTools(raw: string): { rules: PermissionRule[] } | { error: string } {
  const parsed = parseToolList(raw, 'allowed-tools')
  if ('error' in parsed) return { error: parsed.error }
  // A tool glob (`mcp__github__*`) is not something a permission rule can match, so it
  // would quietly pre-approve nothing; say so instead.
  const glob = parsed.entries.find((e) => e.tool !== '*' && e.tool.includes('*'))
  if (glob) return { error: `allowed-tools: ${glob.tool} is a pattern; name each tool, like read_file,glob` }
  return { rules: parsed.entries.map((e) => ({ action: 'allow' as const, tool: e.tool, match: e.match })) }
}

/** How an entry reads in a note: `read_file`, `run_shell(git status*)`. */
function ruleLabel(r: PermissionRule): string {
  return r.match === '*' ? r.tool : `${r.tool}(${r.match})`
}

/**
 * Prepare a custom (or first-party template) command as a turn: its expanded prompt,
 * the per-turn model, effort and pre-approved tools its frontmatter asks for, and the
 * notes that say what was applied or ignored. Null when `cmd` has no template.
 */
export async function prepareCommandRun(
  cmd: Command,
  args: string,
  typed: string,
  ctx: CommandRunContext
): Promise<CommandRunResult | null> {
  if (cmd.template === undefined) return null
  const name = `/${cmd.name}`
  // A first-party template (`/review`) is Houston's own text: only a workspace's or
  // the user's command gets its context filled in.
  let expanded: string | undefined
  if (cmd.source) {
    const filled = await expandCommandContext(cmd.template, args, {
      workspace: ctx.workspace,
      roots: [ctx.workspace, ...(ctx.settings.additionalRoots ?? [])],
      preapproved: cmd.source === 'user' || ctx.trusted,
      ...(ctx.confirmContext ? { confirm: ctx.confirmContext } : {}),
      ...(ctx.runShell ? { runShell: ctx.runShell } : {})
    })
    if (!filled.ok) return { ok: false, error: `${name} wasn't sent: ${filled.error}` }
    expanded = filled.text
  }
  const turn = commandTurn(cmd, args, typed, expanded)
  if (!turn) return null
  const notes: string[] = []
  const run: PreparedCommandRun = { turn, notes }

  if (cmd.model) {
    const picked = resolveModelArg(cmd.model, ctx.settings)
    const provider = picked ? ctx.settings.providers.find((p) => p.id === picked.providerId) : undefined
    if (!picked) {
      notes.push(`${name} asks for the model ${cmd.model}, which isn't set up here; using this chat's model`)
    } else if (provider?.requiresKey && !provider.hasKey) {
      notes.push(`${name} asks for ${picked.providerId}/${picked.model}, which has no API key; using this chat's model`)
    } else {
      run.model = picked
      notes.push(`${name} runs on ${picked.providerId}/${picked.model} for this turn`)
    }
  }
  if (cmd.effort) {
    run.effort = cmd.effort
    notes.push(`${name} thinks at ${cmd.effort} effort for this turn`)
  }
  if (cmd.agent) notes.push(`${name} hands its prompt to the ${cmd.agent} subagent`)
  if (cmd.allowedTools) {
    if (cmd.source === 'project' && !ctx.trusted) {
      notes.push(`ignoring allowed-tools in ${name}: this folder isn't trusted, so its tools still ask (see /trust)`)
    } else {
      const parsed = parseAllowedTools(cmd.allowedTools)
      if ('error' in parsed) {
        notes.push(`ignoring allowed-tools in ${name}: ${parsed.error}`)
      } else if (parsed.rules.length) {
        run.turnAllowRules = parsed.rules
        notes.push(`pre-approved for this turn: ${parsed.rules.map(ruleLabel).join(', ')}`)
      }
    }
  }
  return { ok: true, run }
}
