import { randomUUID } from 'node:crypto'
import type { UnreadOutcome } from '@shared/chatStatus'
import { existsSync, realpathSync, statSync } from 'node:fs'
import {
  APPROVAL_POLICIES,
  APPROVAL_POLICY_LABEL,
  HOOK_EVENTS,
  folderTrustState,
  isApprovalPolicy,
  parseApprovalPolicy,
  removeFolderTrust,
  upsertFolderTrust,
  type AppSettings,
  type ApprovalPolicy,
  type FolderTrustState,
  type Hook,
  type McpServerConfig,
  type ModelOption,
  type PermissionPolicyView,
  type PermissionRule,
  type ProviderConfig,
  type RecentDenial
} from '@shared/types'
import { loadProjectConfig } from './agent/projectConfig'
import type { ShellCapture } from './userShell'
import { prepareCommandRun, workspaceTrusted, type PreparedCommandRun } from './agent/commandRun'
import { describeContextConsent, type ContextConsent } from './agent/commandContext'
import { isMcpPromptLine, prepareMcpPromptRun, type McpPromptFetch } from './agent/mcpPromptCommands'
import type { ScheduledRunInfo } from './agent/scheduler'
import { loopScheduleName, parseLoopArgs, scheduleWhen } from '@shared/loopCommand'
import type { MessageMentionResult } from './agent/messageMentions'
import { HOOK_TIMEOUT_MAX_S, HOOK_TIMEOUT_MIN_S, HOOK_TIMEOUT_MS } from './agent/hooks'
import { appendUserTurn } from './agent/userTurn'
import {
  catalogForPlatform,
  catalogEntryToProvider,
  providerSetupFields,
  customEndpointError,
  customEndpointToProvider,
  customProviderId,
  type CatalogEntry
} from '@shared/provider-catalog'
import { providerKeyUrl } from '@shared/provider-keys'
import { runtimeMissingLine } from '@shared/runtimes'
import { compactionNoticeText, modelFallbackText, retryNoticeText, verificationNoticeText } from '@shared/runNotices'
import { formatReceiptLines, receiptHasFailure } from '@shared/evidence'
import { formatReadinessLines, planVerifySteps, readinessOk } from '@shared/planReadiness'
import { diffStat, type FileDiffPreview } from '@shared/diff'
import {
  BUILTIN_TEMPLATE_COMMANDS,
  commandHasRunOptions,
  mergeCommands,
  isReservedCommandName,
  resolveCommand,
  type Command
} from '@shared/commands'
import { resolveModelArg } from '@shared/modelArg'
import {
  agentTurn,
  commandTurn,
  proposalHereTurn,
  type InvokedTurn,
  type PromptInvocation
} from '@shared/promptInvocation'
import { parseMemoryCapture, type MemoryScope } from '@shared/memory'
import type { CompactOptions, CompactResult } from './agent/compact'
import type { McpServerStatus } from './mcp/manager'
import type {
  AgentEvent,
  AgentRunRequest,
  BackgroundShellInfo,
  ChatMessage,
  ElicitationResult,
  PlanAcceptMode,
  PlanDecision,
  PlanPayload,
  QuestionOption,
  KillShellOutcome,
  ReasoningEffort,
  ToolApprovalDecision
} from '@shared/agent'
import { buildElicitationContent } from '@shared/mcp'
import { MAX_ATTACHMENTS, type ImageAttachment } from '@shared/images'
import { isReasoningEffort, REASONING_EFFORTS, retryProgress, SYSTEM_NOTE_PREFIX } from '@shared/agent'
import { quotaIsLow, quotaStatusText, resetClock, type ProviderQuota } from '@shared/rateLimit'
import { providerQuota, providerQuotas } from './providers/quota'
import { noteThrottle, rateLimitSnapshot } from './rateLimitStore'
import { newestRateLimits, type RateLimitState } from '@shared/rateLimitState'
import { contextWindowFor, contextPercent, accumulateModelUsage, formatCost, formatTokens, longContextTierAbove, modelCapabilities, resolveCapabilities } from '@shared/usage'
import { ultrathinkEffect, type UltrathinkEffect } from '@shared/ultrathink'
import { providerSendsXhigh } from '@shared/model-facts'
import type { ContextParts, ModelUsage, RunLimitReason, SideChatTurn } from '@shared/agent'
import { latestRunEnd, limitNoticeText, runEndNoticeText, runOutcomePhrase, type RunOutcome } from '@shared/runEnd'
import { renderContextReport } from '@shared/contextBreakdown'
import { compactionLimitFrom, compactionThresholdNote } from '@shared/compactionThreshold'
import { parseTodosSafe, type Todo } from '@shared/todos'
import { modelDisplayName, pickDefaultModel } from '@shared/models'
import { DEFAULT_REASONING_EFFORT } from '@shared/defaults'
import { assertNever } from '@shared/assert'
import { PROPOSE_SESSION_TOOL } from '@shared/constants'
import { parseShellEscape, renderShellEscapeRecord } from '@shared/shellEscape'
import type { ConversationSettingsPatch, DeleteConversationResult, ProposalState } from '@shared/agent'
import type { DeletePlan } from './deleteChat'
import { comeBackCommand } from './sessionWorktree'
import { deletePromptText, deleteWorktreeOutcome, parseDeleteAnswer, planForSession, type TuiDeletePlan } from './tui-delete'
import { createFindingPrinter } from '@shared/reviewFindings'
import { ASK_USER_TOOL, PRESENT_PLAN_TOOL } from '@shared/constants'
import { PLAN_OUTCOME_LABEL, deniedPromptText, planOutcome, stoppedPromptText } from '@shared/promptOutcome'
import {
  truncateVisible,
  stripControlChars,
  stripControlCharsKeepLines,
  osc52Copy,
  osc8Link,
  terminalText,
  filterTerminalOutput,
  takeStreamedRows,
  visibleWidth,
  wrapAnsi
} from './tui-wrap'
import { approvalSubject, visibleText } from '@shared/visibleText'
import { approvalWarnings, type ApprovalWarning } from '@shared/approvalWarnings'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SHOW_IMAGES_NAME, parseGalleryArgsSafe } from '@shared/gallery'
import { SHARE_MESSAGE } from '@shared/share'
import { MarkdownStream, renderMarkdownAnsi } from './markdown-ansi'
import { describeToolCall } from '@shared/toolLabel'
import { approvalAskReasons } from '@shared/approvalReasons'
import { capAnswer, capPlanDecision, QUESTION_DISMISSED_ANSWER } from '@shared/answerCaps'
import { ruleActionOf, waitForSavedRules } from '@shared/savedRules'
import { renderSavedRules } from './tui-saved-rules'
import { renderPreviewView } from './tui-diff'
import {
  chatToJson,
  chatToMarkdown,
  defaultExportName,
  parseExportArgs,
  redactExport,
  renderRecap,
  sessionPreviewLines,
  type ExportArgs
} from './tui-sessions'
import { markdownLinks, type MarkdownLinks } from './tui-links'
import { ReviewTally, isHiddenTool, renderTurnError, toolImagesLine, turnModelsLabel } from './tui-runview'
import { meterOnEvent, meterTokens, startMeter } from '@shared/runMeter'
import { comeBackHint, parseForkArg, reconcileChatModel } from './tui-chat-handoff'
import type { ForkPoint } from '@shared/conversation-io'
import { redactSecrets } from './agent/redact'
import { LiveTail } from './tui-livetail'
import { latestTodos, todoProgress } from './tui-todos'
import type { ImportedChat } from './tui-import'
import { conversationToHtml } from '@shared/html-export'
import { htmlToAnsi } from './syntax'
import type { PickerAction, PickerOption, PickerSpec, PickerOutcome } from './tui-picker'
import { codeBlockLabel, copyableReplies, describeCopied, extractCodeBlocks, nthLatestReply } from './tui-copy'
import { renderRateLimits, renderUsageReport } from './tui-usage'
import {
  linkedWorktreeRoot,
  resolveStatusLine,
  STATUS_LINE_FIELDS,
  StatusLineRunner,
  type ResolvedStatusLine,
  type StatusLineConfig,
  type StatusLineExec,
  type StatusLinePayload
} from './tui-statusline'
import type { UsageReport } from '@shared/usageReport'
import type { Scorecard } from '@shared/scorecard'
import { renderScorecard } from './tui-scorecard'
import { FALLBACK_USAGE, fallbackChange, parseFallbackArgs, renderFallbacks, type FallbackOp } from './tui-fallback'
import {
  chatSubagents,
  parseTasksArgs,
  renderShellDetail,
  renderSubagentDetail,
  renderTaskList,
  shellInChat,
  shellKillPhrase,
  liveAgentLines,
  liveAgentPanel,
  SubagentTracker,
  taskPickerSpec,
  taskRows,
  taskRunning,
  TASK_TAIL_LINES,
  TASKS_USAGE,
  type TaskRow,
  type TasksOp,
  type TrackedSubagent
} from './tui-tasks'
import { parseGitCommand, runGitCommand, YIELDS_TO_CUSTOM, type GitDeps, type GitOp } from './tui-git'
import { parseChangesArgs, renderChangeSummary, runChangesCommand, type ChangesDeps, type ChangesOp } from './tui-changes'
import { parseQueueArgs, renderQueueList, QUEUE_USAGE, type QueueOp } from './tui-queue'
import {
  signalFor,
  idleTitle,
  workingTitle,
  progressForEvent,
  type ProgressState,
  idleReminderSpec,
  resolveNotifyMode,
  describeNotifyMode,
  isNotifyMode,
  NOTIFY_MODES,
  type NotifyMode,
  type TerminalSignal
} from './tui-notify'
import { parseSettingsCommand, renderAccessSummary, type SettingsCommand } from './tui-settings-set'
import { runSettingsCommand } from './tui-settings-run'
import { inferVerifyCommand } from './verifyInfer'
import { BTW_QUESTION_PROMPT, renderRecentSideChat } from './tui-btw'
import { workspaceLabel, type NotifySpec } from '@shared/notify'
import {
  REWIND_MODE_INFO,
  rewindConfirmText,
  rewindDoneText,
  rewindPoints,
  rewindsConversation,
  turnText,
  type RewindMode,
  type RewindPoint,
  type RewindPreviewResult,
  type RewindResult,
  type UndoRewindResult
} from '@shared/rewind'
import { ComposerBuffer } from './tui-composer'
import { renderTranscript, sanitizeLines, transcriptPlain, type PagerSource } from './tui-pager'
import { parseMemoryAction, runMemoryCommand, type MemoryAction, type MemoryCommandState } from './tui-memory'
import {
  forgetTrustAt,
  parsePermissionsArgs,
  renderTrustList,
  runPermissionsCommand,
  type PermissionsOp
} from './tui-permissions'
import { parseScheduleArgs, runScheduleCommand, type ScheduleBackend, type ScheduleOp } from './tui-schedules'
import { parseLoginArgs, refreshProviderModels, runLoginOp, type LoginOp, type ProviderCommandDeps } from './tui-providers'
import type { MemoryStore } from './agent/memoryStore'
import { buildDoctorReport, renderDoctor, type DoctorFacts } from './tui-doctor'
import {
  CONFIG_KEYS,
  configPatch,
  findConfigKey,
  nextConfigValue,
  parseConfigArgs,
  renderConfigHelp,
  renderConfigValue,
  type ConfigContext,
  type ConfigKeyName,
  type ConfigLive,
  type ConfigOp
} from './tui-config'
import { renderStatus, type HostStatusFacts, type StatusView } from './tui-status'
import { runFeedbackCommand, type IssueReportHost } from './tui-feedback'
import { flagValue, nameOf, resolveHeadlessModel } from './headless'
import {
  parseSessionFlag,
  resolveAddDir,
  scopeEntryText,
  sessionFlagConflict,
  sessionFlagFields,
  type SessionFlags,
  type SessionInputs
} from './sessionFlags'
import { isSubagentTool, splitSubagentReport, stepHint, subagentSpend, SubagentTermLines, type SubagentRecord, type SubagentSpend } from '@shared/subagents'
import { renderSubagentSpend, renderWhatsNew } from './tui-info'
import { formatElapsed } from '@shared/elapsed'
import {
  registryDelivery,
  registryInstallOptions,
  type RegistryGetResult,
  type RegistrySearchResult,
  type RegistryServer
} from '@shared/mcpRegistry'
import {
  applyDraftInputs,
  catalogDraft,
  draftInputKey,
  freeServerId,
  MCP_CATALOG,
  serverProblem,
  type McpDraft
} from '@shared/mcpCatalog'
import { stripInvisible, invisibleNote } from '@shared/invisibleChars'
import {
  createDraftSaver,
  draftKey,
  draftRestoreNote,
  draftRestoreText,
  type DraftRecord,
  type DraftStore
} from './tui-drafts'

/**
 * Interactive terminal mode: a stay-resident REPL you converse with directly in
 * the terminal — the third client over the shared agent core, alongside the GUI
 * and the one-shot headless CLI. Unlike headless (fire one prompt and exit), this
 * keeps a conversation going, streams output live, and — crucially — prompts a
 * *real* human for tool approvals and `ask_user` questions instead of
 * auto-answering.
 *
 * The agent loop is UI-agnostic (see headless.ts), so this is again just an
 * alternate entry point + transport: the same provider adapters, tools, sandbox,
 * and rules apply. Everything here is pure / dependency-injected (no Electron, no
 * `node:readline`, no real stdin/stdout) so it can be unit-tested; index.ts wires
 * the real terminal I/O when an interactive flag is present.
 */

export interface TuiOptions extends SessionFlags {
  cwd: string
  providerId?: string
  model?: string
  /**
   * Starting approval policy from `--approval`/`--full-auto`; switchable at runtime with
   * `/approval`. Absent: the saved mode from settings (what the desktop app last used, or
   * a fresh install's default), so both clients start the same way.
   */
  approvalPolicy?: ApprovalPolicy
  /** Colorize output. index.ts sets this from TTY + NO_COLOR detection. */
  color: boolean
  /**
   * Reopen the most recent chat in this folder at launch (`--continue`), or a
   * specific one (`--resume <id>`).
   *
   * Headless has had both since it existed; the terminal had neither, so picking
   * up where you left off meant starting a session and then running /resume — one
   * more step, every time, for the most ordinary thing you do.
   */
  continueSession?: boolean
  resumeId?: string
  /**
   * The folder `houston` was started in, when the session moved elsewhere before
   * the TUI began (a `-w` worktree, or a resumed chat's own folder). The exit hint
   * names `cwd` then, since the plain command would look in this one.
   */
  launchCwd?: string
  /**
   * The theme the terminal's background suggests (`light` on a light background),
   * used only while no theme is saved: a `/theme` choice always wins.
   */
  detectedTheme?: ThemeName
  /**
   * Reduced motion for this session: the entry point resolves it from
   * HOUSTON_REDUCE_MOTION and the saved setting; /reduce-motion changes it.
   */
  reduceMotion?: boolean
  /**
   * Screen-reader mode for this session (`--screen-reader`, HOUSTON_SCREEN_READER or
   * the saved setting, resolved at the entry point); /screen-reader changes it.
   */
  screenReader?: boolean
  /**
   * The first bad flag value (`--approval nonsense`). runTui reports it and exits
   * with a usage error before anything runs, rather than silently ignoring it.
   */
  usageError?: string
  /**
   * What the session flags that name files or tools resolved to
   * (`--append-system-prompt`, `--mcp-config`, `--allowed-tools`/`--disallowed-tools`),
   * read and checked by the entry before the session starts. Every
   * turn of the session carries them.
   */
  sessionInputs?: SessionInputs
}

/**
 * Parse argv for interactive mode. Returns null when no interactive flag
 * (`-i` / `--interactive` / `--tui`) is present, so the caller falls through to
 * the headless check and then the GUI. Shares flag plumbing with headless so the
 * two entry points accept the same `--cwd` / `--provider` / `--model` /
 * `--approval` / `--full-auto` options.
 *
 * `defaultInteractive` lets a caller treat the absence of `-i` as interactive
 * anyway (still honoring the other flags): the standalone CLI passes it when a
 * bare `houston` is typed at a TTY, so `houston` alone drops into the REPL. The
 * desktop binary leaves it false so a bare `Houston` still opens the GUI.
 */
export function parseTuiArgs(
  argv: string[],
  defaultCwd: string,
  defaultInteractive = false
): TuiOptions | null {
  let interactive = false
  let cwd = defaultCwd
  let providerId: string | undefined
  let model: string | undefined
  let approvalPolicy: ApprovalPolicy | undefined
  let continueSession = false
  let resumeId: string | undefined
  let usageError: string | undefined
  let screenReader = false
  const session: SessionFlags = {}
  const bad = (message: string): void => {
    usageError ??= message
  }

  for (let i = 0; i < argv.length; i++) {
    const name = nameOf(argv[i])
    // The flags a one-shot run takes too (effort, tool scope, MCP, title, …).
    const sessionNext = parseSessionFlag(argv, i, defaultCwd, session, bad)
    if (sessionNext !== null) {
      i = sessionNext
      continue
    }
    if (name === '-i' || name === '--interactive' || name === '--tui') {
      interactive = true
    } else if (name === '-C' || name === '--cwd') {
      const { value, next } = flagValue(argv, i)
      // Relative to where the command was typed, so the session's folder is a real
      // absolute path for persistence, trust, and the agent's workspace.
      if (value) cwd = isAbsolute(value) ? value : resolvePath(defaultCwd, value)
      i = next
    } else if (name === '--model') {
      const { value, next } = flagValue(argv, i)
      model = value
      i = next
    } else if (name === '--provider') {
      const { value, next } = flagValue(argv, i)
      providerId = value
      i = next
    } else if (name === '--approval') {
      const { value, next } = flagValue(argv, i)
      if (isApprovalPolicy(value)) approvalPolicy = value
      else
        bad(
          `--approval must be one of ${APPROVAL_POLICIES.join(', ')} (got ${
            value === undefined ? 'nothing' : JSON.stringify(value)
          })`
        )
      i = next
    } else if (name === '--full-auto') {
      approvalPolicy = 'full-auto'
    } else if (name === '--screen-reader') {
      screenReader = true
    } else if (name === '--continue') {
      continueSession = true
    } else if (name === '--resume') {
      const { value, next } = flagValue(argv, i)
      resumeId = value
      i = next
    }
  }

  if (!interactive && !defaultInteractive) return null
  const conflict = sessionFlagConflict(session, { continueSession, resumeId })
  if (conflict) bad(conflict)
  return {
    cwd,
    providerId,
    model,
    ...(approvalPolicy ? { approvalPolicy } : {}),
    color: true,
    ...(continueSession ? { continueSession } : {}),
    ...(resumeId ? { resumeId } : {}),
    ...sessionFlagFields(session),
    ...(screenReader ? { screenReader } : {}),
    ...(usageError !== undefined ? { usageError } : {})
  }
}

/**
 * Run `/add-dir`: add `path` to the session's directories (the next turn's runs may
 * work there, as with Settings' additional directories, until the session ends), or
 * list them when no path is given. Returns the line to print.
 */
export function applyAddDir(dirs: string[], path: string, base: string): string {
  if (!path) {
    return dirs.length
      ? `· directories added this session: ${dirs.join(', ')}`
      : '· no directories added this session; /add-dir <path> adds one'
  }
  const added = resolveAddDir(path, base)
  if ('error' in added) return `· /add-dir ${added.error}`
  if (dirs.includes(added.dir)) return `· ${added.dir} is already added`
  dirs.push(added.dir)
  return `· added ${added.dir} for this session: the agent can read and edit it from the next message`
}

/**
 * Where `/cd <path>` goes: `path` with a leading `~` read as the home folder and a
 * relative one taken from `base`, resolved through symlinks, as long as it is an
 * existing directory. Never creates anything.
 */
export function resolveCdTarget(
  path: string,
  base: string,
  home = process.env.HOME ?? process.env.USERPROFILE ?? ''
): { dir: string } | { error: string } {
  const v = path.trim()
  if (!v) return { error: 'needs the path of a folder, like ../other-project' }
  const expanded = v === '~' ? home : v.startsWith('~/') && home ? `${home}${v.slice(1)}` : v
  const target = isAbsolute(expanded) ? expanded : resolvePath(base, expanded)
  let dir: string
  try {
    dir = realpathSync(target)
    if (statSync(dir).isDirectory()) return { dir }
  } catch {
    return { error: `no such folder: ${v}` }
  }
  return { error: `not a folder: ${v}` }
}

/**
 * The run-request fields every turn of an interactive session carries from its
 * launch flags (the same request fields a one-shot run sets). Pure.
 */
export function sessionRunRequestFields(
  inputs: SessionInputs | undefined
): Pick<AgentRunRequest, 'toolScope' | 'appendSystemPrompt' | 'extraMcpServers'> {
  if (!inputs) return {}
  return {
    ...(inputs.toolScope ? { toolScope: inputs.toolScope } : {}),
    ...(inputs.appendSystemPrompt !== undefined ? { appendSystemPrompt: inputs.appendSystemPrompt } : {}),
    ...(inputs.mcpServers ? { extraMcpServers: inputs.mcpServers } : {})
  }
}

/** The startup lines that say which launch flags shape this session. Pure. */
export function sessionInputLines(
  opts: Pick<TuiOptions, 'sessionInputs' | 'allowedTools' | 'disallowedTools' | 'addDirs'>
): string[] {
  const inputs = opts.sessionInputs ?? {}
  const lines: string[] = []
  if (inputs.toolScope) {
    const parts = [
      ...(opts.allowedTools ? [`allowed: ${opts.allowedTools.map(scopeEntryText).join(', ')}`] : []),
      ...(opts.disallowedTools ? [`disallowed: ${opts.disallowedTools.map(scopeEntryText).join(', ')}`] : [])
    ]
    lines.push(`tools scoped for this session (${stripControlChars(parts.join('; '))})`)
  }
  if (inputs.appendSystemPrompt !== undefined) lines.push('extra system prompt instructions for this session')
  if (inputs.mcpServers?.length) {
    lines.push(`extra MCP servers for this session: ${inputs.mcpServers.map((m) => stripControlChars(m.id)).join(', ')}`)
  }
  if (opts.addDirs?.length) {
    lines.push(`extra directories for this session: ${opts.addDirs.map(stripControlChars).join(', ')}`)
  }
  return lines
}

// --- Rendering ---------------------------------------------------------------
// Small ANSI helpers. Kept as a factory returning plain string transforms so the
// render functions are pure and testable (assert on content, and that color=false
// emits no escape codes), and so a non-TTY / NO_COLOR run is styling-free.

/**
 * Color themes: each maps a style key to its SGR sequence. `default` is standard
 * ANSI; `bright` uses the high-intensity foregrounds (for dark terminals);
 * `mono` keeps structure (bold/dim) but drops color (light terminals / a11y).
 * The style keys are identical across themes, so every renderer is theme-agnostic.
 */
export const THEMES = {
  default: {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m'
  },
  /** High-intensity foregrounds: readable on a DARK background. */
  dark: {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    red: '\x1b[91m', green: '\x1b[92m', yellow: '\x1b[93m',
    blue: '\x1b[94m', magenta: '\x1b[95m', cyan: '\x1b[96m'
  },
  /**
   * Darker foregrounds for a LIGHT background. Yellow is unreadable on white even in
   * its standard form in many terminals, and cyan washes out, so those two use darker
   * 256-color shades (dark gold, teal); the rest are the standard colors. Picked
   * automatically when the terminal reports a light background and no theme is saved.
   */
  light: {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[38;5;136m',
    blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[38;5;30m'
  },
  /**
   * Colorblind-safe: red/green carry most of the meaning in a diff, and that is
   * the single most common form of color blindness. This maps them to blue and
   * yellow — distinguishable under deuteranopia and protanopia — rather than
   * dropping color entirely the way `mono` does.
   */
  colorblind: {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    red: '\x1b[38;5;208m', green: '\x1b[38;5;33m', yellow: '\x1b[38;5;178m',
    blue: '\x1b[38;5;33m', magenta: '\x1b[38;5;171m', cyan: '\x1b[38;5;37m'
  },
  mono: {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    red: '', green: '', yellow: '', blue: '', magenta: '', cyan: ''
  },
  /**
   * `colorblind` for a LIGHT background: the same red→orange, green→blue mapping in
   * darker shades (vermilion, a deep blue, dark gold) that hold their contrast on white.
   */
  'colorblind-light': {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    red: '\x1b[38;5;166m', green: '\x1b[38;5;25m', yellow: '\x1b[38;5;136m',
    blue: '\x1b[38;5;25m', magenta: '\x1b[38;5;133m', cyan: '\x1b[38;5;30m'
  },
  /**
   * Only the 16 colors the terminal's own palette defines, so every color is the one
   * you configured there (no 256-color shades), and dim text is bright black rather
   * than the faint attribute, which some terminals don't draw.
   */
  ansi16: {
    reset: '\x1b[0m', dim: '\x1b[90m', bold: '\x1b[1m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m'
  }
} as const

/** A theme's SGR sequence for each style key. */
export type ThemePalette = { readonly [K in keyof (typeof THEMES)['default']]: string }

/**
 * Themes loaded from `~/.houston/themes/*.json` (see tui-themes.ts), by name. Set once
 * at launch by the entry point; a built-in theme's name is never shadowed.
 */
const userThemes = new Map<string, ThemePalette>()

/** Replace the user themes (the entry point at launch; tests). */
export function setUserThemes(themes: ReadonlyMap<string, ThemePalette> | Record<string, ThemePalette>): void {
  userThemes.clear()
  const entries = themes instanceof Map ? [...themes.entries()] : Object.entries(themes)
  for (const [name, palette] of entries) if (!(name in THEMES)) userThemes.set(name, palette)
}

/** Every theme /theme offers: the built-ins, then the user's own. */
export function themeNames(): string[] {
  return [...Object.keys(THEMES), ...[...userThemes.keys()].sort()]
}

/** A theme's palette, built-in or the user's, or null for an unknown name. */
export function themePalette(name: string): ThemePalette | null {
  return (THEMES as Record<string, ThemePalette>)[name] ?? userThemes.get(name) ?? null
}

/**
 * `bright` was the old name for what is now `dark`. Kept as an alias so a saved
 * setting (or muscle memory) doesn't break — a theme name that used to work and
 * now errors is a worse experience than one extra line here.
 */
const THEME_ALIASES: Record<string, ThemeName> = { bright: 'dark', 'colorblind-dark': 'colorblind' }

/** Resolve a theme name, honoring the aliases. */
export function resolveTheme(name: string): ThemeName | null {
  const n = name.trim().toLowerCase()
  if (isThemeName(n)) return n
  return THEME_ALIASES[n] ?? null
}

/** A theme's name: a built-in one, or a user theme's. */
export type ThemeName = keyof typeof THEMES | (string & {})
export type Painter = (s: string, ...styles: Array<keyof (typeof THEMES)['default']>) => string

export function isThemeName(v: string): v is ThemeName {
  return Object.hasOwn(THEMES, v) || userThemes.has(v)
}

export function makePainter(color: boolean, theme: ThemeName = 'default'): Painter {
  if (!color) return (s) => s
  const palette = themePalette(theme) ?? THEMES.default
  return (s, ...styles) => {
    const codes = styles.map((k) => palette[k]).filter(Boolean).join('')
    return codes ? `${codes}${s}${palette.reset}` : s
  }
}

/** Status marks for a todo list, matching the desktop app's. */
const TODO_MARK: Record<Todo['status'], string> = { pending: '○', in_progress: '◐', completed: '●' }

/**
 * The agent's todo list, as a checklist.
 *
 * `todo_write` is how the agent shows its plan for a long task, and the desktop
 * app renders it as a live checklist. The terminal collapsed it to the tool's
 * one-line summary — "Updated todo list: 5 items (2 completed, 1 in progress)" —
 * so the one thing the tool exists to communicate was the one thing you could not
 * see. The list is already in the call's arguments; this just draws it.
 */
export function renderTodoList(todos: Todo[], paint: Painter): string {
  if (!todos.length) return paint('  ☰ todo list cleared', 'dim')
  const lines = [`${paint('☰', 'cyan')} ${paint('todo', 'cyan')}`]
  for (const t of todos) {
    const tone = t.status === 'completed' ? 'dim' : t.status === 'in_progress' ? 'cyan' : 'dim'
    const mark = paint(TODO_MARK[t.status], t.status === 'completed' ? 'green' : tone)
    // The in-progress item is what the agent is doing right now, so it is the one
    // worth being able to find at a glance.
    const text = t.status === 'in_progress' ? paint(t.content, 'bold') : paint(t.content, tone)
    lines.push(`    ${mark} ${text}`)
  }
  return lines.join('\n')
}

/**
 * One-line summary of a tool starting, named the way the desktop's tool row names
 * it: "· Read  src/x.ts", "· Run  npm test", not the wire name ("read_file").
 */
export function renderToolStart(
  name: string,
  args: Record<string, unknown>,
  paint: Painter,
  /** Screen-reader mode: a plain sentence, "Using tool Read: src/x.ts". */
  opts: { sentence?: boolean } = {}
): string {
  const { verb, target } = describeToolCall(name, args)
  // A tool the shared labels don't know keeps the old best-effort argument hint.
  // The hint is the model's argument (a command, a path) and an MCP tool's verb is its
  // server's name for it, so both are cleaned of control characters.
  const raw = terminalText(target || (verb === name ? toolArgHint(args) : ''), { lines: false }).replace(/\s+/g, ' ')
  const hint = truncate(raw.trim(), 80)
  if (opts.sentence) {
    const label = terminalText(verb, { lines: false })
    return hint ? `Using tool ${label}: ${hint}` : `Using tool ${label}`
  }
  const suffix = hint ? `  ${paint(hint, 'dim')}` : ''
  return `${paint('·', 'dim')} ${paint(terminalText(verb, { lines: false }), 'cyan')}${suffix}`
}

/**
 * A short name for one tool call ("Read src/a.ts", "Run npm test"), put in front of its
 * result and progress lines while other calls run alongside it. Parallel calls print
 * all their start rows first, so without it every result would read as belonging to
 * the last row above it.
 */
export function toolCallTag(name: string, args: Record<string, unknown> | undefined): string {
  const { verb, target } = describeToolCall(name, args)
  const hint = terminalText(target || (verb === name && args ? toolArgHint(args) : ''), { lines: false })
    .replace(/\s+/g, ' ')
    .trim()
  const shownVerb = terminalText(verb, { lines: false })
  return hint ? `${shownVerb} ${truncate(hint, 40)}` : shownVerb
}

/** Prefix the first line of a rendered result with its call's tag, after the indent. */
export function tagResultLines(rendered: string, tag: string, paint: Painter): string {
  if (!rendered) return rendered
  const nl = rendered.indexOf('\n')
  const first = nl === -1 ? rendered : rendered.slice(0, nl)
  const rest = nl === -1 ? '' : rendered.slice(nl)
  // The indent may sit inside the line's own colour codes; keep it in front either way.
  // eslint-disable-next-line no-control-regex
  const m = /^((?:\x1b\[[0-9;]*m)*)(\s*)/.exec(first)
  const lead = m ? m[0].length : 0
  return `${first.slice(0, lead)}${paint(`${tag}:`, 'dim')} ${first.slice(lead)}${rest}`
}

/** One tool call, folded into its line: what it worked on and how it went. */
export interface FoldedCall {
  target: string
  hint: string
  ok: boolean
  /** A file read's own row and result, printed instead when it is the only call on its line. */
  alone?: string
}

/** The width a folded call's target may take before it is cut. */
const FOLDED_TARGET = 60

/**
 * A finished call as one item of a folded tool line: its target ("src/a.ts") and a short
 * outcome ("40 lines", "exit 0 · 2s", "+3 −1"). Both come from the model's arguments or
 * the tool's output, so control characters are stripped.
 */
export function foldedCall(
  name: string,
  args: Record<string, unknown>,
  ok: boolean,
  output: string,
  opts: { preview?: FileDiffPreview[]; durationMs?: number } = {}
): FoldedCall {
  const { verb, target } = describeToolCall(name, args)
  const raw = terminalText(target || (verb === name ? toolArgHint(args) : ''), { lines: false }).replace(/\s+/g, ' ')
  const moved = /moved this command to the background[^\n]*background shell (\w+)/.exec(output)
  const started = /^Started background shell (\w+)/.exec(output)
  // A time only once it is worth reading; a shell's outcome only when it says how it ended.
  const durationMs = opts.durationMs !== undefined && opts.durationMs >= 1000 ? opts.durationMs : undefined
  let hint = moved
    ? `in the background as ${moved[1]}`
    : started
      ? `background shell ${started[1]}`
      : stepHint(name, output, ok, { ...(opts.preview ? { preview: opts.preview } : {}), ...(durationMs !== undefined ? { durationMs } : {}) })
  if (name === 'run_shell' && !moved && !started && !/^(exit|killed|failed)/.test(hint)) hint = ''
  if (!hint) {
    const first = terminalText(output).split('\n').find((l) => l.trim()) ?? ''
    hint = ok ? truncate(first.trim(), 50) : 'failed'
  }
  return { target: truncate(raw.trim(), FOLDED_TARGET), hint: terminalText(hint, { lines: false }), ok }
}

/**
 * The one line for a run of folded calls of one kind: "· Read  src/a.ts · 40 lines,
 * src/b.ts · 12 lines". Fitted to `width`, so it never wraps: the calls that don't fit
 * are counted ("+3 more"). `sentence` is the screen-reader wording, plain words with no
 * glyphs: "Used tool Read: src/a.ts, 40 lines".
 */
export function renderFoldedCalls(
  verb: string,
  items: FoldedCall[],
  paint: Painter,
  opts: { width?: number; sentence?: boolean; count?: string } = {}
): string {
  const shownVerb = terminalText(verb, { lines: false })
  // Counted ("Read 3 files  a.ts, b.ts, c.ts"): the targets only, as the desktop's
  // folded read row lists them.
  if (opts.count && items.length > 1) {
    const count = `${items.length} ${opts.count}`
    const list = items.map((i) => i.target).filter(Boolean).join(', ')
    if (opts.sentence) return `Using tool ${shownVerb}: ${count}${list ? `: ${list}` : ''}`
    const head = `${paint('·', 'dim')} ${paint(shownVerb, 'cyan')} ${count}`
    // "· Read 3 files  " is about 16 columns; the list gets the rest of the row.
    const room = Math.max(20, (opts.width ?? 80) - count.length - 10)
    return list ? `${head}  ${paint(truncateVisible(list, room), 'dim')}` : head
  }
  if (opts.sentence) {
    const parts = items.map((i) => [i.target, i.ok ? i.hint : `failed${i.hint && i.hint !== 'failed' ? ` (${i.hint})` : ''}`].filter(Boolean).join(', '))
    return `Used tool ${shownVerb}${parts.length ? `: ${parts.join('; ')}` : ''}`
  }
  const width = Math.max(30, (opts.width ?? 80) - 1)
  const item = (i: FoldedCall): string => {
    const mark = i.ok ? '' : `${paint('✗', 'red')} `
    const hint = i.hint ? paint(` · ${i.hint}`, i.ok ? 'dim' : 'red') : ''
    return `${mark}${i.target}${hint}`
  }
  const head = `${paint('·', 'dim')} ${paint(shownVerb, 'cyan')}`
  const sep = paint(', ', 'dim')
  let line = items.length && items[0].target ? `${head}  ` : head
  let shown = 0
  for (const i of items) {
    const rest = items.length - shown - 1
    const room = width - (rest > 0 ? ` +${rest} more`.length : 0)
    const next = `${line}${shown ? sep : ''}${item(i)}`
    if (shown > 0 && visibleWidth(next) > room) break
    line = next
    shown++
  }
  const more = items.length - shown
  if (more > 0) line += paint(` +${more} more`, 'dim')
  return truncateVisible(line, width)
}

/**
 * Whether a finished call's whole story fits its folded line. A failure shows its
 * first lines, a subagent its report, a plan its outcome, a stopped prompt what
 * stopped it, and a proposal or gallery its own line: those keep their row above them.
 */
export function foldsToOneLine(name: string, ok: boolean, output: string): boolean {
  if (!ok || isSubagentTool(name)) return false
  if (name === PRESENT_PLAN_TOOL || name === PROPOSE_SESSION_TOOL || name === SHOW_IMAGES_NAME) return false
  return stoppedPromptText(output) === null
}

/**
 * Whether an event prints something while tool rows may be waiting for their results
 * (so they print first). Tool events, usage and bookkeeping print nothing of their
 * own here; text and reasoning say so themselves when they print; a subagent's steps
 * go to the live panel when it is on (and nowhere in the focus view).
 */
export function printsBetweenCalls(e: AgentEvent, view: { focus: boolean; panel: boolean; verbose: boolean }): boolean {
  switch (e.type) {
    case 'tool_start':
    case 'tool_result':
    case 'usage':
    case 'run_info':
    case 'turn_start':
    case 'steers_returned':
    case 'text':
    case 'reasoning':
      return false
    case 'tool_progress':
      return !view.focus && e.message.trim() !== ''
    case 'subagent_step':
      return !view.focus && (!view.panel || view.verbose)
    case 'subagent_start':
    case 'subagent_end':
    case 'subagent':
    case 'review_finding':
    case 'notice':
    case 'compaction':
      return !view.focus
    default:
      return true
  }
}

/** Best-effort one-liner describing a tool call's most salient argument. */
export function toolArgHint(args: Record<string, unknown>): string {
  for (const key of ['path', 'file', 'file_path', 'command', 'cmd', 'query', 'url', 'pattern']) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) return truncate(terminalText(v, { lines: false }).replace(/\s+/g, ' ').trim(), 80)
  }
  return ''
}

/**
 * At most this many terminal rows of a command before the approval repeats its start
 * just above the choices. Past it, the head of the prompt (what is being approved, and
 * the command's first line) has scrolled up out of sight, which is exactly where a
 * command padded with dozens of lines would hide its first, dangerous one.
 */
export const APPROVAL_TEXT_MAX_ROWS = 16
// A run of spaces or tabs this long inside a line is shown as a count, so padding can't
// push the rest of a line (or the next one) off screen either.
const APPROVAL_SPACE_RUN = new RegExp(`[ \\t]{16,}`, 'g')

/**
 * Text an approval is about (a command, a memory's body), laid out for the terminal so
 * the user sees every character that will be used and nothing can hide:
 *
 *  - every control, bidi and zero-width character is shown as `<U+XXXX>`
 *    ({@link visibleText}), a carriage return and an escape included, so the text can't
 *    repaint itself as something harmless, and no character is cut or dropped;
 *  - a multi-line text has numbered lines, so a line break is never mistaken for a
 *    space and the reader can tell where each line starts;
 *  - a run of blank lines folds to one "(N blank lines)" row, and a long run of spaces
 *    to "<N spaces>", so padding can't scroll the start of the text out of view;
 *  - a text still taller than {@link APPROVAL_TEXT_MAX_ROWS} rows is printed whole and
 *    then followed by a line repeating its length and first line, next to the choices.
 *
 * Returns the lines, each indented by two spaces.
 */
export function renderApprovalText(text: string, paint: Painter, width = 80): string[] {
  const spaced = (l: string): string => l.replace(APPROVAL_SPACE_RUN, (run) => paint(`<${run.length} spaces>`, 'dim'))
  const lines = visibleText(text).split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop() // a final newline ends the last line
  const cols = Math.max(20, width)
  if (lines.length <= 1) {
    // One line can wrap past the limit too (a long run of filler after a short,
    // dangerous start), so it gets the same reminder of how it starts.
    const line = spaced(lines[0] ?? '')
    const only = `  ${line}`
    const rows = Math.max(1, Math.ceil(visibleWidth(only) / cols))
    if (rows <= APPROVAL_TEXT_MAX_ROWS) return [only]
    return [
      only,
      paint(`  ↑ one line of ${[...(lines[0] ?? '')].length} characters, shown above. It starts: `, 'dim') +
        truncateVisible(line, Math.max(20, cols - 40))
    ]
  }
  const digits = String(lines.length).length
  const gutter = (n: string): string => paint(`${n.padStart(digits)} │`, 'dim')
  const out: string[] = []
  let blankFrom = -1
  const flushBlank = (end: number): void => {
    if (blankFrom < 0) return
    const n = end - blankFrom
    out.push(
      n === 1
        ? `  ${gutter(String(blankFrom + 1))}`
        : `  ${paint(`${' '.repeat(digits)} ┆ (${n} blank lines, ${blankFrom + 1}-${end})`, 'dim')}`
    )
    blankFrom = -1
  }
  lines.forEach((l, i) => {
    if (!l.trim()) {
      if (blankFrom < 0) blankFrom = i
      return
    }
    flushBlank(i)
    out.push(`  ${gutter(String(i + 1))} ${spaced(l)}`)
  })
  flushBlank(lines.length)
  const rows = out.reduce((n, l) => n + Math.max(1, Math.ceil(visibleWidth(l) / cols)), 0)
  if (rows > APPROVAL_TEXT_MAX_ROWS) {
    const first = spaced(lines.find((l) => l.trim()) ?? '')
    out.push(
      paint(`  ↑ ${lines.length} lines in all, shown above. Line 1: `, 'dim') + truncateVisible(first, Math.max(20, cols - 40))
    )
  }
  return out
}

/** How many lines a text spans, for the approval header ("3 lines"); null for one line. */
function lineCount(text: string): string | null {
  const n = text.replace(/\n$/, '').split('\n').length
  return n > 1 ? `${n} lines` : null
}

/**
 * The typed-answer keys for an approval, for when it is answered by typing: under
 * the prompt without a picker, or once the picker hands over to typing.
 */
export function renderApprovalKeys(ev: Extract<AgentEvent, { type: 'tool_approval' }>, paint: Painter): string {
  if (ev.egressHost) {
    return paint(`  [y] allow ${terminalText(ev.egressHost, { lines: false })} for this chat   [n] keep blocked`, 'dim')
  }
  if (ev.shellNetwork) return paint('  [y] allow network for this chat   [n] keep offline', 'dim')
  // A command that can throw away work asks every time, so there is no chat-wide grant
  // to offer for it.
  const chat = ev.discardsWork ? '' : '   [a] allow for this chat'
  return (
    paint(
      `  [y] allow once${chat}   [c] allow with a note   [!] always allow (saves a rule)   [n] deny   [x] always deny`,
      'dim'
    ) + paint('\n  …or type why not, and that goes back to the agent', 'dim')
  )
}

/**
 * The approval prompt shown for a `tool_approval` event. The kind + an unconfined
 * shell warning matter for consent, so they're surfaced prominently.
 *
 * What is being approved is shown whole, never cut to fit: for a shell command the
 * command itself (from the call's arguments, so exactly what will run), for a memory
 * its description and body, and otherwise the call's summary. All of it goes through
 * {@link renderApprovalText}, so a carriage return, an escape, a bidi override or a
 * page of blank lines in the model's text shows up instead of disguising it.
 */
export function renderApprovalPrompt(
  ev: Extract<AgentEvent, { type: 'tool_approval' }>,
  paint: Painter,
  /**
   * The arrow-key picker lists the choices itself; the typed-answer keys would repeat
   * them. `position` is where this prompt sits among those waiting at once ("2 of 5").
   */
  opts: { picker?: boolean; width?: number; position?: ApprovalPosition } = {}
): string {
  const text = (t: string): string => renderApprovalText(t, paint, opts.width).join('\n')
  // The full-auto shell-network question comes after a command already failed offline.
  // It decides the chat's shell network, not the command, so frame it as a network grant
  // and "deny" as "keep offline", not "block".
  // The egress question likewise comes after the proxy refused a host the allowlist
  // doesn't name; it decides that one host for the chat.
  if (ev.egressHost) {
    const host = terminalText(ev.egressHost, { lines: false })
    const head = paint(`A command tried to reach ${host}, which isn't on the sandbox's allowed domains.`, 'bold')
    const note = paint(
      '  It was blocked. Allowing it applies to shell commands in the rest of this chat, for this host only.',
      'dim'
    )
    const keys = opts.picker ? '' : `\n${renderApprovalKeys(ev, paint)}`
    return `\n${head}\n${text(ev.summary)}\n${note}${keys}`
  }
  if (ev.shellNetwork) {
    const head = paint('This command could not reach the network.', 'bold')
    const note = paint(
      '  Shell commands in this chat run offline until you allow it. Allowing applies to the rest of this chat, not just this command.',
      'dim'
    )
    const keys = opts.picker ? '' : `\n${renderApprovalKeys(ev, paint)}`
    return `\n${head}\n${text(ev.summary)}\n${note}${keys}`
  }
  // Every warning that applies, one per line: an unsandboxed command that also changes a
  // credential file must say both.
  const WARNING_TEXT: Record<ApprovalWarning, string> = {
    unsandboxed: '⚠ runs UNSANDBOXED (no OS confinement on this host)',
    sensitiveRead: '⚠ reads a credential/secret file (prompting even in full-auto)',
    protectedWrite:
      '⚠ changes a project control file that can run code outside the sandbox (asks every time; "Allow for this chat" does not cover it)',
    sensitiveWrite: '⚠ changes a credential/secret file or git hook/config (prompting even in full-auto)'
  }
  const warn = approvalWarnings(ev)
    .map((w) => `\n${paint(WARNING_TEXT[w], 'yellow', 'bold')}`)
    .join('')
  // Until the chat has a shell-network grant, every answer runs the command offline;
  // say so before the user picks, and that network is a separate question.
  const offline = ev.shellOffline
    ? `\n${paint('  Runs without network. If it needs the network, Houston asks before allowing it.', 'dim')}`
    : ''
  // A command that can throw away work or leaves the workspace asks in every mode; say so,
  // so a prompt in full auto doesn't read as a bug.
  const reasons = approvalAskReasons(ev)
    .map((r) => `\n${paint(`  ${r}`, 'dim')}`)
    .join('')
  // A network grant reaches one destination; say which before the user picks it.
  const scope = ev.networkScope
    ? `\n${paint(`  "Allow for this chat" covers ${terminalText(ev.networkScope, { lines: false })} only, for the rest of this chat.`, 'dim')}`
    : ''
  // A command is shown from its arguments (the summary adds a "(background)" note to
  // it); a memory shows its summary line, then what would be saved.
  const parts = approvalSubject(ev.name, ev.args)
  const command = ev.name === 'run_shell' && parts.length ? parts[0] : null
  const subject = command
    ? text(command.text)
    : [text(ev.summary), ...parts.map((p) => `${paint(`  ${p.label}:`, 'dim')}\n${text(p.text)}`)].join('\n')
  const extent = command ? lineCount(command.text) : null
  const background = command && command.label !== 'Command' ? paint('  (runs in the background)', 'dim') : ''
  // Named as the call's tool line names it ("Run", "Write"), not by its wire name.
  const head = paint(`Approve ${terminalText(describeToolCall(ev.name, ev.args).verb, { lines: false })}`, 'bold')
  const kind = paint(`[${ev.kind}]${extent ? ` · ${extent}` : ''}`, 'dim')
  const count = opts.position ? ` ${paint(approvalPositionText(opts.position), 'cyan')}` : ''
  // A command that can throw away work asks every time (the reasons above say so), so
  // there is no chat-wide grant to offer, and running it takes a typed "yes", not one key.
  const discards = ev.discardsWork
    ? `\n${paint('  "Allow for this chat" does not cover it. Allowing it asks you to type yes to confirm.', 'dim')}`
    : ''
  const keys = opts.picker ? '' : `\n${renderApprovalKeys(ev, paint)}`
  return `\n${head} ${kind}${count}${background}\n${subject}${warn}${reasons}${discards}${offline}${scope}${keys}`
}

/** Where a prompt sits among the approvals waiting at once, oldest first. */
export interface ApprovalPosition {
  index: number
  total: number
}

/** "2 of 5": shown only when more than one approval is waiting. */
export function approvalPositionText(p: ApprovalPosition): string {
  return `${p.index} of ${p.total}`
}

/**
 * Numbers the approvals a run raises while others still wait (parallel subagents can
 * ask at once), so each prompt can say "2 of 5". A prompt counts from the moment its
 * event arrives; the batch starts over once none is left waiting.
 */
export class ApprovalCounter {
  private waiting = new Set<string>()
  private answered = 0
  arrived(callId: string): void {
    this.waiting.add(callId)
  }
  /** This prompt's place, or null when it is the only one in the batch. */
  position(): ApprovalPosition | null {
    const total = this.answered + this.waiting.size
    return total > 1 ? { index: this.answered + 1, total } : null
  }
  done(callId: string): void {
    if (!this.waiting.delete(callId)) return
    this.answered++
    if (this.waiting.size === 0) this.answered = 0
  }
}

/** "Allow once or for this chat?" after a note, typed: y once, a for the chat, anything else denies. */
export function parseNoteScope(answer: string | null | undefined): ToolApprovalDecision {
  const a = (answer ?? '').trim().toLowerCase()
  if (a === 'y' || a === 'yes' || a === 'once' || a === '1') return 'allow'
  if (a === 'a' || a === 'chat' || a === '2') return 'always'
  return 'deny'
}

/** The typed word that confirms running a command that can throw away work. */
export const DISCARD_CONFIRM_WORD = 'yes'

/** Whether the typed confirmation for a work-discarding command says to run it. */
export function confirmsDiscard(answer: string | null | undefined): boolean {
  return (answer ?? '').trim().toLowerCase() === DISCARD_CONFIRM_WORD
}

/**
 * The line recording how an approval was answered, as the desktop's card shows its
 * outcome once decided. Without it the scrollback kept only the menu, and Esc
 * (which denies) left no sign of what happened.
 */
export function approvalOutcome(
  decision: ToolApprovalDecision,
  opts: { shellNetwork?: boolean; egressHost?: string; note?: string } = {}
): string {
  if (opts.egressHost) {
    return decision === 'deny' || decision === 'rule-deny'
      ? `Kept ${opts.egressHost} blocked`
      : `Allowed ${opts.egressHost} for this chat`
  }
  if (opts.shellNetwork) {
    // Any allow answers the chat's question, so every one grants network for the rest of it.
    if (decision === 'deny') return 'Running offline'
    return 'Network allowed for this chat'
  }
  const withNote = (base: string): string => (opts.note ? `${base}, with a note: ${opts.note}` : base)
  switch (decision) {
    case 'allow':
      return withNote('Allowed')
    case 'always':
      return withNote('Allowed for this chat')
    case 'rule-allow':
      return 'Always allowed (rule saved)'
    case 'rule-deny':
      return 'Always denied (rule saved)'
    case 'deny':
      return opts.note ? `Denied: ${opts.note}` : 'Denied'
  }
}

/**
 * Map a freeform approval answer to a decision, plus any guidance the user typed.
 *
 * Anything unrecognized is a DENY (the safe default), but it is not discarded: a
 * typed sentence is the user explaining what to do instead, so it rides back to
 * the model as the reason. Previously that explanation was silently dropped and
 * the model saw a bare refusal, which is the worst of both — the user thinks they
 * gave direction, and the agent retries a variant of the same thing.
 */
export function parseApprovalAnswer(answer: string): { decision: ToolApprovalDecision; note?: string; askNote?: true } {
  const raw = answer.trim()
  const a = raw.toLowerCase()
  if (a === 'y' || a === 'yes' || a === 'allow') return { decision: 'allow' }
  // Allow, then ask for the note that goes to the agent with the result.
  if (a === 'c' || a === 'comment' || a === 'note') return { decision: 'allow', askNote: true }
  if (a === 'a' || a === 'always' || a === 'allow-run') return { decision: 'always' }
  if (a === '!' || a === 'always-allow') return { decision: 'rule-allow' }
  if (a === 'x' || a === 'always-deny') return { decision: 'rule-deny' }
  if (a === 'n' || a === 'no' || a === 'deny' || a === '') return { decision: 'deny' }
  // Free text: a denial WITH a reason, which is the whole point.
  return { decision: 'deny', note: raw }
}

/**
 * The decisions offered in the approval picker. `rule-allow` / `rule-deny` persist
 * a permission rule; the core has always supported them, but the terminal used to
 * type them away and offer only allow/deny/always. `key` answers it in one press, the
 * same keys {@link parseApprovalAnswer} reads from a typed answer; a reason has no key
 * because typing one is how it starts.
 */
export const APPROVAL_OPTIONS: {
  label: string
  value: ToolApprovalDecision | 'deny-note' | 'allow-note'
  description: string
  key?: string
}[] = [
  { label: 'Allow once', value: 'allow', description: 'run this call only', key: 'y' },
  {
    label: 'Allow for this chat',
    value: 'always',
    description: 'stop asking for this kind of tool in this chat (a network call: this destination), until Houston quits',
    key: 'a'
  },
  { label: 'Allow with a note…', value: 'allow-note', description: 'run it, and tell the agent something with the result', key: 'c' },
  { label: 'Always allow', value: 'rule-allow', description: 'save a permission rule, kept across restarts', key: '!' },
  { label: 'Deny', value: 'deny', description: 'refuse this once', key: 'n' },
  { label: 'Deny with a reason…', value: 'deny-note', description: 'tell the agent what to do instead' },
  { label: 'Always deny', value: 'rule-deny', description: 'save a permission rule, kept across restarts', key: 'x' }
]

/**
 * The picker's choices for one prompt. A command that can throw away work asks every
 * time, so "Allow for this chat" would grant nothing for it: it isn't offered.
 */
export function approvalOptionsFor(ev: { discardsWork?: boolean }): typeof APPROVAL_OPTIONS {
  return ev.discardsWork ? APPROVAL_OPTIONS.filter((o) => o.value !== 'always') : APPROVAL_OPTIONS
}

/**
 * Render the per-file diff preview the main process computed against the files'
 * real pre-write contents (see `previewWrite`) as unified-diff text.
 *
 * Preferred over {@link extractDiff}, which can only work from the call's arguments
 * and therefore cannot know what a file already held: it shows a `write_file` over
 * an existing file as an all-new file, and has nothing to show for a `multi_edit`.
 * Returns null when there is no preview to render, so the caller can fall back.
 */
export function renderPreviewDiff(preview: FileDiffPreview[]): string | null {
  if (preview.length === 0) return null
  return preview
    .map((f) => {
      const tag = f.created ? ' (new file)' : f.deleted ? ' (deleted)' : ''
      const from = f.renamedFrom ?? f.path
      const body = f.diff
        .map((l) =>
          // A `skip` marks unchanged lines folded away; it is a note, not a line of
          // the file, so it must not render with a diff sign.
          l.type === 'skip' ? `⋯ ${l.text}` : `${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}${l.text}`
        )
        .join('\n')
      const more = f.truncated ? '\n… diff shortened; the change continues past this point' : ''
      return `--- ${from}\n+++ ${f.path}${tag}\n${body}${more}`
    })
    .join('\n')
}

/**
 * Reconstruct a reviewable diff from a write tool's arguments (captured at
 * `tool_start`), so an edit can be seen before it's approved. Handles the shapes
 * of the built-in write tools: `apply_patch` (a ready patch envelope), `edit_file`
 * (old→new strings), and `write_file` (whole-file content). Returns null when no
 * diff can be derived.
 *
 * This is the FALLBACK for events that carry no preview (an older log, or a write
 * whose effect couldn't be modelled). Prefer {@link renderPreviewDiff}.
 */
export function extractDiff(args: Record<string, unknown>): string | null {
  const path = typeof args.path === 'string' ? args.path : undefined
  if (typeof args.patch === 'string' && args.patch.trim()) return args.patch
  if (typeof args.old_string === 'string' && typeof args.new_string === 'string') {
    const header = path ? `--- ${path}\n+++ ${path}\n` : ''
    const minus = args.old_string.split('\n').map((l) => `-${l}`).join('\n')
    const plus = args.new_string.split('\n').map((l) => `+${l}`).join('\n')
    return `${header}${minus}\n${plus}`
  }
  if (typeof args.content === 'string') {
    const header = path ? `+++ ${path} (new file)\n` : ''
    // The final "\n" ends the last line; it is not a blank line of its own.
    return header + args.content.replace(/\n$/, '').split('\n').map((l) => `+${l}`).join('\n')
  }
  return null
}

/** Colorize a unified diff, capped at `maxLines` so a huge edit doesn't flood the terminal. */
export function colorizeDiff(diff: string, paint: Painter, maxLines = 40): string {
  // Built from the model's arguments: no control character in it may paint over the
  // change being approved.
  const lines = terminalText(diff).split('\n')
  const shown = lines.slice(0, maxLines).map((l) => {
    // Header markers must be checked before +/- since `+++`/`---` also start with them.
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('@@')) return paint(l, 'cyan')
    if (l.startsWith('+')) return paint(l, 'green')
    if (l.startsWith('-')) return paint(l, 'red')
    return paint(l, 'dim')
  })
  if (lines.length > maxLines) shown.push(paint(`… ${lines.length - maxLines} more lines`, 'dim'))
  return shown.map((l) => `  ${l}`).join('\n')
}

/** One-line result summary: a failure marker, or a dimmed snippet of the output's first content line. */
/** How many lines of a failure are shown by default — enough to see the cause. */
export const FAILURE_LINES = 10
/** How many lines of a subagent's report show before collapsing (all under /verbose). */
const REPORT_LINES = 24

/** How many diff lines screen-reader mode reads out before saying how many more there are. */
const SCREEN_READER_DIFF_LINES = 200

/** How many lines of a successful result `/verbose` shows before collapsing. */
export const VERBOSE_LINES = 40

/**
 * The transcript line(s) for a finished tool call.
 *
 * A success collapses to one dim line: the transcript is a conversation, not a
 * log, and forty lines of `ls` output buries it. But a FAILURE used to collapse
 * to `✗ run_shell failed` and throw the error away entirely — the one case where
 * the output is the whole point, and the user was left to guess (or ask the agent
 * what it just saw). Failures now show their first lines.
 *
 * `verbose` opens successes up too, and `/output` recovers any result in full
 * from the persisted log afterwards.
 */
/**
 * A show_images result in the terminal: the gallery's title, then each image as a
 * clickable link to its file (the tool already confirmed every file is an image
 * inside the project). Labels and paths come from the model, so control characters
 * are stripped before they go inside the link. Null when the args don't parse.
 */
export function renderImageLinks(args: Record<string, unknown> | undefined, cwd: string, paint: Painter): string | null {
  const gallery = parseGalleryArgsSafe(args)
  if (!gallery) return null
  const link = (path: string): string => {
    const shown = stripControlChars(path)
    const url = pathToFileURL(isAbsolute(shown) ? shown : resolvePath(cwd, shown)).href
    return osc8Link(url, paint(shown, 'cyan'))
  }
  const n = gallery.images.length
  const title = gallery.title ? `${stripControlChars(gallery.title)}: ` : ''
  const lines = [paint(`  ▦ ${title}${n} image${n === 1 ? '' : 's'} (click a path to open it)`, 'dim')]
  for (const img of gallery.images) {
    const compare = img.compareWith ? paint(' compared with ', 'dim') + link(img.compareWith) : ''
    lines.push(`    ${stripControlChars(img.label)}  ${link(img.path)}${compare}`)
  }
  return lines.join('\n')
}

export function renderToolResult(
  name: string,
  ok: boolean,
  output: string,
  paint: Painter,
  opts: { verbose?: boolean; width?: number } = {}
): string {
  // A subagent's report is the agent's answer: render it like one, without the note
  // the loop appends for the model, capped so a long one doesn't flood the screen.
  if (ok && isSubagentTool(name)) {
    const { report } = splitSubagentReport(output)
    if (!report.trim()) return ''
    const width = Math.max(20, (opts.width ?? 80) - 4)
    // Agent-written text: drop control characters (line by line, so newlines stay)
    // before it reaches the terminal.
    const clean = report.trim().split('\n').map(stripControlChars).join('\n')
    const body = renderMarkdownAnsi(clean, { paint, width }).split('\n')
    const max = opts.verbose ? body.length : REPORT_LINES
    const shown = body.slice(0, max).map((l) => `    ${l}`)
    if (body.length > max) shown.push(paint(`    … ${body.length - max} more lines (/output to see it all)`, 'dim'))
    return shown.join('\n')
  }
  // A prompt the run was stopped in front of, and a plan review's decision, come back
  // in the model's wording ("Denied by the user. They said: …", "The user REJECTED
  // this plan. Do not make any changes…"). Say what happened instead.
  const stopped = stoppedPromptText(output)
  if (stopped) return paint(`  ⊘ ${stopped}`, 'dim')
  // A call the user denied: the prompt already printed "↳ Denied" (with their reason)
  // for it, so a "✗ Run failed" line over the model-facing text would only repeat it.
  if (!ok && deniedPromptText(output) !== null) return ''
  if (ok && name === PRESENT_PLAN_TOOL) return paint(`  ↳ ${PLAN_OUTCOME_LABEL[planOutcome(output)]}`, 'dim')
  // A command's output (or a fetched page, or an MCP result) can carry escapes that
  // move the cursor or write the clipboard; show its text without them working.
  const lines = terminalText(output).split('\n')
  if (!ok) {
    // "✗ Run failed", matching the row above it, not the wire name.
    const failed = paint(`  ✗ ${describeToolCall(name, undefined).verb} failed`, 'red')
    const body = trimBlank(lines)
    if (!body.length) return failed
    const shown = body.slice(0, FAILURE_LINES).map((l) => paint(`    ${truncate(l, 200)}`, 'dim'))
    const more =
      body.length > FAILURE_LINES
        ? [paint(`    … ${body.length - FAILURE_LINES} more lines (/output to see it all)`, 'dim')]
        : []
    return [failed, ...shown, ...more].join('\n')
  }
  if (opts.verbose) {
    const body = trimBlank(lines)
    if (!body.length) return ''
    const shown = body.slice(0, VERBOSE_LINES).map((l) => paint(`    ${truncate(l, 200)}`, 'dim'))
    const more =
      body.length > VERBOSE_LINES
        ? [paint(`    … ${body.length - VERBOSE_LINES} more lines (/output to see it all)`, 'dim')]
        : []
    return [...shown, ...more].join('\n')
  }
  const firstLine = lines.find((l) => l.trim()) ?? ''
  const snippet = truncate(firstLine.trim(), 80)
  return snippet ? paint(`  ↳ ${snippet}`, 'dim') : ''
}

/** Drop leading/trailing blank lines, so a padded result doesn't render as gaps. */
function trimBlank(lines: string[]): string[] {
  let a = 0
  let b = lines.length
  while (a < b && !lines[a].trim()) a++
  while (b > a && !lines[b - 1].trim()) b--
  return lines.slice(a, b)
}

/**
 * The tool results this session recorded, oldest first, read back out of the
 * message log the run loop persists. Nothing new is stored: the full output was
 * always there, it just had no way out to the terminal.
 */
export function toolResultsFrom(messages: ChatMessage[]): { name: string; output: string }[] {
  return messages
    .filter((m) => m.role === 'tool')
    .map((m) => ({ name: m.toolName ?? 'tool', output: m.content }))
}

/** Cap on what `/output` prints, so recovering a huge result can't flood the terminal. */
export const OUTPUT_LINES = 500

/**
 * Render one recovered tool result. `index` is 1-based from the most recent, so
 * `/output` (1) is "what just happened" — the overwhelmingly common ask.
 */
export function renderRecoveredOutput(
  results: { name: string; output: string }[],
  index: number,
  paint: Painter
): string {
  if (!results.length) return paint('· no tool output in this conversation yet', 'dim')
  if (index < 1 || index > results.length) {
    return paint(`· no tool call #${index} (this conversation has ${results.length})`, 'yellow')
  }
  const picked = results[results.length - index]
  const lines = terminalText(picked.output).split('\n')
  const shown = lines.slice(0, OUTPUT_LINES)
  const head = paint(`▣ ${picked.name}`, 'bold') + paint(`  (${index} back, ${lines.length} lines)`, 'dim')
  const more =
    lines.length > OUTPUT_LINES ? [paint(`… ${lines.length - OUTPUT_LINES} more lines not shown`, 'dim')] : []
  return [head, ...shown, ...more].join('\n')
}

/** Running token/cost totals for the session. */
export interface SessionCost {
  inputTokens: number
  outputTokens: number
  cost: number
  /** Part of the spend came from a model with no known price (see formatCost). */
  costUnknown?: boolean
}

/**
 * Per-model tally for `/cost`. This is the shared {@link ModelUsage} — the exact
 * shape (and accumulator) the desktop app's cost breakdown uses — so the terminal's
 * `/cost` and the GUI can't drift on what a session cost. `addModelUsage` is the
 * shared `accumulateModelUsage`; only the terminal-specific rendering lives here.
 */
export type ModelCost = ModelUsage
export const addModelUsage = accumulateModelUsage

/**
 * The `/cost` report: one row per model, the cache split, and a session total.
 * With one model and no caching this collapses to roughly what it printed before,
 * so the extra detail only appears when there IS extra detail.
 */
export function renderCostReport(tallies: ModelCost[], paint: Painter): string {
  if (!tallies.length) return paint('· nothing spent yet this session', 'dim')
  const n = (v: number): string => v.toLocaleString('en-US')
  const total = tallies.reduce(
    (a, t) => ({
      inputTokens: a.inputTokens + t.inputTokens,
      outputTokens: a.outputTokens + t.outputTokens,
      cost: a.cost + t.cost
    }),
    { inputTokens: 0, outputTokens: 0, cost: 0 }
  )
  const width = Math.max(...tallies.map((t) => t.model.length))
  const lines = [paint('Session cost:', 'bold')]
  for (const t of tallies) {
    // Cached input is the interesting part of a long session's bill: it is counted
    // in inputTokens but priced far below the base rate.
    const cached = t.cacheReadTokens
      ? paint(`  (${n(t.cacheReadTokens)} cached)`, 'green')
      : ''
    const written = t.cacheWriteTokens ? paint(`  (${n(t.cacheWriteTokens)} cache write)`, 'dim') : ''
    lines.push(
      `  ${paint(t.model.padEnd(width), 'cyan')}  ${n(t.inputTokens)}+${n(t.outputTokens)} tok${cached}${written}  ${formatCost(t.cost, t.costUnknown)}`
    )
  }
  if (tallies.length > 1) {
    lines.push(paint(`  ${'total'.padEnd(width)}  ${n(total.inputTokens)}+${n(total.outputTokens)} tok  ${formatCost(total.cost, tallies.some((t) => t.costUnknown))}`, 'dim'))
  }
  return lines.join('\n')
}

/** Format a cost total, e.g. "1,234+567 tok · $0.012" (amounts as the desktop shows them). */
export function formatSessionCost(c: SessionCost): string {
  const n = (v: number): string => v.toLocaleString('en-US')
  return `${n(c.inputTokens)}+${n(c.outputTokens)} tok · ${formatCost(c.cost, c.costUnknown)}`
}

/** Status marker for a subagent row, printed as a discrete line in line mode. */
export function subagentGlyph(status: 'running' | 'done' | 'error'): string {
  return status === 'done' ? '✓' : status === 'error' ? '✗' : '·'
}

/** Braille spinner frames (Dots animation). */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * One spinner frame, e.g. `⠋ Thinking 4s`. The terminal adapter prefixes a
 * carriage-return + clear-line and redraws only this single line, so it never
 * scrolls or tears — the one and only in-place redraw in the TUI, kept minimal on
 * purpose to preserve the otherwise append-only (flicker-free) model.
 */
export function spinnerFrame(
  tick: number,
  label: string,
  elapsedSec: number,
  paint: Painter,
  /**
   * What the user is typing while the agent works, how many messages they have
   * queued, and which approval mode is in force. The spinner line doubles as the
   * mid-run composer and the mid-run status bar: it is the one line already being
   * redrawn, so all of this costs no extra screen space and cannot tear the
   * transcript.
   */
  opts: { draft?: string; queued?: number; mode?: string; status?: string; glyph?: string; tokens?: number } = {}
): string {
  const i = ((tick % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length
  // The turn's output so far (the shared run meter's estimate), as the desktop's
  // status bar shows it beside the clock.
  const tokens = opts.tokens && opts.tokens > 0 ? ` · ${formatTokens(opts.tokens)} ${opts.tokens === 1 ? 'token' : 'tokens'}` : ''
  // A fixed glyph (reduced motion) replaces the animation frames entirely.
  const head = `${paint(opts.glyph ?? SPINNER_FRAMES[i], 'cyan')} ${label} ${paint(`${formatElapsed(elapsedSec * 1000)}${tokens}`, 'dim')}`
  // The approval mode, kept visible WHILE the turn runs: the composer's status line
  // is gone exactly when "how much is running without asking?" matters most.
  const mode = opts.mode ? paint(`  [${opts.mode}]`, 'dim') : ''
  // The rest of the composer's status line (model, branch, context), already painted.
  const status = opts.status ? `  ${opts.status}` : ''
  const queued = opts.queued ? paint(`  (${opts.queued} queued)`, 'cyan') : ''
  // The draft is shown verbatim so people can see what they typed; it is their own
  // keystrokes, and the decoder never lets a control character into it.
  const draft = opts.draft ? `  ${paint('›', 'green')} ${opts.draft}` : ''
  return `${head}${mode}${status}${queued}${draft}`
}

/** How many files an edit summary names before it collapses the rest to a count. */
const EDIT_SUMMARY_FILES = 3

/**
 * One line for a write that landed without an approval prompt (auto-edit, full auto,
 * or a saved rule), so the edit is not invisible: each file with its added and
 * removed line counts, and the command that shows the diff.
 */
export function renderEditSummary(preview: FileDiffPreview[], paint: Painter): string {
  const files = preview.slice(0, EDIT_SUMMARY_FILES).map((f) => {
    const { added, removed } = diffStat(f.diff)
    const more = f.truncated ? '…' : ''
    const name = terminalText(f.renamedFrom ? `${f.renamedFrom} → ${f.path}` : f.path, { lines: false })
    const tag = f.created ? paint(' (new)', 'dim') : f.deleted ? paint(' (deleted)', 'dim') : ''
    const counts = [
      added || !removed ? paint(`+${added}${more}`, 'green') : '',
      removed ? paint(`-${removed}${more}`, 'red') : ''
    ]
      .filter(Boolean)
      .join(' ')
    return `${name}${tag} ${counts}`
  })
  const rest = preview.length - EDIT_SUMMARY_FILES
  if (rest > 0) files.push(paint(`and ${rest} more file${rest === 1 ? '' : 's'}`, 'dim'))
  return `  ${paint('✎', 'cyan')} ${files.join(paint(', ', 'dim'))}  ${paint('· /diff last shows the diff', 'dim')}`
}

/** How many of this session's edits `/diff last <n>` can reach back to. */
const RECENT_EDITS = 20

export interface StatusState {
  providerId: string
  model: string
  policy: ApprovalPolicy
  cwd: string
  cost: SessionCost
  /** Current context size in tokens (last turn's input tokens); 0 until a turn runs. */
  contextTokens: number
  /** The checked-out git branch, or null outside a repository (or on a detached HEAD). */
  branch?: string | null
  /** The rate-limit quota the provider reported on its latest response, when it sent one. */
  quota?: ProviderQuota
  /** The reasoning effort the next turn asks for. */
  effort?: ReasoningEffort
  /** Whether the model can reason; false hides the effort (it would do nothing). */
  modelReasons?: boolean
}

/** A path under the home folder written from `~` (`~/code/app`); any other path as is. */
export function homeRelative(path: string, home = process.env.HOME ?? process.env.USERPROFILE): string {
  if (!home) return path
  if (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)) return `~${path.slice(home.length)}`
  return path
}

/** Shorten a path for the status line: `~` for home, and only the last two segments. */
export function shortCwd(cwd: string, home = process.env.HOME ?? process.env.USERPROFILE): string {
  const p = homeRelative(cwd, home)
  // A Windows path splits on either separator and keeps its own.
  const sep = !p.includes('/') && p.includes('\\') ? '\\' : '/'
  const segs = p.split(/[\\/]/).filter(Boolean)
  if (segs.length <= 2) return p
  return `${p.startsWith('~') ? `~${sep}` : `…${sep}`}${segs.slice(-2).join(sep)}`
}

/**
 * /statusline: where the custom status line stands (its command, refresh interval and
 * source, or how to set one up), why its last run left the line as it was, and the
 * fields of the JSON its command reads, with this session's values when one is set.
 */
export function renderStatusLineInfo(
  config: ResolvedStatusLine | null,
  failure: { at: number; reason: string } | null,
  payload: string | null,
  available: boolean,
  paint: Painter
): string {
  const lines = [paint('Status line', 'bold')]
  if (!available) {
    lines.push(paint('  a custom status line is unavailable here', 'dim'))
    return lines.join('\n')
  }
  if (config) {
    lines.push(`  command: ${terminalText(config.command, { lines: false })}`)
    lines.push(
      `  refresh: ${config.refreshSeconds ? `every ${config.refreshSeconds}s while the prompt is open, and ` : ''}after each turn and on a mode or model change`
    )
    lines.push(`  from:    ${config.source === 'user' ? 'your settings.json' : "this project's .houston/settings.json (trusted)"}`)
    if (failure) lines.push(paint(`  last run: ${terminalText(failure.reason, { lines: false })}; showing the last good output`, 'yellow'))
  } else {
    lines.push(paint('  built in. Set "statusLine": { "command": "...", "refreshSeconds": 5 } in settings.json to', 'dim'))
    lines.push(paint('  show the first lines your command prints instead (it runs in your shell, 1s limit).', 'dim'))
  }
  lines.push('', paint('  The command reads one JSON object on stdin:', 'dim'))
  const width = Math.max(...STATUS_LINE_FIELDS.map((f) => f.name.length))
  for (const f of STATUS_LINE_FIELDS) lines.push(`    ${paint(f.name.padEnd(width), 'cyan')}  ${paint(f.about, 'dim')}`)
  if (payload) lines.push('', paint('  Now:', 'dim'), ...terminalText(payload).split('\n').map((l) => `    ${l}`))
  return lines.join('\n')
}

/**
 * The note after a finished turn: "done in 1m 6s", plus the clock time it finished
 * ("done in 1m 6s at 3:42 PM") when `finishedAt` is given (the `tuiTurnClock` setting).
 */
export function turnDoneText(elapsedMs: number, finishedAt?: number): string {
  const at = finishedAt !== undefined ? ` at ${new Date(finishedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''
  return `done in ${formatElapsed(elapsedMs)}${at}`
}

/**
 * The quota the status line shows for a provider: the newer of what its replies'
 * headers last said and what a throttled retry last reported (which carries the
 * provider's `Retry-After` as the reset time).
 */
export function footerQuota(
  providerId: string,
  quota: ProviderQuota | undefined = providerQuota(providerId),
  throttle: RateLimitState | undefined = rateLimitSnapshot().find((s) => s.providerId === providerId)
): ProviderQuota | undefined {
  if (!throttle) return quota
  if (quota && Date.parse(quota.at) >= throttle.observedAt) return quota
  return {
    ...(throttle.remainingRequests !== undefined ? { remainingRequests: throttle.remainingRequests } : {}),
    ...(throttle.remainingTokens !== undefined ? { remainingTokens: throttle.remainingTokens } : {}),
    throttled: true,
    ...(throttle.resetAt !== undefined ? { resetAt: new Date(throttle.resetAt).toISOString() } : {}),
    at: new Date(throttle.observedAt).toISOString()
  }
}

/**
 * A one-line status footer shown above the composer: model, approval policy, cwd,
 * session cost, and context-window fill (a green→yellow→red mini bar + percent).
 * Truncated to `width` so it never wraps.
 */
export function renderStatusLine(s: StatusState, width: number, paint: Painter): string {
  const parts = [
    paint(`${s.providerId}/${s.model}`, 'cyan'),
    // How hard the next turn thinks, beside the model it applies to (as /reasoning sets it).
    ...(s.effort && s.modelReasons !== false ? [paint(`reasoning ${s.effort}`, 'dim')] : []),
    paint(s.policy, 'dim'),
    paint(shortCwd(s.cwd), 'dim')
  ]
  if (s.branch) parts.push(paint(s.branch, 'magenta'))
  parts.push(formatCost(s.cost.cost, s.cost.costUnknown))
  const ctx = renderContextUsage(s.contextTokens, s.model, paint)
  if (ctx) parts.push(ctx)
  const quota = quotaStatusText(s.quota)
  if (quota) parts.push(paint(quota, quotaIsLow(s.quota) ? 'yellow' : 'dim'))
  return truncateVisible(parts.join(paint(' · ', 'dim')), Math.max(0, width))
}

/**
 * How full the context window is: a mini bar and percent, or the token count when
 * the model's window is unknown. Empty until a turn has run (nothing to measure).
 */
export function renderContextUsage(contextTokens: number, model: string, paint: Painter): string {
  const pct = contextPercent(contextTokens, contextWindowFor(model))
  if (pct !== null) {
    const tone = pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green'
    return `${paint(contextBar(pct), tone)} ${paint(`${pct}%`, tone)}`
  }
  return contextTokens > 0 ? paint(`${formatTokens(contextTokens)} tok context`, 'dim') : ''
}

/**
 * The part of the status line the spinner carries while a turn runs: model, branch
 * and context. The approval mode is already on that line, and the cost settles at
 * the turn's end.
 */
export function renderRunStatus(s: Pick<StatusState, 'model' | 'branch' | 'contextTokens'>, paint: Painter): string {
  const parts = s.model ? [paint(s.model, 'dim')] : []
  if (s.branch) parts.push(paint(s.branch, 'magenta'))
  const ctx = renderContextUsage(s.contextTokens, s.model, paint)
  if (ctx) parts.push(ctx)
  return parts.join(paint(' · ', 'dim'))
}

/** The status line shown before any provider is set up: no model, just the /login nudge. */
export function renderNoModelStatus(
  policy: ApprovalPolicy,
  cwd: string,
  width: number,
  paint: Painter
): string {
  const line = [
    paint('no model (run /login)', 'yellow'),
    paint(policy, 'dim'),
    paint(shortCwd(cwd), 'dim')
  ].join(paint(' · ', 'dim'))
  // Truncate like renderStatusLine so a long cwd can't wrap the single-line footer.
  return truncateVisible(line, Math.max(0, width))
}

/** A tiny 10-cell context-fill bar like `▓▓▓░░░░░░░`. */
function contextBar(pct: number, cells = 10): string {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * cells)
  return `${'▓'.repeat(filled)}${'░'.repeat(cells - filled)}`
}

// --- Session persistence -----------------------------------------------------
// The TUI persists each session as an ordinary conversation (via the same store
// the GUI uses), so sessions survive restarts, can be resumed with `/resume`, and
// show up in the GUI's sidebar — one history across both clients.

/** A persisted conversation, minimally described for the resume picker. */
export interface ResumeEntry {
  id: string
  title: string
  updatedAt: number
  /** Set when the desktop app has the chat unread: how its last turn ended. */
  unread?: UnreadOutcome
  /** The folder the chat belongs to (shown when the picker lists every folder). */
  workspace?: string
  /** Pinned in the desktop sidebar (marked in the picker, which can unpin it). */
  pinned?: boolean
}

/** Persistence hooks, injected so the driver stays testable without a real store. */
export interface TuiPersist {
  create: (input: {
    workspace: string
    providerId: string
    model: string
    reasoningEffort?: ReasoningEffort
    approvalPolicy?: ApprovalPolicy
  }) => { id: string }
  setMessages: (id: string, messages: ChatMessage[]) => void
  /**
   * Rewrite the backing conversation's own settings (model, reasoning effort,
   * approval policy). `create` records them once, but the session's settings drift when the
   * user switches with `/model`, `/reasoning` or `/approval`, leaving the stored
   * values stale: that mis-attributes the usage scorecard and makes a GUI re-open
   * or a later `/resume` come back on the wrong settings. The GUI keeps this in step
   * via `updateConversationMeta` on every send; this is the terminal's counterpart.
   */
  setSettings: (id: string, patch: ConversationSettingsPatch) => void
  list: (workspace: string) => ResumeEntry[]
  /**
   * The chat's messages, plus its own settings when it has them (restored on resume),
   * its title and the folder it belongs to.
   */
  get: (id: string) => ({ messages: ChatMessage[]; title?: string; workspace?: string } & ConversationSettingsPatch) | null
  /** Recent sessions in this folder whose title/content matches `query`. */
  search: (workspace: string, query: string) => ResumeEntry[]
  /**
   * Recent sessions in every folder, each with its `workspace`. Both absent: the
   * resume picker has no "all folders" scope.
   */
  listAll?: () => ResumeEntry[]
  /** Recent sessions in every folder whose title/content matches `query`. */
  searchAll?: (query: string) => ResumeEntry[]
  /** Duplicate a conversation (fresh id, copied history); null if it can't be forked. */
  fork: (id: string) => { id: string } | null
  /**
   * Fork from one message (the desktop's "Fork from here"): a new chat holding the
   * conversation up to that point. Absent ⇒ `/fork <n>` is unavailable.
   */
  forkAt?: (id: string, point: ForkPoint) => { id: string } | null
  /** A chat's saved title, read from the chat itself (any folder, any age). */
  title?: (id: string) => string | undefined
  /** Archive a chat (the desktop sidebar's Archive). Absent ⇒ the picker has no archive key. */
  archive?: (id: string) => void
  /** Pin or unpin a chat (the desktop sidebar's Pin). Absent ⇒ the picker has no pin key. */
  pin?: (id: string, pinned: boolean) => void
  /**
   * Record that a chat now works in another folder (`/cd`), so it is listed, resumed
   * and continued there. Absent: the chat keeps the folder it started in.
   */
  setWorkspace?: (id: string, workspace: string) => void
  /** Give a conversation a title of the user's choosing. Absent ⇒ /rename is unavailable. */
  rename?: (id: string, title: string) => void
  /**
   * Delete a conversation for good, stopping its live run, background shells and
   * queued input. With a `choice` (from `planDelete`), also tears down its worktree
   * when asked. Absent ⇒ /delete is unavailable.
   */
  remove?: (
    id: string,
    choice?: { plan: DeletePlan; removeWorktree: boolean }
  ) => void | Promise<DeleteConversationResult | void>
  /**
   * What deleting the chat would do to its worktree, so /delete can offer the desktop's
   * keep/remove choice. Absent ⇒ every chat is deleted as a plain one (worktree kept).
   */
  planDelete?: (id: string) => Promise<DeletePlan>
}

/**
 * A chat the agent spawned to run alongside this one (`spawn_session`), usually
 * on its own git branch and worktree.
 */
export interface BackgroundSession {
  id: string
  title: string
  running: boolean
  startedAt: number
  /** The branch it is working on, when it was given its own worktree. */
  branch?: string
  /** How its last run ended, once it is no longer running (absent: finished). */
  outcome?: RunOutcome['outcome']
  /** Which limit, when `outcome` is `limit`. */
  limit?: RunLimitReason
}

/**
 * Render the background sessions this session started.
 *
 * The agent could always fan work out from the terminal, but the only sign of it
 * was one line when a session FINISHED — so parallel work was invisible while it
 * mattered, and there was no way to see what branch it was on or to open it.
 */
export function renderBackgroundSessions(
  sessions: BackgroundSession[],
  now: number,
  paint: Painter
): string {
  if (!sessions.length) {
    return paint('No background sessions started from this chat yet.', 'dim')
  }
  // Running first: they're the ones you might want to watch or wait for.
  const ordered = [...sessions].sort((a, b) => Number(b.running) - Number(a.running) || b.startedAt - a.startedAt)
  const lines = [paint('Background sessions:', 'bold')]
  ordered.forEach((s, i) => {
    const state = s.running
      ? paint('● running', 'cyan')
      : !s.outcome || s.outcome === 'done'
        ? paint('✓ finished', 'green')
        : paint(
            `${s.outcome === 'error' ? '✗' : '■'} ${runOutcomePhrase({ outcome: s.outcome, limit: s.limit })}`,
            s.outcome === 'error' ? 'red' : 'yellow'
          )
    const branch = s.branch ? paint(`  ${terminalText(s.branch, { lines: false })}`, 'magenta') : ''
    const when = paint(formatRelativeTime(s.startedAt, now), 'dim')
    lines.push(`  ${paint(String(i + 1), 'cyan')}. ${state}  ${terminalText(s.title, { lines: false })}${branch}  ${when}`)
  })
  lines.push(paint('  Enter a number to open one, or anything else to cancel', 'dim'))
  return lines.join('\n')
}

/** Map a `/sessions` selection to a conversation id, or null to cancel. */
export function parseSessionSelection(answer: string, sessions: BackgroundSession[]): string | null {
  const ordered = [...sessions].sort((a, b) => Number(b.running) - Number(a.running) || b.startedAt - a.startedAt)
  const n = Number(answer.trim())
  if (Number.isInteger(n) && n >= 1 && n <= ordered.length) return ordered[n - 1].id
  return null
}

/** A propose_session card as the terminal lists it (`/proposals`). */
export interface TuiProposal {
  callId: string
  title: string
  prompt: string
  /** The user's decision, or undefined while it is still open. */
  status?: ProposalState['status']
}

/** `/proposals`: the sessions the agent proposed in this chat, numbered. Pure. */
export function renderProposals(list: TuiProposal[], paint: Painter): string {
  if (!list.length) return paint('No sessions proposed in this chat yet.', 'dim')
  const lines = [paint('Proposed sessions:', 'bold')]
  list.forEach((p, i) => {
    const state =
      p.status === 'started'
        ? paint('started', 'green')
        : p.status === 'here'
          ? paint('asked here', 'dim')
          : p.status === 'dismissed'
            ? paint('dismissed', 'dim')
            : paint('open', 'cyan')
    lines.push(`  ${paint(String(i + 1), 'cyan')}. ${terminalText(p.title, { lines: false })}  ${state}`)
  })
  lines.push(
    paint('  /proposals start <n> runs one as its own session · here <n> asks for it in this chat · dismiss <n>', 'dim')
  )
  return lines.join('\n')
}

/** What the last turn changed on disk, and whether it has been undone already. */
export interface CheckpointInfo {
  runId: string
  files: number
  reverted: boolean
}

/**
 * `/undo`: put the files the last turn touched back the way they were.
 *
 * Houston has snapshotted every write since forever (agent/checkpoints.ts) and the
 * desktop app can roll a turn back with a click. From the terminal there was no way
 * to reach it — so under auto-edit or full-auto, where edits land without a prompt,
 * "that was wrong, put it back" meant reverting by hand or asking the agent to undo
 * its own work. The snapshots were right there the whole time.
 */
export function renderUndoResult(files: number, paint: Painter): string {
  return files
    ? paint(`· undid the last turn's changes (${files} file${files === 1 ? '' : 's'}); /redo puts them back`, 'dim')
    : paint('· nothing to undo: the last turn changed no files', 'dim')
}

/** Describe what `/undo` would act on, before doing it. */
export function renderCheckpoint(cp: CheckpointInfo | null, paint: Painter): string {
  if (!cp) return paint('· no changes from this chat to undo yet', 'dim')
  return cp.reverted
    ? paint(`· the last turn's ${plural(cp.files, 'file change')} ${cp.files === 1 ? 'is' : 'are'} already undone (/redo puts ${cp.files === 1 ? 'it' : 'them'} back)`, 'dim')
    : paint(`· /undo would revert ${plural(cp.files, 'file')} changed by the last turn`, 'dim')
}

/**
 * `/rewind`: the user's earlier messages, numbered from 1 oldest first (the number
 * `/rewind <n>` takes), showing at most the last `max`.
 */
export function renderRewindPoints(points: RewindPoint[], paint: Painter, max = 20): string {
  if (points.length === 0) return paint('· nothing to rewind to yet: send a message first', 'dim')
  const shown = points.slice(-max)
  const lines = [paint('Rewind to just before which message?', 'bold')]
  if (shown.length < points.length) lines.push(paint(`  (${points.length - shown.length} older not shown)`, 'dim'))
  for (const p of shown) lines.push(`  ${paint(String(p.turn + 1).padStart(3), 'cyan')}  ${terminalText(p.label, { lines: false })}`)
  lines.push(paint('  enter a number, or nothing to cancel', 'dim'))
  return lines.join('\n')
}

/** A 1-based message number from `/rewind`'s list, or null when it isn't one. */
export function parseRewindSelection(answer: string, count: number): number | null {
  const n = Number(answer.trim())
  return answer.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= count ? n - 1 : null
}

/**
 * What else `/rewind` can do from a message, after the shared modes (the terminal
 * offers these in the same list, numbered on from them).
 */
export type RewindExtra = 'summarize-from' | 'summarize-before' | 'fork'

export const REWIND_EXTRA_INFO: readonly { action: RewindExtra; label: string; hint: string }[] = [
  {
    action: 'summarize-from',
    label: 'Summarize from here',
    hint: 'Replace this message and everything after it with a summary. Files stay as they are.'
  },
  {
    action: 'summarize-before',
    label: 'Summarize up to here',
    hint: 'Replace everything before this message with a summary. Files stay as they are.'
  },
  {
    action: 'fork',
    label: 'Fork from here',
    hint: 'Open a new chat with the conversation before this message. This chat stays as it is.'
  }
]

/** A `/rewind` choice past the modes (its number in the list, or a name), or null. */
export function parseRewindExtra(answer: string): RewindExtra | null {
  const a = answer.trim().toLowerCase()
  const n = Number(a)
  if (a !== '' && Number.isInteger(n)) return REWIND_EXTRA_INFO[n - REWIND_MODE_INFO.length - 1]?.action ?? null
  if (a === 'summarize-from' || a === 'summarize' || a === 'from') return 'summarize-from'
  if (a === 'summarize-before' || a === 'before' || a === 'upto') return 'summarize-before'
  if (a === 'fork') return 'fork'
  return null
}

/** The `/rewind` choices list: the shared modes, then the terminal's extra actions. */
export function renderRewindChoices(paint: Painter): string {
  const rows = [
    ...REWIND_MODE_INFO.map((c) => ({ label: c.label, hint: c.hint })),
    ...REWIND_EXTRA_INFO.map((c) => ({ label: c.label, hint: c.hint }))
  ]
  return `${paint('Rewind what?', 'bold')}\n${rows.map((c, i) => `  ${paint(String(i + 1), 'cyan')}  ${c.label}  ${paint(c.hint, 'dim')}`).join('\n')}`
}

/** A mode from `/rewind`'s mode prompt (a number or a name), or null to cancel. */
export function parseRewindMode(answer: string): RewindMode | null {
  const a = answer.trim().toLowerCase()
  if (a === '') return 'both' // the default, as the prompt says
  const n = Number(a)
  if (Number.isInteger(n) && n >= 1 && n <= REWIND_MODE_INFO.length) return REWIND_MODE_INFO[n - 1].mode
  if (a === 'both' || a === 'conversation' || a === 'code') return a
  if (a === 'chat') return 'conversation'
  return null
}

/**
 * `/changes`: everything different in the working tree, as one summary.
 *
 * Answers the question you actually have after a long autonomous run ("what did
 * it do to my repo?"), which was otherwise a shell-out. The other scopes, one
 * file's diff, and revert live in `./tui-changes`.
 */
export function renderWorkingTree(
  changes: { isRepo: boolean; branch: string | null; files: { path: string; status: string; added: number; removed: number }[]; added: number; removed: number },
  paint: Painter
): string {
  return renderChangeSummary('tree', changes, paint)
}

/**
 * The line that tells a reopened chat how its latest run ended when it didn't
 * finish: the error it failed on, a Stop, or the limit it hit (worded as the live
 * notice was). Null when the latest run finished. The GUI shows the same record as a
 * notice under the message.
 */
export function runEndNotice(messages: ChatMessage[]): string | null {
  const latest = latestRunEnd(messages)
  if (!latest) return null
  if (latest.reason === 'limit') return `· ${runEndNoticeText(latest)}`
  const noReply = messages.at(-1)?.role === 'user'
  if (latest.reason === 'error') {
    const why = stripControlChars(runEndNoticeText(latest))
    return noReply ? `· the last message got no reply: ${why}` : `· the last run failed: ${why}`
  }
  return noReply ? '· the last message got no reply: it was stopped' : '· the last run was stopped before it finished'
}

/** The desktop sidebar's state for a chat: failed in red, unread in blue, else nothing. */
function unreadMark(c: ResumeEntry, paint: Painter): string {
  return c.unread === 'error' ? `  ${paint('failed', 'red')}` : c.unread ? `  ${paint('● unread', 'blue')}` : ''
}

/** A chat's folder for the all-folders picker: home-relative, the last two segments. */
export function sessionFolder(workspace: string | undefined, home = process.env.HOME): string {
  if (!workspace) return ''
  return shortCwd(stripControlChars(workspace).replace(/\\/g, '/'), home)
}

// An escape sequence cut off at the end of a chunk: a bare ESC, a CSI still missing
// its final byte, or an OSC (a hyperlink, a title) still missing its terminator.
// eslint-disable-next-line no-control-regex
const SHELL_CARRY = /(?:\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*\x1b?)?|\r)$/
// Held back at most this long: past it, the tail is not a sequence worth waiting for.
const SHELL_CARRY_MAX = 512

/**
 * Split a `!command` output chunk into what can be shown now and a tail that may
 * continue in the next chunk (see SHELL_CARRY), so output filtered chunk by chunk
 * renders as it would have in one piece. Pure.
 */
export function splitShellCarry(s: string): [string, string] {
  const m = SHELL_CARRY.exec(s)
  if (!m || m[0].length > SHELL_CARRY_MAX) return [s, '']
  return [s.slice(0, m.index), m[0]]
}

/**
 * Events that belong to another agent (a subagent, a reviewer) or carry no place in
 * the transcript (a rolled-up usage, whose `inputTokens` is 0): they can arrive in the
 * middle of the main agent's reply or thought, and must not end it. Pure.
 */
export function isSideEvent(e: AgentEvent): boolean {
  switch (e.type) {
    case 'subagent_start':
    case 'subagent_step':
    case 'subagent_end':
    case 'subagent':
    case 'review_finding':
      return true
    case 'usage':
      return e.inputTokens === 0
    default:
      return false
  }
}

/**
 * Why a chat of another folder is not opened here, and the command that opens it in
 * its own folder. Pure.
 */
export function otherFolderNote(workspace: string, id: string): string {
  return `· that chat belongs to another folder (${stripControlChars(workspace)}); open it there with: ${stripControlChars(
    comeBackCommand(workspace, id)
  )}`
}

/**
 * One row of the arrow-key `/resume` picker: the label (number and title, which the
 * live filter matches) and the painted detail after it (when, unread state, folder,
 * and a mark on the chat you're in). Pure.
 */
export function renderSessionRow(
  c: ResumeEntry,
  index: number,
  opts: { now: number; paint: Painter; showFolder?: boolean; current?: boolean; home?: string }
): { label: string; detail: string } {
  const { paint } = opts
  const num = index < 9 ? `${index + 1}.` : '  '
  const title = stripControlChars(c.title) || 'New chat'
  const folder = opts.showFolder ? sessionFolder(c.workspace, opts.home) : ''
  const detail = [
    `  ${paint(formatRelativeTime(c.updatedAt, opts.now), 'dim')}`,
    unreadMark(c, paint),
    c.pinned ? `  ${paint('pinned', 'yellow')}` : '',
    opts.current ? `  ${paint('(this chat)', 'green')}` : '',
    folder ? `  ${paint(folder, 'magenta')}` : ''
  ].join('')
  return { label: `${num} ${title}`, detail }
}

/** The arrow-key `/resume` picker's footer: every key it takes. */
export function sessionPickerHint(o: {
  rename: boolean
  remove: boolean
  scope: boolean
  all: boolean
  pin?: boolean
  archive?: boolean
}): string {
  const keys = ['↑/↓ move', 'enter open', '1-9 open row', 'type to filter']
  if (o.rename) keys.push('ctrl-r rename')
  if (o.pin) keys.push('ctrl-p pin')
  if (o.archive) keys.push('ctrl-e archive')
  if (o.remove) keys.push('ctrl-d delete')
  if (o.scope) keys.push(o.all ? 'ctrl-a this folder' : 'ctrl-a all folders')
  return [...keys, 'esc cancel'].join(' · ')
}

/** Render a numbered picker of recent conversations for `/resume`. */
export function renderConversationList(convs: ResumeEntry[], now: number, paint: Painter): string {
  if (!convs.length) return paint('No saved sessions in this folder yet.', 'dim')
  const lines = [paint('Recent sessions:', 'bold')]
  convs.forEach((c, i) => {
    const when = paint(formatRelativeTime(c.updatedAt, now), 'dim')
    // The same states the desktop sidebar shows: failed in red, unread in blue.
    lines.push(`  ${paint(String(i + 1), 'cyan')}. ${terminalText(c.title, { lines: false })}  ${when}${unreadMark(c, paint)}`)
  })
  lines.push(paint('  Enter a number to resume, or anything else to cancel', 'dim'))
  return lines.join('\n')
}

/**
 * What `/resume` can and can't do in screen-reader mode, said once under the list:
 * it opens a session by number and searches by `/resume <words>`, while the arrow-key
 * picker's in-place rename, delete and all-folders view are left out. Pure.
 */
export function screenReaderResumeNote(persist: Pick<TuiPersist, 'rename' | 'remove'>, canScope: boolean): string {
  const missing = [
    persist.rename ? 'renaming' : '',
    persist.remove ? 'deleting' : '',
    canScope ? 'sessions in other folders' : ''
  ].filter(Boolean)
  const search = 'To search, type /resume followed by words.'
  if (!missing.length) return search
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}`
  return `${search} The arrow-key picker also offers ${list}; turn off /screen-reader to use it.`
}

/** Map a resume selection (1-based index) to a conversation id, or null to cancel. */
export function parseResumeSelection(answer: string, convs: ResumeEntry[]): string | null {
  const n = Number(answer.trim())
  if (Number.isInteger(n) && n >= 1 && n <= convs.length) return convs[n - 1].id
  return null
}

// --- Capability introspection ------------------------------------------------
// Read-only views of what the agent can reach in this workspace — skills, custom
// agents, MCP servers, hooks — so a terminal user can see the capability surface
// before granting approvals, without opening the GUI.

export interface CapabilityItem {
  name: string
  detail?: string
}

export interface CapabilitySnapshot {
  skills: CapabilityItem[]
  agents: CapabilityItem[]
  mcp: CapabilityItem[]
  hooks: CapabilityItem[]
}

/** Render a labelled capability list, or a dim "none" note when empty. */
export function renderCapabilityList(label: string, items: CapabilityItem[], paint: Painter): string {
  if (!items.length) return paint(`No ${label.toLowerCase()} active in this folder.`, 'dim')
  const lines = [paint(`${label}:`, 'bold')]
  for (const it of items) {
    const detail = it.detail ? paint(` (${truncate(it.detail, 70)})`, 'dim') : ''
    lines.push(`  ${paint(it.name, 'cyan')}${detail}`)
  }
  return lines.join('\n')
}

/** Compact relative time like "just now", "3m ago", "2h ago", "5d ago". */
export function formatRelativeTime(then: number, now: number): string {
  const s = Math.max(0, Math.floor((now - then) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** The question line of an `ask_user` prompt. */
export function renderQuestionHeader(question: string, paint: Painter): string {
  return `\n${paint('? ', 'magenta')}${paint(terminalText(question), 'bold')}`
}

/** The numbered options + typing hint for answering an `ask_user` question by hand. */
export function renderQuestionChoices(options: QuestionOption[], multiSelect: boolean, paint: Painter): string {
  const lines = options.map((o, i) => {
    const desc = o.description ? paint(`  (${terminalText(o.description, { lines: false })})`, 'dim') : ''
    return `  ${paint(String(i + 1), 'cyan')}. ${terminalText(o.label, { lines: false })}${desc}`
  })
  const hint = multiSelect
    ? 'Enter numbers (comma-separated) or type an answer'
    : 'Enter a number or type an answer'
  lines.push(paint(`  ${hint}`, 'dim'))
  return lines.join('\n')
}

/** The prompt shown for an `ask_user` question: the question plus numbered options. */
export function renderQuestion(
  question: string,
  options: QuestionOption[],
  multiSelect: boolean,
  paint: Painter
): string {
  return `${renderQuestionHeader(question, paint)}\n${renderQuestionChoices(options, multiSelect, paint)}`
}

/**
 * Resolve a freeform answer against the offered options: a number (or
 * comma-separated numbers when multiSelect) maps to option labels; anything else
 * is passed through verbatim so the user can always type a custom reply.
 */
export function resolveQuestionAnswer(
  answer: string,
  options: QuestionOption[],
  multiSelect: boolean
): string {
  const trimmed = answer.trim()
  if (!trimmed) return trimmed
  const parts = multiSelect ? trimmed.split(',').map((p) => p.trim()) : [trimmed]
  const picked: string[] = []
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      const opt = options[Number(part) - 1]
      if (opt) {
        picked.push(opt.label)
        continue
      }
    }
    // Any non-index token means the user typed a custom answer — honor it as-is.
    return trimmed
  }
  return picked.length ? picked.join(', ') : trimmed
}

// --- Plan review (present_plan) -----------------------------------------------
// The terminal counterpart to the GUI's docked plan-review panel: render the plan
// the agent presented, collect the same PlanDecision (accept / suggest / reject,
// with an "edit in your editor" variant of accept), and hand it back so the
// blocking present_plan tool call unblocks. Without this the TUI would drop the
// plan_ready event and the run would hang on the pending decision.

/** A decision action offered on a presented plan. */
export type PlanAction = 'accept' | 'accept-ask' | 'edit' | 'edit-ask' | 'suggest' | 'reject'

/** The plan-review actions, in display order, with their single-key shortcuts. */
export const PLAN_ACTIONS: { key: string; action: PlanAction; label: string; description: string }[] = [
  { key: 'a', action: 'accept', label: 'Accept & run', description: 'apply edits automatically' },
  { key: 'k', action: 'accept-ask', label: 'Accept, ask per edit', description: 'approve each change' },
  { key: 'e', action: 'edit', label: 'Edit the plan, then run', description: 'open it in your editor' },
  { key: 'd', action: 'edit-ask', label: 'Edit the plan, ask per edit', description: 'open it in your editor; approve each change' },
  { key: 's', action: 'suggest', label: 'Suggest changes', description: 'send a note; keep planning' },
  { key: 'r', action: 'reject', label: 'Reject', description: 'discard; keep planning' }
]

/** The plan-review actions with their typed shortcut keys. */
export function renderPlanActions(paint: Painter): string {
  return PLAN_ACTIONS.map(
    (a) => `  ${paint(`[${a.key}]`, 'cyan')} ${a.label}  ${paint(`(${a.description})`, 'dim')}`
  ).join('\n')
}

/**
 * Render a presented plan (title, body, affected files), plus the typed decision
 * menu unless `actions` is false (the arrow-key picker lists the actions instead).
 * The body is markdown, rendered the way assistant text is.
 */
export function renderPlan(
  plan: PlanPayload,
  paint: Painter,
  opts: { actions?: boolean; width?: number; highlight?: (lang: string, code: string) => string } = {}
): string {
  // Every part of the plan is the model's text (the body's control characters are
  // handled by the markdown renderer).
  const lines = [`\n${paint('▣ Plan:', 'magenta')} ${paint(terminalText(plan.title, { lines: false }), 'bold')}`]
  const body = plan.body?.trim()
  if (body) {
    lines.push('', renderMarkdownAnsi(body, { paint, width: opts.width ?? 0, highlight: opts.highlight }))
  } else {
    if (plan.overview) lines.push('', terminalText(plan.overview))
    for (const step of plan.steps ?? []) lines.push(`  • ${terminalText(step, { lines: false })}`)
  }
  if (plan.files?.length) lines.push('', paint(`Files: ${plan.files.map((f) => terminalText(f, { lines: false })).join(', ')}`, 'dim'))
  const verify = planVerifySteps(plan)
  if (verify.length) lines.push('', paint(`Checks: ${verify.map(stripControlChars).join('; ')}`, 'dim'))
  // Houston's own answer to whether those checks can run here, worked out from the
  // machine (not the agent's text), so it reads in the warning color when they can't.
  if (plan.readiness?.items.length) {
    const [head, ...rows] = formatReadinessLines(plan.readiness)
    // Each row ("  ! npm packages: Not installed yet. …") continues under its text,
    // rather than the terminal breaking a long one mid-word at the left edge.
    const fit = (r: string): string =>
      opts.width && opts.width > 24 ? `  ${wrapAnsi(r.trimStart(), opts.width - 4).replace(/\n/g, '\n    ')}` : r
    lines.push('', paint(head, readinessOk(plan.readiness) ? 'dim' : 'yellow'), ...rows.map((r) => paint(fit(r), 'dim')))
  }
  if (opts.actions !== false) lines.push('', renderPlanActions(paint))
  return lines.join('\n')
}

/** Map a typed answer to a plan action; defaults to reject (the safe verdict). */
export function parsePlanAction(answer: string): PlanAction {
  const a = answer.trim().toLowerCase()
  const match = PLAN_ACTIONS.find((x) => x.key === a || x.action === a)
  if (match) return match.action
  if (a === 'y' || a === 'yes') return 'accept'
  return 'reject'
}

/** The legacy structured plan as markdown, for the editor when there's no `body`. */
function planToMarkdown(plan: PlanPayload): string {
  if (plan.body) return plan.body
  const parts = [`# ${plan.title}`]
  if (plan.overview) parts.push(plan.overview)
  if (plan.steps?.length) parts.push(plan.steps.map((s) => `- ${s}`).join('\n'))
  return parts.join('\n\n')
}

/**
 * Turn a chosen action into a PlanDecision, collecting an editor edit / note as needed.
 * Null means nothing was decided (no editor, an edit that didn't happen, an emptied
 * plan, an empty note): the caller asks for an action again rather than guessing one.
 */
export async function planDecisionFor(
  action: PlanAction,
  plan: PlanPayload,
  deps: TuiDeps,
  paint: Painter
): Promise<PlanDecision | null> {
  const accept = (mode: PlanAcceptMode): PlanDecision => ({ kind: 'accept', mode })
  switch (action) {
    case 'accept':
      return accept('auto-edit')
    case 'accept-ask':
      return accept('ask')
    case 'edit':
    case 'edit-ask': {
      const mode: PlanAcceptMode = action === 'edit' ? 'auto-edit' : 'ask'
      // Only a real edit accepts. An editor that quit with an error (Vim's :cq), or none
      // at all, used to accept the plan as presented, which is what the user chose
      // "edit" to avoid; an emptied plan did too.
      if (!deps.editText) {
        deps.io.out(paint('· no editor available (set $VISUAL or $EDITOR); choose again\n', 'yellow'))
        return null
      }
      const edited = await deps.editText(planToMarkdown(plan))
      if (edited && edited.trim()) return { kind: 'accept', mode, editedBody: edited }
      deps.io.out(
        paint(
          edited === null
            ? '· edit cancelled (the editor quit without saving, or $VISUAL / $EDITOR is not set); choose again\n'
            : '· the edited plan is empty, so nothing was accepted; choose again\n',
          'yellow'
        )
      )
      return null
    }
    case 'suggest': {
      const read = await deps.io.readLine('Suggest changes: ', { discardPending: true })
      // A cancelled read (Ctrl-C, which also stops the run, or end of input) ends the
      // prompt, as it does at the action prompt: asking again would be for a run that
      // is already over.
      if (read === null) return { kind: 'reject' }
      const note = read
      if (note.trim()) return { kind: 'suggest', note: note.trim() }
      // An empty note decides nothing: ask again rather than rejecting the plan.
      deps.io.out(paint('· no note given; pick an action\n', 'dim'))
      return null
    }
    case 'reject':
      return { kind: 'reject' }
  }
}

/** "1 message", "3 messages": a count with its noun, no "(s)". */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function truncate(s: string, max: number): string {
  // Count/slice by code point so a cut never lands inside a surrogate pair (which
  // would emit a broken half-character). `.length`/`.slice` work in code units.
  const cps = [...s]
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : s
}

/** Media type for an image path by extension, or null if not a supported image. */
export function mediaTypeForImagePath(path: string): string | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    default:
      return null
  }
}

// --- Slash commands ----------------------------------------------------------

export type SlashResult =
  | { kind: 'handled' }
  | { kind: 'exit' }
  | { kind: 'clear' }
  | { kind: 'resume'; query: string }
  /** Fork the chat: whole (/fork), or as it was before message `turn` (/fork <n>). */
  | { kind: 'fork'; turn?: number; bad?: true }
  /** Hand this chat to the desktop app (/open-in-app). */
  | { kind: 'open-in-app' }
  /** Write this chat to a file or the clipboard (/export [md|json|html] [path] [--copy] ...). */
  | ({ kind: 'export' } & ExportArgs)
  /** Open a chat exported as JSON or HTML as a new chat here (/import <file>). */
  | { kind: 'import'; path: string }
  /** Give this chat a title (/rename <title>); empty shows the current one. */
  | { kind: 'rename'; title: string }
  /** Delete this chat, after a confirmation (/delete). */
  | { kind: 'delete' }
  /**
   * List every permission rule that applies and this session's denials, remove or add
   * a rule of yours, or allow the n-th recent denial
   * (/permissions [remove n | allow n | add …]).
   */
  | { kind: 'permissions'; op: PermissionsOp }
  | { kind: 'capability'; which: 'skills' | 'agents' }
  | { kind: 'set-theme'; theme: ThemeName }
  | { kind: 'image'; path: string }
  | { kind: 'clear-images' }
  /** Attach the image on the clipboard (/image with no path, /paste). */
  | { kind: 'paste-image' }
  /** `asDefault` (`--default`): also make it what new chats start with. */
  | { kind: 'set-approval'; policy: ApprovalPolicy; asDefault?: boolean }
  /** Choose a model from the ready ones (/model with no model named). */
  | { kind: 'pick-model'; asDefault?: boolean }
  /** Fetch a provider's model list again (/model refresh [provider]). */
  | { kind: 'model-refresh'; provider?: string }
  /** Run the last message again after its turn failed (/retry), as the desktop's Retry does. */
  | { kind: 'retry' }
  | { kind: 'set-model'; providerId: string; model: string; asDefault?: boolean }
  /** Summarize older turns now (/compact [focus]), steering the summary toward `focus`. */
  | { kind: 'compact'; focus?: string }
  /**
   * The settings hub (/settings), what covers one desktop page (/settings <page>), or
   * get, set, export, import, or reset one (/settings set <key> <value>, ...).
   */
  | { kind: 'settings'; cmd: SettingsCommand }
  /** Read or change the terminal's settings (/config, /config key=value). */
  | { kind: 'config'; op: ConfigOp }
  /** What this session runs on, on one screen (/status). */
  | { kind: 'status' }
  /** Report an issue, after showing exactly what the report holds (/feedback, /bug). */
  | { kind: 'feedback' }
  /** Environment diagnostics (/doctor). */
  | { kind: 'doctor' }
  /** Show or set how hard the model thinks before answering (/reasoning). */
  | { kind: 'reasoning'; effort?: ReasoningEffort; asDefault?: boolean }
  /** Turn vim keys in the composer on or off (/vim). */
  | { kind: 'vim'; on?: boolean }
  /** `/add-dir <path>` adds a session directory; a bare `/add-dir` lists them. */
  | { kind: 'add-dir'; path: string }
  /** `/cd <path>` moves the session's working folder; a bare `/cd` says where it is. */
  | { kind: 'cd'; path: string }
  /** Turn reduced motion on or off (/reduce-motion); bare toggles. */
  | { kind: 'reduce-motion'; on?: boolean }
  /** Turn screen-reader mode on or off (/screen-reader); bare toggles. */
  | { kind: 'screen-reader'; on?: boolean }
  /** Show or set which attention signals fire (/notify [auto|osc|bell|off]). */
  | { kind: 'notify'; mode?: NotifyMode; invalid?: string }
  | { kind: 'keybindings' }
  /** Revert (or restore) the files the last turn changed (/undo, /redo). */
  | { kind: 'undo'; redo: boolean }
  /**
   * Rewind to an earlier message (/rewind [n] [mode]), or undo the last rewind
   * (/rewind undo). Without `turn` the driver lists the messages and asks.
   */
  | { kind: 'rewind'; undo: boolean; turn?: number; mode?: RewindMode; action?: RewindExtra }
  /**
   * A scope's changed files, one file's diff, or a revert (/changes, see
   * `./tui-changes`), or with `last`, the diff of an edit this session made
   * (`/diff last [n]`, n edits back).
   */
  | { kind: 'changes'; last?: number; op?: ChangesOp }
  /** Show more (or less) of each tool's output as it runs (/verbose). */
  | { kind: 'verbose'; on?: boolean }
  /** Only your messages, one line per tool call, and each turn's final reply (/focus). */
  | { kind: 'focus'; on?: boolean }
  /** How the model's reasoning shows as it streams (/thoughts); bare steps to the next. */
  | { kind: 'thoughts'; mode?: ReasoningDisplay; bad?: string }
  /** Open the transcript viewer (/transcript, Ctrl-O). */
  | { kind: 'transcript' }
  /** Reprint the agent's current todo list (/todos). */
  | { kind: 'todos' }
  /** Reprint a past tool result in full (/output [n]). */
  | { kind: 'output'; index: number }
  /** Copy the n-th latest reply, or one of its code blocks, to the clipboard (/copy [n]). */
  | { kind: 'copy'; index: number; bad?: boolean }
  /** Spend and tokens per day and per project, from the saved chats (/usage). */
  | { kind: 'usage' }
  /** Show the custom status line's setup and the JSON its command reads (/statusline). */
  | { kind: 'statusline' }
  /** How each model has behaved across the saved chats (/scorecard). */
  | { kind: 'scorecard' }
  /** List or edit the fallback models (/model fallback [add|remove|up|down]). */
  | { kind: 'model-fallback'; op: FallbackOp }
  /** List (and open) the background sessions the agent spawned (/spawned). */
  | { kind: 'spawned' }
  /** This chat's background shells and subagents: list, show one, or stop one (/tasks). */
  | { kind: 'tasks'; op: TasksOp }
  /** List or act on the sessions the agent proposed (/proposals [start|here|dismiss n]). */
  | { kind: 'proposals'; op: 'list' | 'start' | 'here' | 'dismiss'; index?: number }
  /** The follow-ups waiting for the running turn: list, drop or send one, clear (/queue). */
  | { kind: 'queue'; op: QueueOp }
  /** Ask a quick side question about this chat without adding it to the chat (/btw). */
  | { kind: 'btw'; question: string }
  /** Edit lifecycle hooks (/hooks [add|remove <n>]). */
  | { kind: 'hooks'; action: SettingsAction }
  /** List or edit MCP servers (/mcp [add|remove|enable|disable|reconnect|tools|login|logout …]). */
  | { kind: 'mcp'; action: SettingsAction }
  /** Show or change this folder's project-config trust (/trust, /trust forget). */
  | { kind: 'trust'; op: 'status' | 'forget' | 'list' | 'usage'; index?: number }
  /** Review saved memories (/memory [show|edit|pin|unpin|forget <n>|undo|on|off|folder]). */
  | { kind: 'memory'; action: MemoryAction }
  /** List, pause, resume, run now, delete, or create scheduled runs (/schedule). */
  | { kind: 'schedule'; op: ScheduleOp }
  /** Set or replace a provider API key, or add a host (/login, /providers). */
  | { kind: 'login' }
  /** Edit or remove a provider, or forget its key (/login edit|remove|forget-key <provider>). */
  | { kind: 'login-op'; op: Exclude<LoginOp, { op: 'menu' }> }
  /**
   * A template command (custom `.houston/commands` or first-party `/review`) or
   * `/agent`: run the prompt as a turn, recorded as the command the user typed.
   */
  | ({
      kind: 'prompt'
      /**
       * A custom command whose frontmatter changes how its turn runs (model, effort,
       * agent, allowed-tools): the driver prepares it in full before sending.
       */
      command?: { cmd: Command; args: string }
    } & InvokedTurn)
  /** Commit, push, ship, or show the branch's pull request (/commit, /push, /ship, /pr). */
  | { kind: 'git'; op: GitOp }
  /** Run a prompt on a schedule in this folder (/loop [interval] <prompt>). */
  | { kind: 'loop'; arg: string }
  /** A connected MCP server's prompt (`/mcp__<server>__<prompt> [args]`): fetched, then run as a turn. */
  | { kind: 'mcp-prompt'; command: Command; args: string }
  | { kind: 'unknown'; name: string }
  | { kind: 'not-a-command' }

/**
 * The dim line the terminal prints when a slash command runs as a turn: what runs,
 * never the prompt behind it (that's what the model reads, not the user).
 */
export function invocationEcho(inv: PromptInvocation): string {
  // The label and detail can come from a repository's own files (a command's or a
  // skill's description), so they never reach the terminal with escape sequences.
  const label = stripControlChars(inv.label)
  return inv.detail ? `· ${label}: ${stripControlChars(inv.detail)}` : `· running ${label}`
}

/**
 * Interpret a line as a slash command. Pure: returns the *intent*; the driver
 * applies side effects (printing, state changes) so this stays testable. Only
 * lines that start with '/' are commands; everything else is prompt text.
 */
export function parseSlashCommand(
  line: string,
  settings: AppSettings,
  commands: Command[] = []
): SlashResult {
  if (!line.startsWith('/')) return { kind: 'not-a-command' }
  const [typed, ...rest] = line.slice(1).trim().split(/\s+/)
  const arg = rest.join(' ')
  // Command names are case-insensitive, as in the desktop app: `/NEW` is `/new`.
  const name = typed.toLowerCase()
  // A project's own /commit (or /push, /ship, /pr) keeps running as it did: these
  // built-ins arrived after such commands were common, so they yield to them.
  // A commit message is free text: its line breaks (subject, blank line, body) are
  // kept, where every other argument is rebuilt from its words.
  const gitArg = name === 'commit' ? line.slice(1).trim().replace(/^\S+/, '').trim() : arg
  const git = YIELDS_TO_CUSTOM.has(name) && !resolveCommand(commands, name) ? parseGitCommand(name, gitArg) : null
  if (git) return { kind: 'git', op: git }
  switch (name) {
    case 'exit':
    case 'quit':
    case 'q':
      return { kind: 'exit' }
    case 'clear':
    case 'new':
      return { kind: 'clear' }
    case 'resume':
    case 'sessions':
      return { kind: 'resume', query: arg }
    case 'spawned':
      return { kind: 'spawned' }
    case 'tasks':
    case 'bashes':
      return { kind: 'tasks', op: parseTasksArgs(arg) }
    case 'queue':
      return { kind: 'queue', op: parseQueueArgs(arg) }
    case 'proposals':
    case 'proposed': {
      const [op, n] = arg.trim().split(/\s+/)
      if (op === 'start' || op === 'here' || op === 'dismiss') {
        const index = Number(n)
        return Number.isInteger(index) && index >= 1
          ? { kind: 'proposals', op, index }
          : { kind: 'proposals', op: 'list' }
      }
      return { kind: 'proposals', op: 'list' }
    }
    case 'btw':
    case 'aside':
      return { kind: 'btw', question: arg.trim() }
    case 'loop':
      return { kind: 'loop', arg }
    case 'fork':
      return { kind: 'fork', ...parseForkArg(arg) }
    case 'open-in-app':
      return { kind: 'open-in-app' }
    case 'export':
      return { kind: 'export', ...parseExportArgs(arg) }
    case 'import':
      return { kind: 'import', path: arg.trim() }
    case 'rename':
      return { kind: 'rename', title: arg.trim() }
    case 'delete':
      return { kind: 'delete' }
    case 'permissions':
      return { kind: 'permissions', op: parsePermissionsArgs(arg) }
    case 'skills':
    case 'agents':
      return { kind: 'capability', which: name }
    case 'agent': {
      const turn = agentTurn(arg, line)
      // No (or a nonsense) name → fall through to listing, which is what someone
      // typing `/agent` alone is looking for anyway.
      if (!turn) return { kind: 'capability', which: 'agents' }
      return { kind: 'prompt', ...turn }
    }
    case 'settings':
      return { kind: 'settings', cmd: parseSettingsCommand(arg) }
    case 'config':
      return { kind: 'config', op: parseConfigArgs(arg, { settings, themes: themeNames(), resolveTheme }) }
    case 'status':
      return { kind: 'status' }
    case 'feedback':
    case 'bug':
      return { kind: 'feedback' }
    case 'doctor':
      return { kind: 'doctor' }
    case 'reasoning':
    case 'think': {
      const { rest, asDefault } = splitDefaultFlag(arg)
      const a = rest.toLowerCase()
      if (isReasoningEffort(a)) return { kind: 'reasoning', effort: a, ...(asDefault ? { asDefault } : {}) }
      return { kind: 'reasoning' } // no/invalid arg → the driver reports the current one
    }
    case 'add-dir':
      return { kind: 'add-dir', path: arg.trim() }
    case 'cd':
      return { kind: 'cd', path: arg.trim() }
    case 'vim': {
      const a = arg.trim().toLowerCase()
      if (a === 'on') return { kind: 'vim', on: true }
      if (a === 'off') return { kind: 'vim', on: false }
      return { kind: 'vim' } // bare /vim toggles
    }
    case 'keybindings':
      return { kind: 'keybindings' }
    case 'notify': {
      const a = arg.trim().toLowerCase()
      if (!a) return { kind: 'notify' }
      return isNotifyMode(a) ? { kind: 'notify', mode: a } : { kind: 'notify', invalid: arg.trim() }
    }
    case 'screen-reader': {
      const a = arg.trim().toLowerCase()
      if (a === 'on') return { kind: 'screen-reader', on: true }
      if (a === 'off') return { kind: 'screen-reader', on: false }
      return { kind: 'screen-reader' }
    }
    case 'reduce-motion': {
      const a = arg.trim().toLowerCase()
      if (a === 'on') return { kind: 'reduce-motion', on: true }
      if (a === 'off') return { kind: 'reduce-motion', on: false }
      return { kind: 'reduce-motion' }
    }
    case 'rewind': {
      const [first, second] = arg.trim().split(/\s+/)
      if (first?.toLowerCase() === 'undo') return { kind: 'rewind', undo: true }
      const n = Number(first)
      const turn = first && Number.isInteger(n) && n >= 1 ? n - 1 : undefined
      const mode = second ? (parseRewindMode(second) ?? undefined) : undefined
      const action = second && !mode ? (parseRewindExtra(second) ?? undefined) : undefined
      return {
        kind: 'rewind',
        undo: false,
        ...(turn !== undefined ? { turn } : {}),
        ...(mode ? { mode } : {}),
        ...(action ? { action } : {})
      }
    }
    case 'undo':
      return { kind: 'undo', redo: false }
    case 'redo':
      return { kind: 'undo', redo: true }
    case 'changes':
    case 'diff': {
      const m = /^last(?:\s+(\d+))?$/i.exec(arg.trim())
      if (!m) return { kind: 'changes', op: parseChangesArgs(arg) }
      return { kind: 'changes', last: Math.max(1, Number(m[2] ?? m[1] ?? 1) || 1) }
    }
    case 'verbose': {
      const a = arg.trim().toLowerCase()
      if (a === 'on') return { kind: 'verbose', on: true }
      if (a === 'off') return { kind: 'verbose', on: false }
      return { kind: 'verbose' } // bare /verbose toggles
    }
    case 'focus': {
      const a = arg.trim().toLowerCase()
      if (a === 'on') return { kind: 'focus', on: true }
      if (a === 'off') return { kind: 'focus', on: false }
      return { kind: 'focus' } // bare /focus toggles
    }
    case 'thoughts': {
      const a = arg.trim().toLowerCase()
      if (!a) return { kind: 'thoughts' }
      return isReasoningDisplay(a) ? { kind: 'thoughts', mode: a } : { kind: 'thoughts', bad: a }
    }
    case 'transcript':
      return { kind: 'transcript' }
    case 'todos':
      return { kind: 'todos' }
    case 'output': {
      // `/output` means "what just happened"; a number counts back from there.
      const n = Number.parseInt(arg.trim(), 10)
      return { kind: 'output', index: Number.isInteger(n) && n >= 1 ? n : 1 }
    }
    case 'usage':
      return { kind: 'usage' }
    case 'statusline':
      return { kind: 'statusline' }
    case 'scorecard':
      return { kind: 'scorecard' }
    case 'copy': {
      // `/copy` is the last reply; a number counts back from there.
      const a = arg.trim()
      if (!a) return { kind: 'copy', index: 1 }
      const n = Number(a)
      return Number.isInteger(n) && n >= 1 ? { kind: 'copy', index: n } : { kind: 'copy', index: 1, bad: true }
    }
    case 'hooks':
      return { kind: 'hooks', action: parseSettingsAction(arg) }
    case 'mcp':
      return { kind: 'mcp', action: parseSettingsAction(arg) }
    case 'memory':
      return { kind: 'memory', action: parseMemoryAction(arg) }
    case 'schedule':
    case 'schedules':
      return { kind: 'schedule', op: parseScheduleArgs(arg) }
    case 'trust': {
      const a = arg.trim().toLowerCase()
      if (!a) return { kind: 'trust', op: 'status' }
      if (a === 'forget') return { kind: 'trust', op: 'forget' }
      if (a === 'list' || a === 'ls') return { kind: 'trust', op: 'list' }
      const n = /^forget\s+(\d+)$/.exec(a)
      if (n && Number(n[1]) >= 1) return { kind: 'trust', op: 'forget', index: Number(n[1]) }
      return { kind: 'trust', op: 'usage' }
    }
    case 'login':
    case 'providers': {
      const op = parseLoginArgs(arg)
      return op.op === 'menu' ? { kind: 'login' } : { kind: 'login-op', op }
    }
    case 'theme': {
      const t = resolveTheme(arg)
      if (t) return { kind: 'set-theme', theme: t }
      return { kind: 'handled' } // no/invalid arg → driver lists themes
    }
    case 'image':
      // A bare /image means "paste what I just copied" — the overwhelmingly common
      // reason to attach an image mid-conversation. It used to print usage.
      // `/image clear` drops what is staged (a file named "clear" is `./clear`).
      if (arg === 'clear') return { kind: 'clear-images' }
      return arg ? { kind: 'image', path: arg } : { kind: 'paste-image' }
    case 'paste':
      return { kind: 'paste-image' }
    case 'approval': {
      const { rest, asDefault } = splitDefaultFlag(arg)
      const policy = parseApprovalPolicy(rest)
      if (policy) return { kind: 'set-approval', policy, ...(asDefault ? { asDefault } : {}) }
      return { kind: 'handled' } // no/invalid arg → driver prints current + usage
    }
    case 'ask':
    case 'auto':
    case 'full': {
      // The desktop's one-word approval commands, so the same names work in both.
      const policy = parseApprovalPolicy(name)
      return policy ? { kind: 'set-approval', policy } : { kind: 'handled' }
    }
    case 'retry':
      return { kind: 'retry' }
    case 'plan':
      // Shortcut for the read-only research-and-propose policy (parity with the GUI's /plan).
      return { kind: 'set-approval', policy: 'plan' }
    case 'compact':
      return arg.trim() ? { kind: 'compact', focus: arg.trim() } : { kind: 'compact' }
    case 'model': {
      const fb = /^fallbacks?(?:\s+([\s\S]*))?$/i.exec(arg.trim())
      if (fb) return { kind: 'model-fallback', op: parseFallbackArgs(fb[1] ?? '') }
      const { rest, asDefault } = splitDefaultFlag(arg)
      // Bare /model: pick from a list (the desktop's model picker), or list them
      // when the terminal can't show a picker.
      if (!rest) return { kind: 'pick-model', ...(asDefault ? { asDefault } : {}) }
      const refresh = /^refresh(?:\s+(\S+))?$/i.exec(rest)
      if (refresh) return { kind: 'model-refresh', ...(refresh[1] ? { provider: refresh[1] } : {}) }
      const resolved = resolveModelArg(rest, settings)
      if (resolved) return { kind: 'set-model', ...resolved, ...(asDefault ? { asDefault } : {}) }
      return { kind: 'handled' }
    }
    case 'help':
    case 'cwd':
    case 'share':
    case 'cost':
    case 'context':
    case 'model?':
      return { kind: 'handled' }
    default: {
      // Not a built-in: try the template commands (first-party like /review, plus
      // custom `.houston/commands`). A match runs its expanded prompt as a turn.
      const cmd = resolveCommand(commands, name)
      if (cmd?.mcpPrompt) return { kind: 'mcp-prompt', command: cmd, args: arg }
      const turn = cmd ? commandTurn(cmd, arg, line) : null
      if (turn && cmd && commandHasRunOptions(cmd)) return { kind: 'prompt', ...turn, command: { cmd, args: arg } }
      if (turn) return { kind: 'prompt', ...turn }
      return { kind: 'unknown', name: typed }
    }
  }
}

/**
 * Split a trailing or leading `--default` off a command argument. `/model`,
 * `/reasoning` and `/approval` change this chat only; with `--default` they also
 * set what new chats start with.
 */
export function splitDefaultFlag(arg: string): { rest: string; asDefault: boolean } {
  const words = arg.trim().split(/\s+/).filter(Boolean)
  const asDefault = words.includes('--default')
  return { rest: words.filter((w) => w !== '--default').join(' '), asDefault }
}

export { resolveModelArg }

export const HELP_TEXT = [
  'Commands:',
  '  /help                 show this help',
  '  /model [id]           pick this chat\'s model from a list, or switch to one by id (--default: new chats too)',
  "  /model refresh [p]    fetch a provider's model list again (default: this chat's provider)",
  '  /model fallback [op]  models to try when the chat\'s model can\'t serve a turn: add <model>, remove/up/down <n>',
  '  /login                set or replace a provider API key, or add a host',
  "  /login edit <p>       change a provider's base URL, region, endpoint or custom headers",
  '  /login remove <p>     remove an added provider · /login forget-key <p>: forget its stored key',
  '  /approval [policy]    show or set this chat\'s approval mode (--default: new chats too)',
  '  /plan                 plan mode: read-only research & propose',
  '  /ask /auto /full      ask every time · auto-approve edits · full auto (sandboxed)',
  '  /clear, /new          start a fresh conversation',
  '  /compact [focus]      summarize older turns to free up context now (focus: what the summary keeps in detail)',
  '  /retry                run your last message again after a turn that failed',
  '  /review [what]        adversarial review of your uncommitted changes, or: a base branch (since it split), #pr, or paths',
  '  /init                 write or improve AGENTS.md, the instructions file for this project',
  '  /resume [query]       pick a saved session to reopen (also /sessions): type to filter, 1-9 open a row, ctrl-r rename, ctrl-d delete, ctrl-a this folder or all folders',
  '  /spawned              list the background sessions the agent started; open one',
  '  /tasks [n|kill n]     background shells and subagents of this chat: list, show n, or stop n (works mid-turn)',
  '  /queue [op n]         messages waiting for the running turn: list, drop n, send n (to the turn now), clear',
  '  /proposals [op n]     sessions the agent proposed: start n, here n, or dismiss n',
  '  /btw [question]       ask a quick side question; the answer stays out of this chat (alone: latest answers, then asks)',
  '  /btw clear            start this chat\'s side chat over',
  '  /loop [10m] <prompt>  run a prompt on a schedule in this folder (/loop 10m check CI; default every 10m)',
  '  /fork [n]             branch the current session into a copy, or from before message n (as numbered in /rewind)',
  '  /rename <title>       give this chat a title',
  '  /export [md|json|html] [path]  write this chat to a file (Markdown by default)',
  '  /export --copy        put it on the clipboard instead; also --no-reasoning, --no-tools; secrets are masked (--no-redact keeps them)',
  '  /import <file>        open a chat exported as JSON or HTML as a new chat here',
  '  /delete               delete this chat (asks first)',
  '  /open-in-app          open this chat in the Houston desktop app',
  '  /permissions [remove n]  all rules that apply, with warnings; or remove one',
  '  /permissions allow n  this session\'s denials are listed too: save the allow rule "Always allow" would have for one',
  '  /permissions add …    add a rule of your own: allow|ask|deny <tool> <pattern> [--exact]',
  '  /cost                 show session token + cost totals, by model and by subagent',
  '  /usage                spend and tokens per day (last 7) and per project, from the chats on this computer',
  '  /statusline           the custom status line: its command, and the JSON that command reads',
  '  /scorecard            how each model has behaved across your chats: steps, tools, clean finishes, cost',
  '  /context              what fills the context now, part by part',
  '  /skills /agents       list workspace skills / custom agents',
  '  /agent <name> <task>  hand a task to one of your .houston/agents',
  '  /settings [page]      what you can change from here, and with which command (a page: just that desktop page)',
  '  /config [key[=value]] pick and change a setting, or show or set one (/config --help lists them)',
  '  /status               version, model, approval, sandbox, network, MCP, settings sources, cost',
  '  /feedback, /bug       report an issue: shows what the report holds, then opens it or prints its link',
  '  /settings get [key]   the settings /settings set changes, or one with what it takes',
  '  /settings set k v     change one: /settings set <key> <value>; /settings unset <key> restores the default',
  '  /settings add|remove  a folder the agent may use in every session: /settings add additionalRoots <path>',
  '  /settings export p    save your preferences to a file; /settings import <path> loads one (asks first)',
  '  /settings reset       every preference back to its default (asks first)',
  "  /settings search-key  enter a web search provider's API key, hidden (optionally name the provider)",
  '  /doctor               check your setup (model, sandbox, tools, MCP)',
  '  /reasoning [effort]   show or set this chat\'s thinking (off | low | medium | high | xhigh; --default)',
  '  /vim [on|off]         vim keys in the composer (Esc for normal mode)',
  '  /keybindings          open ~/.houston/keybindings.json to change keys (creates it the first time)',
  '  /add-dir [path]       let the agent work in another folder this session (alone: list them)',
  '  /cd <path>            move this session to another folder (Tab completes it); the chat moves with it',
  '  /notify [mode]        bell and notification when it needs you: auto | osc | bell | off',
  '  /screen-reader [on|off]  plain lines for screen readers, numbered choices',
  '  /reduce-motion [on|off]  a still activity line instead of the spinner',
  '  /undo, /redo          revert (or restore) the files the last turn changed',
  '  /rewind [n] [mode]    rewind to an earlier message: conversation, code, or both; or summarize from or up to it, or fork from it (/rewind undo)',
  '  /changes [scope]      what changed: the working tree, or turn | chat (also /diff)',
  "  /changes <file>       one changed file's diff (after a scope: in that scope)",
  '  /changes revert <f>   put one changed file back, after a y/N',
  "  /diff last [n]        show the diff of this session's last edit (n edits back)",
  '  /commit [message]     stage and commit every change, after a y/N (no message: the model suggests one)',
  '  /push                 push this branch, or publish it on a first push',
  "  /ship                 hand the changes to the agent to open a PR (the Changes view's Create PR)",
  "  /pr                   this branch's pull request, its state, and its CI checks",
  '  /verbose [on|off]     show every tool call and its full output as it runs',
  '  /focus [on|off]       show only your messages, one line per tool call, and the final reply (wins over /verbose)',
  '  /thoughts [mode]      how reasoning shows as it streams: show | summary | hide (Alt-T)',
  '  /transcript           the whole session full screen, with reasoning and full tool output (Ctrl-O)',
  "  /todos                the agent's current todo list, and how much of it is done",
  '  /output [n]           reprint a tool result in full (n back; default the last)',
  '  /copy [n]             copy a reply (n back; default the last) or one of its code blocks',
  '  /hooks [verb n]       lifecycle hooks (yours, then the project\'s): add, edit <n>, remove <n>',
  '  /memory [verb n]      review saved memories: show, edit, pin, unpin, forget <n>; undo, on, off, folder',
  '  /schedule [verb n]    scheduled runs: list; add; show, pause, resume, run (now), delete <n> (also /schedules)',
  '  /mcp [verb n]         list MCP servers (status, last error); tools · enable · disable · remove · login · logout <n>',
  '  /mcp add [--url u]    add a stdio server (guided), or a remote one: --url <url> [name] [--sse]',
  "  /mcp reconnect <n>    restart a server's connection now (/mcp reconnect all: every one)",
  '  /mcp search <query>   search the MCP Registry; /mcp add-from-registry <name> reviews one to add',
  '  /mcp catalog          recommended servers; /mcp add-from-catalog <n> reviews one to add',
  "  /mcp edit <n>         change a server's command, arguments, folder, or URL",
  "  /trust [forget]       show this folder's project-config trust, or forget it to re-decide",
  '  /trust list           every folder you trusted or refused; /trust forget <n> clears one',
  `  /theme [name]         list or switch color theme (${Object.keys(THEMES).join(' | ')}, or your own)`,
  '  /image [path|clear]   attach an image from your clipboard, or a file; clear drops them',
  '  /cwd                  show the working directory',
  '  /share                copy an invite to Houston to send a friend',
  '  /<name>               run a custom command from .houston/commands (a subfolder is a namespace: git/commit.md is /git:commit)',
  '  /mcp__<server>__<p>   run a connected MCP server\'s prompt (args in order, or name=value)',
  '  /exit, /quit          leave (or press Ctrl-D)',
  '',
  'Keys:',
  '  Enter                 send the message',
  '  Shift-Enter, Ctrl-J   new line (Alt-Enter too; Shift-Enter where the terminal reports it)',
  '  @ then Tab            complete a file, @path#20-45 (those lines), @server:uri or @agent-<name>',
  '  !command              run a shell command yourself; its output joins the chat',
  '  #note                 save a standing instruction to AGENTS.md',
  '  Shift-Tab             cycle the approval mode, also while a turn runs',
  '  Up, Down              earlier messages (this folder)',
  '  Ctrl-R                search earlier messages (Ctrl-R/Up older, Ctrl-S/Down newer)',
  '  Up, Down in a menu    choose a / command or @ file; Enter or Tab picks, Esc closes',
  '  Alt-P, Ctrl-X Ctrl-P  expand collapsed pastes back to their text',
  '  Ctrl-X Ctrl-E, Ctrl-G edit the message in $VISUAL or $EDITOR',
  '  Ctrl-_, Ctrl-^        undo, redo the last edit (Ctrl-/ and Ctrl-6 on most keyboards)',
  '  Ctrl-S                stash the message and clear the prompt; again on an empty prompt to restore',
  '  Ctrl-V, Alt-V         attach the image on the clipboard (pasting image file paths attaches them too)',
  '  Esc Esc               clear the message (Up brings it back); on an empty prompt, /rewind',
  '  Ctrl-L                clear the screen',
  '  Ctrl-O                the whole session full screen: j/k, / search, { } your messages, v editor, q',
  '  Alt-T                 cycle how reasoning shows (show, summary, hide), also while a turn runs',
  '  Ctrl-Z                suspend to the shell (fg to come back), also while a turn runs',
  '  Ctrl-B                while a command runs: move it to the background (/tasks lists it)',
  '  Ctrl-C                clear the message (twice to exit; Up brings it back); Ctrl-D exits',
  '  ultrathink            a word in the message: think harder for that turn',
  '  ?                     on an empty prompt: these keys, and your own keybindings',
  '',
  'While a turn runs: type, then Enter steers it or Tab queues for after it.',
  'Up on an empty line takes the last waiting message back. Esc or Ctrl-C stops it.',
  'While subagents run: Enter on an empty line watches their steps live.',
  '',
  'Approvals (one key press answers):',
  '  y                     allow this call once',
  '  a                     allow this kind of tool for the rest of this chat, until Houston quits (a network call: that destination only)',
  '  !                     always allow: saves a permission rule, kept across restarts',
  '  c                     allow with a note: what you type goes to the agent with the result',
  '  n, x                  deny this call, or always deny (saves a rule)',
  '  yes                   typed to run a command that can throw away work (git reset --hard, a forced push, rm -r)',
  '  any other key         start a reason to deny with, sent to the agent',
  '  Esc, Ctrl-C           deny; Ctrl-C also stops the turn'
].join('\n')

/** Keybinding-file problems as lines to print: what was skipped and why. */
export function formatKeybindingProblems(problems: string[], paint: Painter): string {
  const head = `· ~/.houston/keybindings.json: ${problems.length === 1 ? 'one entry was' : `${problems.length} problems were`} skipped (/keybindings to fix)`
  return `${paint(head, 'yellow')}\n${problems.map((p) => `${paint(`  ${stripControlChars(p)}`, 'dim')}\n`).join('')}`
}

/** Short tips for keys and prefixes a new user would not find on their own. */
export const STARTUP_TIPS = [
  'type @ then Tab to complete a file path into your message',
  '!command runs a shell command yourself; its output joins the chat',
  '#note saves a standing instruction to AGENTS.md',
  'Shift-Tab cycles the approval mode, even while a turn runs',
  'Ctrl-R searches your earlier messages',
  'Ctrl-G (or Ctrl-X Ctrl-E) edits your message in $VISUAL or $EDITOR',
  'Ctrl-V pastes the image on your clipboard; dropping an image file attaches it',
  'Ctrl-S stashes your message for later; Ctrl-S on an empty prompt brings it back',
  'Ctrl-_ undoes your last edit in the prompt; Ctrl-^ redoes it',
  'Esc Esc on an empty prompt rewinds to an earlier message',
  'type while the agent works and press Enter to steer it',
  'while the agent works, Tab queues what you typed for after the turn instead of steering',
  '/tasks lists background shells and subagents, even while a turn runs',
  'Ctrl-B moves a slow command to the background so the turn carries on',
  '/focus hides the working and keeps one line per tool call',
  'Shift-Enter or Ctrl-J starts a new line',
  '/resume filters saved chats as you type; Ctrl-A shows every folder',
  'Ctrl-O opens the whole session full screen, with reasoning and full tool output',
  'Alt-T cycles how the model\'s reasoning shows: in full, one line, or hidden',
  '/copy puts the last reply, or one of its code blocks, on your clipboard',
  '/cd <path> moves the session to another folder; Tab completes the path',
  'using a screen reader? /screen-reader on keeps the output to plain lines',
  '/config lists the terminal settings; Enter changes the highlighted one',
  '? on an empty prompt lists the keys; /keybindings changes them'
]

/**
 * `count` consecutive tips starting at a seed-chosen place, so each launch shows a
 * different pair and every tip comes around in turn.
 */
export function pickTips(seed: number, count = 2, tips: readonly string[] = STARTUP_TIPS): string[] {
  if (!tips.length) return []
  const start = ((Math.floor(seed) % tips.length) + tips.length) % tips.length
  const n = Math.min(count, tips.length)
  return Array.from({ length: n }, (_, i) => tips[(start + i) % tips.length])
}

/** How the model's reasoning shows as it streams (the `reasoningDisplay` setting). */
export type ReasoningDisplay = 'show' | 'summary' | 'hide'
export const REASONING_DISPLAYS: readonly ReasoningDisplay[] = ['show', 'summary', 'hide']
export const DEFAULT_REASONING_DISPLAY: ReasoningDisplay = 'summary'

export function isReasoningDisplay(v: unknown): v is ReasoningDisplay {
  return typeof v === 'string' && (REASONING_DISPLAYS as readonly string[]).includes(v)
}

/** Alt-T and a bare /thoughts: show, then summary, then hide, then show again. */
export function nextReasoningDisplay(d: ReasoningDisplay): ReasoningDisplay {
  return REASONING_DISPLAYS[(REASONING_DISPLAYS.indexOf(d) + 1) % REASONING_DISPLAYS.length]
}

/** The line saying what a reasoning display now does. */
export function reasoningDisplayNote(d: ReasoningDisplay): string {
  switch (d) {
    case 'show':
      return '· thoughts: shown in full as they stream (Alt-T or /thoughts to change)'
    case 'summary':
      return '· thoughts: one line each, with how long it took (Ctrl-O shows them in full)'
    case 'hide':
      return '· thoughts: hidden while they stream (Ctrl-O shows them in full)'
  }
}

/** `12s`, `1m 05s`: how long a thought took, never under a second. */
export function formatThoughtDuration(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`
}

/**
 * The opening of a thought, on one line: a bold heading on its own line (how some
 * models title a reasoning summary) or else the first sentence. '' for none.
 */
export function firstSentence(text: string): string {
  const lines = sanitizeLines(text)
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) return ''
  const heading = /^(?:#+\s*)?\*\*(.+?)\*\*:?$/.exec(lines[0])
  if (heading) return heading[1].trim()
  const flat = lines.join(' ').replace(/\*\*|__|`/g, '').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim()
  const m = /^(.+?[.!?])(?=\s|$)/.exec(flat)
  return (m ? m[1] : flat).trim()
}

/** The `reasoningDisplay: 'summary'` line for a finished thought, fitted to `width`. */
export function renderThoughtSummary(text: string, ms: number, width: number, paint: Painter): string {
  const head = `· thought for ${formatThoughtDuration(ms)}`
  const gist = firstSentence(text)
  const line = gist ? `${head}: ${gist}` : head
  return paint(truncateVisible(line, Math.max(head.length, width - 1)), 'dim')
}

/** Where /help's descriptions start: two spaces, then the command padded to 22. */
const HELP_DESC_COLUMN = 24

/**
 * Help rows (`  /name   description`) fitted to the terminal: a description too
 * long for the line continues on the next one under the description column,
 * instead of the terminal breaking it mid-word back at the left edge. Other lines
 * wrap at words. Left as is when the terminal is too narrow for the column to help.
 */
export function wrapHelp(text: string, width: number, column = HELP_DESC_COLUMN): string {
  const descWidth = width - column
  if (descWidth < 20) return text
  const pad = ' '.repeat(column)
  return text
    .split('\n')
    .map((line) => {
      if (visibleWidth(line) <= width) return line
      // Not a command or key row, or a name so long it runs into the column: plain wrap.
      if (!line.startsWith('  ') || line[column - 1] !== ' ') return wrapAnsi(line, width)
      return wrapAnsi(line.slice(column), descWidth)
        .split('\n')
        .map((part, i) => (i === 0 ? line.slice(0, column) : pad) + part)
        .join('\n')
    })
    .join('\n')
}

// --- Settings editing (/settings, /hooks, /mcp) ------------------------------
// A small, safe subset of settings editing for the terminal. The desktop app has
// the full panel; here we cover lifecycle hooks and MCP servers (stdio, or a remote
// URL with no headers). We deliberately never collect header secrets: those are the
// desktop app's job (the CLI can't persist header secrets, see store.ts), so a remote
// server added here authenticates with OAuth (`/mcp login`) or not at all.

// Lifecycle events a hook can bind to: re-exported from @shared/types (the one
// list validators and UIs share) so existing terminal imports keep working.
export { HOOK_EVENTS }

/** What the user asked /hooks or /mcp to do. Indexed ops carry a 1-based index. */
export type SettingsAction =
  | { op: 'list' }
  /**
   * Add an entry. On /mcp, `url` adds a remote server (`/mcp add --url <url> [name]`,
   * streamable HTTP, or the legacy SSE transport with `--sse`); without it the
   * guided stdio prompts run.
   */
  | { op: 'add'; url?: string; name?: string; sse?: boolean }
  | { op: 'remove'; index: number }
  /** Switch a server on or off, kept in settings (/mcp enable|disable <n>). /mcp only. */
  | { op: 'enable'; index: number }
  | { op: 'disable'; index: number }
  /** Restart a server's connection now, or every server's (/mcp reconnect <n|all>). /mcp only. */
  | { op: 'reconnect'; index: number | 'all' }
  /** List a server's tools (/mcp tools <n>). /mcp only. */
  | { op: 'tools'; index: number }
  /** OAuth sign-in for a remote MCP server (/mcp login <n>). /mcp only. */
  | { op: 'login'; index: number }
  /** Forget a remote MCP server's OAuth tokens (/mcp logout <n>). /mcp only. */
  | { op: 'logout'; index: number }
  /** Search the MCP Registry (/mcp search <query>; empty lists all). /mcp only. */
  | { op: 'search'; query: string }
  /** Review and add a registry entry by its full name (/mcp add-from-registry <name>). /mcp only. */
  | { op: 'registry-add'; name: string }
  /** Change an entry's fields, current values as the defaults (/hooks edit <n>, /mcp edit <n>). */
  | { op: 'edit'; index: number }
  /** The recommended servers shipped with the app (/mcp catalog). /mcp only. */
  | { op: 'catalog' }
  /** Review and add a recommended server by number or id (/mcp add-from-catalog <n|id>). /mcp only. */
  | { op: 'catalog-add'; entry: string }
  | { op: 'usage' }

/** Parse the argument of /hooks or /mcp into an action. Bare command → list. */
export function parseSettingsAction(arg: string): SettingsAction {
  const [verb, ...rest] = arg.trim().split(/\s+/).filter(Boolean)
  if (!verb) return { op: 'list' }
  if (verb === 'add') {
    if (!rest.length) return { op: 'add' }
    // `--url <url> [name] [--sse]`, the flags in any order.
    const sse = rest.includes('--sse')
    const words = rest.filter((w) => w !== '--sse')
    const at = words.indexOf('--url')
    const url = at >= 0 ? words[at + 1] : undefined
    if (!url || url.startsWith('--')) return { op: 'usage' }
    const others = words.filter((_, i) => i !== at && i !== at + 1)
    if (others.length > 1 || others.some((w) => w.startsWith('--'))) return { op: 'usage' }
    return { op: 'add', url, ...(others[0] ? { name: others[0] } : {}), ...(sse ? { sse } : {}) }
  }
  if (verb === 'search') return { op: 'search', query: rest.join(' ') }
  if (verb === 'add-from-registry') return rest.length === 1 ? { op: 'registry-add', name: rest[0] } : { op: 'usage' }
  if (verb === 'catalog' || verb === 'recommended') return rest.length ? { op: 'usage' } : { op: 'catalog' }
  if (verb === 'add-from-catalog') return rest.length === 1 ? { op: 'catalog-add', entry: rest[0] } : { op: 'usage' }
  if (verb === 'edit') {
    const n = Number(rest[0] ?? '')
    return rest.length === 1 && /^\d+$/.test(rest[0]) && n >= 1 ? { op: 'edit', index: n } : { op: 'usage' }
  }
  const indexed = (op: 'remove' | 'login' | 'logout' | 'tools' | 'enable' | 'disable'): SettingsAction => {
    const n = Number.parseInt(rest[0] ?? '', 10)
    if (Number.isInteger(n) && n >= 1) return { op, index: n }
    return { op: 'usage' }
  }
  if (verb === 'tools') return indexed('tools')
  if (verb === 'enable' || verb === 'on') return indexed('enable')
  if (verb === 'disable' || verb === 'off') return indexed('disable')
  if (verb === 'reconnect' || verb === 'restart') {
    if (rest[0]?.toLowerCase() === 'all') return { op: 'reconnect', index: 'all' }
    const n = Number(rest[0] ?? '')
    return /^\d+$/.test(rest[0] ?? '') && n >= 1 ? { op: 'reconnect', index: n } : { op: 'usage' }
  }
  if (verb === 'remove' || verb === 'rm' || verb === 'delete') return indexed('remove')
  if (verb === 'login' || verb === 'signin') return indexed('login')
  if (verb === 'logout' || verb === 'signout') return indexed('logout')
  return { op: 'usage' }
}

/** Map a hook-event answer (a 1-based number or a name) to a candidate event string. */
export function resolveHookEventInput(input: string): string {
  const n = Number.parseInt(input.trim(), 10)
  if (Number.isInteger(n) && n >= 1 && n <= HOOK_EVENTS.length) return HOOK_EVENTS[n - 1]
  return input.trim()
}

/**
 * Validate raw field input into a Hook, or return an error to show the user. A blank
 * `timeout` keeps the default; otherwise it is a whole number of seconds, 1-600.
 */
export function buildHook(event: string, matcher: string, command: string, timeout = ''): Hook | { error: string } {
  if (!(HOOK_EVENTS as string[]).includes(event)) {
    return { error: `unknown event "${event}" (expected one of: ${HOOK_EVENTS.join(', ')})` }
  }
  const cmd = command.trim()
  if (!cmd) return { error: 'a hook needs a shell command to run' }
  const t = timeout.trim()
  let seconds: number | undefined
  if (t) {
    seconds = Number(t)
    if (!/^\d+$/.test(t) || seconds < HOOK_TIMEOUT_MIN_S || seconds > HOOK_TIMEOUT_MAX_S) {
      return { error: `the timeout is a whole number of seconds from ${HOOK_TIMEOUT_MIN_S} to ${HOOK_TIMEOUT_MAX_S}` }
    }
  }
  // Lifecycle events have no tool to match; a blank matcher means "any".
  return {
    event: event as Hook['event'],
    matcher: matcher.trim() || '*',
    command: cmd,
    ...(seconds !== undefined ? { timeout: seconds } : {})
  }
}

/**
 * Validate raw field input into a *stdio* MCP server config, or return an error.
 * No url/headers by construction: remote transports are the desktop app's domain
 * (or `/mcp login` for OAuth), so a terminal-added server is always a local
 * process. `envStr` is space-separated KEY=value pairs; values are secrets, moved
 * into the secret store by the settings save (see store.ts).
 */
export function buildStdioMcpServer(
  existingIds: string[],
  name: string,
  command: string,
  argsStr: string,
  cwdStr = '',
  envStr = ''
): McpServerConfig | { error: string } {
  const id = name.trim()
  if (!/^[\w-]+$/.test(id)) {
    return { error: 'name must be letters, numbers, hyphens or underscores (no spaces)' }
  }
  if (existingIds.includes(id)) return { error: `an MCP server named "${id}" already exists` }
  const cmd = command.trim()
  if (!cmd) return { error: 'a command to spawn is required (e.g. npx)' }
  const args = argsStr.trim() ? argsStr.trim().split(/\s+/) : undefined
  const env: Record<string, string> = {}
  for (const pair of envStr.trim() ? envStr.trim().split(/\s+/) : []) {
    const eq = pair.indexOf('=')
    const key = eq > 0 ? pair.slice(0, eq) : ''
    if (!/^[A-Za-z_]\w*$/.test(key)) {
      return { error: `env must be KEY=value pairs separated by spaces (got "${pair}")` }
    }
    env[key] = pair.slice(eq + 1)
  }
  const cwd = cwdStr.trim()
  return {
    id,
    name: id,
    transport: 'stdio',
    command: cmd,
    ...(args ? { args } : {}),
    ...(cwd ? { cwd } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    enabled: true
  }
}

/**
 * Validate `/mcp add --url <url> [name]` into a remote MCP server config, shaped as
 * the desktop's Settings > MCP servers stores one (`transport` http or sse, an empty
 * `command`, the `url`). No headers: a server that needs a static token is set up in
 * the desktop app; one that uses OAuth signs in with `/mcp login <n>`. A name left
 * out comes from the URL's host, made unique.
 */
export function buildRemoteMcpServer(
  existingIds: string[],
  url: string,
  name = '',
  sse = false
): McpServerConfig | { error: string } {
  let parsed: URL
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(url)) return { error: 'the URL has control characters in it' }
  try {
    parsed = new URL(url.trim())
  } catch {
    return { error: `"${stripControlChars(url)}" is not a URL (use https://host/path)` }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: 'the URL must start with http:// or https://' }
  }
  // settings.json is plain text: a password in the URL would sit there unencrypted.
  if (parsed.username || parsed.password) {
    return { error: 'leave credentials out of the URL; add a token header in the desktop app, or sign in with /mcp login' }
  }
  let id = name.trim()
  if (id) {
    if (!/^[\w-]+$/.test(id)) return { error: 'name must be letters, numbers, hyphens or underscores (no spaces)' }
    if (existingIds.includes(id)) return { error: `an MCP server named "${id}" already exists` }
  } else {
    id = freeServerId(parsed.hostname, existingIds)
  }
  return { id, name: id, transport: sse ? 'sse' : 'http', command: '', url: url.trim(), enabled: true }
}

/** Numbered list of hooks, or a "none" note. */
export function renderHookList(hooks: Hook[], paint: Painter): string {
  if (!hooks.length) return paint('No hooks configured.', 'dim')
  return hooks
    .map(
      (h, i) =>
        `  ${paint(`${i + 1}.`, 'dim')} ${paint(h.event, 'cyan')}  ${h.matcher}  ${paint('→', 'dim')} ${h.command}` +
        (h.timeout !== undefined ? paint(`  (timeout ${h.timeout}s)`, 'dim') : '')
    )
    .join('\n')
}

/**
 * Numbered list of MCP servers. Only the transport summary is shown — never the
 * `headers`/`env` maps, whose values are secrets (masked on read, but we don't
 * print them at all). `statuses` (from the manager) adds a live connection badge:
 * connected tool count, needs-sign-in, or the connect error.
 */
export function renderMcpList(
  servers: McpServerConfig[],
  paint: Painter,
  statuses: McpServerStatus[] = []
): string {
  if (!servers.length) return paint('No MCP servers configured.', 'dim')
  const statusById = new Map(statuses.map((s) => [s.id, s]))
  return servers
    .map((s, i) => {
      const transport = s.transport ?? (s.url && !s.command ? 'http' : 'stdio')
      const detail =
        transport === 'stdio'
          ? `${s.command}${s.args?.length ? ` ${s.args.join(' ')}` : ''}`
          : (s.url ?? '')
      const off = s.enabled === false ? paint(' (disabled)', 'dim') : ''
      const auth = transport !== 'stdio' && s.hasOAuth ? paint(' (signed in)', 'green') : ''
      const st = statusById.get(s.id)
      const badge =
        st?.state === 'connected'
          ? paint(`  ✓ connected, ${st.tools ?? 0} tool${st.tools === 1 ? '' : 's'}`, 'green')
          : st?.state === 'needs-auth'
            ? paint(`  ! needs sign-in (/mcp login ${i + 1})`, 'yellow')
            : st?.state === 'error'
              ? paint(
                  `  ✗ last error: ${truncate(stripControlChars(st.error ?? 'failed to connect').replace(/\s+/g, ' ').trim(), 160)} (/mcp reconnect ${i + 1})`,
                  'red'
                )
              : ''
      return `  ${paint(`${i + 1}.`, 'dim')} ${paint(s.name ?? s.id, 'cyan')}${off}${auth}  ${paint(`[${transport}]`, 'dim')}  ${detail}${badge}`
    })
    .join('\n')
}

/**
 * A server's tools, by name.
 *
 * `/mcp` could tell you a server was connected and how MANY tools it had, never
 * which — so "what did I just give the agent?" had no answer short of reading the
 * server's own docs. That is the question that decides whether you trust it.
 */
export function renderMcpTools(name: string, status: McpServerStatus | undefined, paint: Painter): string {
  if (!status) return paint(`· "${name}" has not connected yet; its tools are unknown until it does`, 'dim')
  if (status.state === 'needs-auth') return paint(`· "${name}" needs sign-in first (/mcp login)`, 'yellow')
  if (status.state === 'error') {
    return paint(`· "${name}" failed to connect: ${stripControlChars(status.error ?? 'unknown error')}`, 'red')
  }
  const names = status.toolNames ?? []
  if (!names.length) return paint(`· "${name}" is connected but exposes no tools`, 'dim')
  const lines = [paint(`${name}: ${names.length} tool${names.length === 1 ? '' : 's'}`, 'bold')]
  // Namespaced as the agent sees them, so what is listed here is what appears in
  // an approval prompt.
  for (const t of names) lines.push(`  ${paint(stripControlChars(t), 'cyan')}`)
  return lines.join('\n')
}

/**
 * The "where the file is" footer shared by the settings commands. The commands
 * above it (/hooks, /mcp) apply on your next message; only a file you edit by hand
 * needs a restart, because the settings cache is read from disk once and the app
 * has no watcher on it — so that is the one thing this footer calls out.
 */
export function renderSettingsFooter(path: string, paint: Painter): string {
  return paint(`settings file: ${path}\n(a file you edit by hand is picked up on restart)`, 'dim')
}

// --- /login: in-session API-key setup ----------------------------------------
// A guided flow to set a provider's API key — or add a host — without leaving the
// session or hand-editing a credentials file. Auto-launched on a keyless start and
// reachable any time via /login (alias /providers). The pure pieces (menu render +
// choice parsing + custom-endpoint validation) are exported for tests; the async
// driver below reads input and persists through the injected setKey/updateSettings
// seams (writing to safeStorage on the desktop, cli-credentials.json on the CLI).

/** Configured providers that authenticate with an API key — the rows of the /login menu. */
export function keyableProviders(settings: AppSettings): ProviderConfig[] {
  return settings.providers.filter((p) => p.requiresKey)
}

/** How many model ids to preview per provider row before collapsing to "+N more". */
const MENU_MODEL_PREVIEW = 4

/**
 * A compact model summary for one menu row: the first few ids, then a dim `+N more`
 * so a provider with hundreds of models (e.g. an aggregator) doesn't wrap into a wall
 * of text. Empty list renders "no models yet".
 */
export function summarizeModels(ids: string[], paint: Painter, max = MENU_MODEL_PREVIEW): string {
  if (!ids.length) return paint('no models yet', 'dim')
  if (ids.length <= max) return ids.join(', ')
  return `${ids.slice(0, max).join(', ')}${paint(`, +${ids.length - max} more`, 'dim')}`
}

/**
 * Hosts that need no key: the local servers (Ollama, LM Studio) and endpoints added
 * with `houston providers add`. They follow the keyable providers in the /login menu,
 * where picking one means "use it", not "paste a key".
 */
export function hostProviders(settings: AppSettings): ProviderConfig[] {
  return settings.providers.filter((p) => !p.requiresKey)
}

/** What asking a host for its models found: the models, or no answer. */
export type HostProbe = { ok: true; models: ModelOption[] } | { ok: false }

/** True for a base URL on this machine, where "no answer" means "not running". */
export function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

/** A host row's status: what the probe found, or what is configured when there was none. */
type MenuTone = 'green' | 'yellow' | 'dim'
function hostStatus(
  p: ProviderConfig,
  probe: HostProbe | undefined,
  paint: Painter
): { status: string; tone: MenuTone; models: string } {
  const configured = summarizeModels(p.models.map((m) => m.id), paint)
  if (!probe) return { status: 'no key needed', tone: 'dim', models: configured }
  if (!probe.ok) {
    return {
      status: isLocalUrl(p.baseUrl) ? '✗ not running' : '✗ no answer',
      tone: 'dim',
      models: p.models.length ? configured : paint(p.baseUrl ?? '', 'dim')
    }
  }
  if (!probe.models.length) return { status: '! no models', tone: 'yellow', models: paint(p.baseUrl ?? '', 'dim') }
  return { status: '✓ running', tone: 'green', models: summarizeModels(probe.models.map((m) => m.id), paint) }
}

/**
 * Render the provider menu: each keyable provider with its key status, then the
 * hosts that need no key (with what probing them found), then "Other host…".
 */
export function renderProviderMenu(
  providers: ProviderConfig[],
  paint: Painter,
  opts: {
    firstRun: boolean
    otherHostExamples?: string
    hosts?: Array<{ provider: ProviderConfig; probe?: HostProbe }>
  }
): string {
  const hosts = opts.hosts ?? []
  const lines: string[] = [
    opts.firstRun
      ? paint(
          hosts.length
            ? 'No model is ready yet. Set up a provider, or pick a local or added host.'
            : 'No model is ready yet. None of your providers has an API key.',
          'yellow'
        )
      : paint('Providers (key status on this profile):', 'bold')
  ]
  const otherLabel = 'Other host…'
  // Align the status column to the widest label (built-in names like "Anthropic
  // (Claude)" and custom-endpoint labels vary in length), so the rows don't stagger.
  const labelWidth = Math.max(
    otherLabel.length,
    ...providers.map((p) => (p.label ?? p.id).length),
    ...hosts.map((h) => (h.provider.label ?? h.provider.id).length)
  )
  const rows: Array<{ label: string; status: string; tone: MenuTone; models: string }> = [
    ...providers.map((p) => ({
      label: p.label ?? p.id,
      status: p.hasKey ? '✓ key set' : '✗ no key',
      tone: (p.hasKey ? 'green' : 'dim') as MenuTone,
      models: summarizeModels(
        p.models.map((m) => m.id),
        paint
      )
    })),
    ...hosts.map((h) => ({ label: h.provider.label ?? h.provider.id, ...hostStatus(h.provider, h.probe, paint) }))
  ]
  // Pad the status column too, so the model lists line up across both groups.
  const statusWidth = Math.max(0, ...rows.map((r) => r.status.length))
  rows.forEach((r, i) => {
    lines.push(
      `  ${paint(`${i + 1})`, 'cyan')} ${r.label.padEnd(labelWidth)}  ${paint(r.status.padEnd(statusWidth), r.tone)}  ${r.models}`
    )
  })
  const other = providers.length + hosts.length + 1
  // Examples come from the caller (only hosts not already configured), so the hint
  // can't advertise a provider that's already listed above. Falls back to the
  // always-available custom-endpoint option.
  const examples = opts.otherHostExamples?.trim() || 'add a custom endpoint'
  lines.push(`  ${paint(`${other})`, 'cyan')} ${otherLabel.padEnd(labelWidth)}  ${paint(examples, 'dim')}`)
  lines.push(
    paint(
      opts.firstRun
        ? 'Pick a number to set up, or press Enter to skip for now.'
        : 'Pick a provider to set or replace its key (Enter to cancel).',
      'dim'
    )
  )
  return lines.join('\n')
}

/**
 * The "e.g. …" hint for the Other-host row, built from catalog hosts NOT already
 * configured (so it never names a provider shown above) plus the custom-endpoint
 * escape hatch. Given the already-filtered addable list.
 */
export function otherHostExamples(addable: CatalogEntry[]): string {
  const names = addable.slice(0, 3).map((e) => e.label)
  return [...names, 'a custom endpoint'].join(', ')
}

/**
 * Interpret a numbered-menu answer where 1..count select a listed item, count+1 is a
 * trailing extra row, and anything else (blank, non-numeric, out of range) cancels.
 * Shared by the provider menu and the add-host menu below.
 */
function parseNumberedChoice(
  answer: string,
  count: number
): { kind: 'item'; index: number } | { kind: 'extra' } | { kind: 'cancel' } {
  const n = Number.parseInt(answer.trim(), 10)
  if (!Number.isInteger(n)) return { kind: 'cancel' }
  if (n >= 1 && n <= count) return { kind: 'item', index: n - 1 }
  if (n === count + 1) return { kind: 'extra' }
  return { kind: 'cancel' }
}

/** Interpret a provider-menu answer: a listed provider, the "Other host…" item, or cancel. */
export function parseProviderMenuChoice(
  answer: string,
  providerCount: number
): { kind: 'provider'; index: number } | { kind: 'other' } | { kind: 'cancel' } {
  const c = parseNumberedChoice(answer, providerCount)
  if (c.kind === 'item') return { kind: 'provider', index: c.index }
  if (c.kind === 'extra') return { kind: 'other' }
  return { kind: 'cancel' }
}

/** Render the "add a host" menu: one flat numbered list of catalog hosts, then "Custom endpoint". */
export function renderCatalogMenu(catalog: CatalogEntry[], paint: Painter): string {
  const lines: string[] = [
    paint('Add a host. Pick a known one, or point Houston at any OpenAI-compatible server:', 'bold')
  ]
  catalog.forEach((e, i) => {
    const note = e.requiresKey ? e.blurb : `${e.blurb} · no key needed`
    lines.push(`  ${paint(`${String(i + 1).padStart(2)})`, 'cyan')} ${e.label.padEnd(16)} ${paint(note, 'dim')}`)
  })
  const custom = catalog.length + 1
  lines.push(
    `  ${paint(`${String(custom).padStart(2)})`, 'cyan')} ${'Custom endpoint'.padEnd(16)} ${paint('enter your own label + base URL', 'dim')}`
  )
  lines.push(paint('Pick a host to add (Enter to cancel).', 'dim'))
  return lines.join('\n')
}

/** Interpret an add-host answer: a catalog host, the custom-endpoint item, or cancel. */
export function parseCatalogChoice(
  answer: string,
  catalogCount: number
): { kind: 'host'; index: number } | { kind: 'custom' } | { kind: 'cancel' } {
  const c = parseNumberedChoice(answer, catalogCount)
  if (c.kind === 'item') return { kind: 'host', index: c.index }
  if (c.kind === 'extra') return { kind: 'custom' }
  return { kind: 'cancel' }
}

/**
 * Paste a key (hidden) for `provider` and, if the provider has a model, switch to it.
 * Returns the provider+model to run, or null when no key was entered for a
 * key-required provider or the provider has no models yet (a freshly-added host).
 */
async function keyEntryFor(
  provider: ProviderConfig,
  deps: TuiDeps,
  paint: Painter,
  keyUrl: string | undefined
): Promise<{ providerId: string; model: string } | null> {
  const readSecret = deps.io.readSecret ?? deps.io.readLine
  const name = provider.label ?? provider.id
  if (keyUrl) deps.io.out(paint(`${name} → get a key at ${keyUrl}\n`, 'dim'))

  const optional = !provider.requiresKey
  deps.io.out(
    paint(
      optional
        ? 'Paste an API key if this endpoint needs one (Enter to skip; hidden):'
        : 'Paste your API key (hidden; not saved to shell or session history):',
      'dim'
    ) + '\n'
  )
  const key = (await readSecret(paint('key › ', 'green')))?.trim() ?? ''
  if (!key) {
    if (!optional) {
      deps.io.out(paint('· no key entered, nothing changed\n', 'dim'))
      return null
    }
  } else if (deps.setKey) {
    const { shadowedByEnv } = deps.setKey(provider.id, key)
    deps.io.out(paint(`· Key saved for ${name} (owner-only, on this profile). It's active now.\n`, 'dim'))
    if (shadowedByEnv) {
      deps.io.out(
        paint(
          `· Note: ${shadowedByEnv} is set in your environment and takes precedence over the stored key.\n`,
          'yellow'
        )
      )
    }
  }

  const model = pickDefaultModel(provider)
  if (!model) {
    deps.io.out(
      paint(`· ${name} has no models yet. Add one with:  /model ${provider.id}/<model-id>\n`, 'dim')
    )
    return null
  }
  // Persist the selection so the next launch skips setup and reopens this provider.
  deps.updateSettings?.({ selected: { providerId: provider.id, model } })
  deps.io.out(paint(`· Model set to ${provider.id} / ${model}.\n`, 'dim'))
  return { providerId: provider.id, model }
}

/**
 * The "Other host…" branch: add a catalog host or a custom OpenAI-compatible endpoint,
 * persist it, and return it (with any docs URL) for the key-entry step. Null on cancel
 * or when settings can't be written here.
 */
/**
 * Ask for the config a kind needs beyond its key (see `providerSetupFields`),
 * returning the provider with the answers written on. Null when the user cancels.
 *
 * Three rules, each one a way this could annoy rather than help:
 *  - A field the environment already answers is never asked. The SDKs read those
 *    vars themselves, so prompting would invite the user to overwrite a working
 *    setup with a typo.
 *  - A catalog default (Bedrock's `us-east-1`, Azure's API version) is offered as
 *    the Enter-to-accept answer rather than a blank the user has to research.
 *  - An optional field takes empty for an answer. Vertex reads the project from
 *    the ADC credentials, so blank is usually the *correct* value, not a skip.
 */
export async function promptSetupFields(
  provider: ProviderConfig,
  deps: TuiDeps,
  paint: Painter
): Promise<ProviderConfig | null> {
  const fields = providerSetupFields(provider.kind).filter(
    (f) => !f.envVars.some((v) => process.env[v])
  )
  if (!fields.length) return provider

  const out: ProviderConfig = { ...provider }
  for (const f of fields) {
    const current = out[f.key]
    const hint = current ? `Enter for ${current}` : f.required ? f.placeholder : 'Enter to skip'
    deps.io.out(paint(`${f.label} (${hint}):`, 'dim') + '\n')
    const answer = await deps.io.readLine(paint(`${f.key} › `, 'green'))
    if (answer === null) {
      deps.io.out(paint('· cancelled\n', 'dim'))
      return null
    }
    const value = answer.trim()
    if (value) out[f.key] = value
    else if (!current && f.required) {
      // No default, nothing typed, and the provider can't address a host without
      // it. Say where it can still come from rather than just refusing.
      deps.io.out(
        paint(
          `· ${provider.label} needs ${f.label.toLowerCase()}. Add it in Settings, or export ${f.envVars[0] ?? 'it'}.\n`,
          'yellow'
        )
      )
    }
  }
  return out
}

async function addHostInteractive(
  deps: TuiDeps,
  paint: Painter,
  newId: () => string
): Promise<{ provider: ProviderConfig; keyUrl?: string } | null> {
  if (!deps.updateSettings) {
    deps.io.out(paint('· adding a host is unavailable here\n', 'dim'))
    return null
  }
  const isMac = deps.isMac ?? process.platform === 'darwin'
  const settings = deps.getSettings()
  const configured = new Set(settings.providers.map((p) => p.id))
  const catalog = catalogForPlatform(isMac).filter((e) => !configured.has(e.id))

  deps.io.out(`${renderCatalogMenu(catalog, paint)}\n`)
  const ans = await deps.io.readLine(paint('host › ', 'green'))
  if (ans === null) return null
  const choice = parseCatalogChoice(ans, catalog.length)
  if (choice.kind === 'cancel') {
    deps.io.out(paint('· cancelled\n', 'dim'))
    return null
  }
  if (choice.kind === 'host') {
    const entry = catalog[choice.index]
    const base = catalogEntryToProvider(entry)
    // The cloud kinds need an address (a region, a project, an Azure endpoint)
    // before they can reach a host. Ask now: `createProvider` otherwise refuses at
    // request time, which surfaces as an error on a turn the user thought would
    // work — long after the moment they knew the answer.
    const provider = await promptSetupFields(base, deps, paint)
    if (!provider) return null
    deps.updateSettings({ providers: [...settings.providers, provider] })
    const at = provider.baseUrl ?? provider.endpoint ?? provider.region ?? provider.resource
    deps.io.out(paint(`· Added ${entry.label} (${entry.id})${at ? ` at ${at}` : ''}.\n`, 'dim'))
    return { provider, keyUrl: entry.docsUrl }
  }

  // Custom endpoint — label + base URL, mirroring the GUI's add-endpoint.
  const label = await deps.io.readLine('Label for this endpoint (e.g. My Router): ')
  if (label === null) return null
  const url = await deps.io.readLine('Base URL (e.g. https://router.internal/v1): ')
  if (url === null) return null
  const err = customEndpointError(label, url)
  if (err) {
    deps.io.out(paint(`· ${err}\n`, 'yellow'))
    return null
  }
  const provider = customEndpointToProvider(customProviderId(newId()), label.trim(), url.trim())
  deps.updateSettings({ providers: [...settings.providers, provider] })
  deps.io.out(paint(`· Added ${provider.label} (${provider.id}) at ${provider.baseUrl}.\n`, 'dim'))
  return { provider }
}

/** Ask every host for its models at once. Empty when the client can't probe. */
async function probeHosts(
  hosts: ProviderConfig[],
  deps: TuiDeps,
  paint: Painter
): Promise<Map<string, HostProbe>> {
  const probes = new Map<string, HostProbe>()
  const list = deps.listModels
  if (!list || !hosts.length) return probes
  deps.io.out(paint('· checking local and added hosts…\n', 'dim'))
  const results = await Promise.allSettled(hosts.map((p) => list(p)))
  results.forEach((r, i) => {
    probes.set(hosts[i].id, r.status === 'fulfilled' ? { ok: true, models: r.value } : { ok: false })
  })
  return probes
}

/** What to do to get a host that did not answer, or answered with no models, going. */
function hostHint(p: ProviderConfig, probe: HostProbe | undefined): string {
  const name = p.label ?? p.id
  const running = probe?.ok === true
  if (p.id === 'ollama') {
    return running
      ? 'Ollama is running but has no models yet. Pull one (for example: ollama pull qwen3), then /login.'
      : `Ollama isn't answering at ${p.baseUrl}. Start it (ollama serve), then /login.`
  }
  if (p.id === 'lmstudio') {
    return running
      ? 'LM Studio is running but has no model loaded. Load one, then /login.'
      : `LM Studio isn't answering at ${p.baseUrl}. Start its local server, then /login.`
  }
  return running ? `${name} answered but listed no models.` : `${name} didn't answer at ${p.baseUrl}.`
}

/**
 * Use a host that needs no key: save the models it reported and select one. A built-in
 * local server that isn't running gets a hint; any other host can still be used by
 * typing a model id, since not every server lists its models.
 */
async function selectHost(
  provider: ProviderConfig,
  probe: HostProbe | undefined,
  deps: TuiDeps,
  paint: Painter
): Promise<{ providerId: string; model: string } | null> {
  const name = provider.label ?? provider.id
  let models = probe?.ok && probe.models.length ? probe.models : provider.models
  if (!models.length) {
    deps.io.out(paint(`· ${hostHint(provider, probe)}\n`, 'yellow'))
    if (provider.builtIn) return null
    const typed = await deps.io.readLine(paint(`Model id to use on ${name} (Enter to cancel): `, 'dim'))
    const id = typed?.trim()
    if (!id) {
      deps.io.out(paint('· nothing changed\n', 'dim'))
      return null
    }
    models = [{ id }]
  }
  const model = pickDefaultModel({ ...provider, models })
  if (!model) return null
  if (deps.updateSettings) {
    const current = deps.getSettings().providers
    // Save what the host reported, so the next launch starts on it with no setup.
    if (models !== provider.models) {
      deps.updateSettings({ providers: current.map((p) => (p.id === provider.id ? { ...p, models } : p)) })
    }
    deps.updateSettings({ selected: { providerId: provider.id, model } })
  }
  deps.io.out(
    paint(
      `· Model set to ${provider.id} / ${model}.${models.length > 1 ? ' /model lists the others.' : ''}\n`,
      'dim'
    )
  )
  return { providerId: provider.id, model }
}

/** The slice of the terminal's deps that /login edit|remove|forget-key and /model refresh use. */
function providerCommandDeps(deps: TuiDeps, providerId: string | null, model: string | null): ProviderCommandDeps {
  return {
    getSettings: deps.getSettings,
    ...(deps.updateSettings ? { updateSettings: deps.updateSettings } : {}),
    ...(deps.removeKey ? { removeKey: deps.removeKey } : {}),
    ...(deps.fetchModels ? { fetchModels: deps.fetchModels } : {}),
    readLine: deps.io.readLine,
    ...(deps.io.readSecret ? { readSecret: deps.io.readSecret } : {}),
    ...(deps.canStoreHeaderSecrets !== undefined ? { canStoreHeaderSecrets: deps.canStoreHeaderSecrets } : {}),
    ...(providerId ? { activeProviderId: providerId } : {}),
    ...(model ? { activeModel: model } : {}),
    out: (t) => deps.io.out(t)
  }
}

/**
 * The /login driver: pick a provider (or add a host), paste a key (hidden), and have
 * it take effect immediately. Returns the provider+model to switch to when setup
 * yields a usable model, or null when the user cancels/skips or only added a
 * model-less host (the caller then stays put / drops into the gated REPL). The caller
 * guards on deps.setKey before invoking this.
 */
async function runProviderSetup(
  deps: TuiDeps,
  paint: Painter,
  newId: () => string,
  o: { firstRun: boolean }
): Promise<{ providerId: string; model: string } | null> {
  const settings = deps.getSettings()
  const providers = keyableProviders(settings)
  // Only suggest hosts that aren't already configured, so the Other-host hint can't
  // name a provider already shown in the list above.
  const isMac = deps.isMac ?? process.platform === 'darwin'
  const configured = new Set(settings.providers.map((p) => p.id))
  const addable = catalogForPlatform(isMac).filter((e) => !configured.has(e.id))
  // Local servers and added endpoints: ask each for its models first, so the menu can
  // say which are running (and a pick can use one straight away).
  const hosts = hostProviders(settings)
  const probes = await probeHosts(hosts, deps, paint)
  deps.io.out(
    `${renderProviderMenu(providers, paint, {
      firstRun: o.firstRun,
      otherHostExamples: otherHostExamples(addable),
      hosts: hosts.map((p) => ({ provider: p, ...(probes.has(p.id) ? { probe: probes.get(p.id) } : {}) }))
    })}\n`
  )
  const ans = await deps.io.readLine(paint(o.firstRun ? 'setup › ' : 'login › ', 'green'))
  if (ans === null) return null
  const choice = parseProviderMenuChoice(ans, providers.length + hosts.length)
  if (choice.kind === 'cancel') {
    deps.io.out(paint('· no provider selected\n', 'dim'))
    return null
  }
  if (choice.kind === 'provider') {
    if (choice.index >= providers.length) {
      const host = hosts[choice.index - providers.length]
      return selectHost(host, probes.get(host.id), deps, paint)
    }
    const target = providers[choice.index]
    return keyEntryFor(target, deps, paint, providerKeyUrl(target.id))
  }
  const added = await addHostInteractive(deps, paint, newId)
  if (!added) return null
  return keyEntryFor(added.provider, deps, paint, added.keyUrl)
}

// --- The interactive driver --------------------------------------------------

/** An image pasted at the composer: the clipboard's, or files named by a paste. */
export type ImagePasteRequest = { kind: 'clipboard' } | { kind: 'files'; paths: string[] }

/** Whether the driver took the paste as images, and what to print about it. */
export interface ImagePasteResult {
  handled: boolean
  notes: string[]
}

/** Abstract terminal I/O, so the driver runs headless in tests. */
export interface TuiIo {
  /** Print to the main output stream (stdout). */
  out: (s: string) => void
  /** Erase the current terminal line (the abandoned composer input on Ctrl-C). */
  clearLine?: () => void
  /**
   * Draw the adapter's own parts (the spinner, the picker, the composer's marks and
   * menus) with the session's theme. Called at startup and on `/theme`; absent in
   * tests and off-TTY, where those parts are not drawn.
   */
  setPaint?: (paint: Painter) => void
  /**
   * Read one line, showing `prompt`. Resolves null on end-of-input (Ctrl-D),
   * which ends the session. Used for the composer, approvals, and questions
   * alike — the driver only ever has one read outstanding at a time.
   *
   * `discardPending` drops any input buffered before the prompt is shown. The
   * driver sets it for security-sensitive reads (approvals, questions) so
   * type-ahead the user entered while output was streaming can't silently answer
   * a prompt they never saw.
   *
   * `initial` opens the line with that text already typed (the key that turned a
   * picker into a typed answer).
   */
  readLine: (prompt: string, opts?: { discardPending?: boolean; initial?: string }) => Promise<string | null>
  /**
   * Read a whole composer message: the raw-mode line editor, which supports
   * bracketed paste (a multi-line paste lands as ONE editable block instead of
   * submitting its first line and replaying the rest), multi-line editing, Ctrl-R
   * history search, and an $EDITOR hand-off. Resolves the message, or null on
   * end-of-input / an interrupt (which routes through `onInterrupt` first, so the
   * driver's discard-vs-exit double-tap still applies).
   *
   * Optional: off-TTY and in tests it's absent and the driver falls back to
   * `readLine` + ComposerBuffer, which reads one physical line at a time.
   * `initial` opens the editor with that draft already typed (unsent text handed
   * back after an interrupt).
   */
  readComposer?: (
    prompt: string | (() => string),
    initial?: string,
    opts?: {
      ultrathinkEffect?: () => UltrathinkEffect
      onDraft?: (text: string) => void
      /**
       * Rows shown above the prompt and redrawn with it (the custom status line). Off a
       * raw-mode composer they print once, before the prompt.
       */
      header?: () => string[]
      /** The suggested next message, shown dim in an empty composer; Tab takes it. */
      suggestion?: () => string | undefined
      /** Subscribe a redraw for when the suggestion arrives; returns the unsubscribe. */
      watchSuggestion?: (redraw: () => void) => () => void
    }
  ) => Promise<string | null>
  /**
   * Repaint the open composer so its header is current. No-op when no raw-mode
   * composer is on screen. Absent off-TTY and in tests.
   */
  redrawComposer?: () => void
  /**
   * Tell the terminal what the turn is doing (OSC 9;4 progress, OSC 7501 status),
   * where the session's progress setting and the terminal allow it; never in
   * screen-reader mode. `label` names the session (its chat title or project).
   * Absent off-TTY and in tests.
   */
  progress?: (state: ProgressState, label?: string) => void
  /**
   * Read a line without echoing it — for pasting an API key in the `/login` flow.
   * Resolves the typed value, or null on cancel (Ctrl-C) / EOF. Optional: off-TTY
   * and in tests it's absent, and the driver falls back to `readLine` (the value
   * still never reaches composer history, which only records real prompt lines).
   */
  readSecret?: (prompt: string) => Promise<string | null>
  /**
   * Register a handler for an interrupt (Ctrl-C). The driver uses it to cancel
   * the in-flight run without exiting. Optional so tests can drive interrupts
   * directly.
   */
  onInterrupt?: (handler: () => void) => void
  /**
   * Resolve any in-flight `readLine` with null. Called on interrupt so an
   * approval/question prompt awaiting input can't outlive the run it belongs to
   * and hang the loop. No-op when nothing is being read.
   */
  cancelRead?: () => void
  /**
   * Close the open composer read (it resolves null) when nothing is typed in it, so a
   * turn Houston starts on its own can run. Returns whether it closed one; false when
   * no raw-mode composer is open or the user has started typing (their draft wins).
   */
  yieldComposer?: () => boolean
  /**
   * Show a single-line activity spinner with an elapsed timer while a turn runs,
   * so a slow first token or a silent tool doesn't look like a hang. The adapter
   * redraws only that one line and erases it before any real output. All three are
   * optional and no-ops off-TTY / in tests (the driver never depends on them).
   */
  startSpinner?: (label: string) => void
  setSpinnerLabel?: (label: string) => void
  /** The turn's output tokens so far (reported plus the open round's estimate). */
  setSpinnerTokens?: (tokens: number) => void
  stopSpinner?: () => void
  /**
   * Switch the accessibility modes the adapter owns. `reduceMotion` keeps the spinner
   * still: a fixed mark, its elapsed time refreshed only every few seconds.
   * `screenReader` makes every write a plain line: no spinner (its label changes
   * print once), no redraws, no escapes, an append-only composer, and pickers as
   * numbered lists answered by typing the number.
   */
  setAccessibility?: (a: { screenReader?: boolean; reduceMotion?: boolean }) => void
  /**
   * Emit an attention signal: set the tab/window title, and — only when the user
   * has switched away — ring the bell and fire the terminal's notification. This
   * is what makes a long unattended run trustworthy: a session that blocks on an
   * approval used to sit silent, so the only way to notice was to keep looking.
   * Optional; absent off-TTY and in tests.
   */
  signal?: (sig: TerminalSignal) => void
  /**
   * A turn just finished: if the user is away, send `spec` once more after `ms`
   * (default about a minute) unless they type or come back to the window first.
   * Replaces any reminder already armed. Optional; absent off-TTY and in tests.
   */
  remindIfIdle?: (spec: NotifySpec, mode: NotifyMode, ms?: number) => void
  /**
   * Take (and clear) the messages typed while the agent was working, for dispatch
   * as the next turn. Absent off-TTY / in tests, where nothing is queued.
   */
  /**
   * Register the handler for a line typed while a turn runs (Enter). It returns true
   * when the live turn took the line as a course correction under `id`; false sends
   * it to the follow-up queue instead; `'handled'` when it was acted on and is not
   * waiting on anything (a `/tasks` mid-run). Absent ⇒ everything queues.
   */
  onSteer?: (handler: (text: string, id: string) => boolean | 'handled') => void
  /** Register the handler that takes a steer back from the live run before it lands. */
  onUnsteer?: (handler: (id: string) => boolean) => void
  /** The steer saved under `id` reached the model: it leaves the waiting list. */
  steerLanded?: (id: string) => void
  /**
   * Register the handler told when the mid-run draft or the waiting messages change,
   * so they can be saved; `acked` when a message was just shown as queued or steered.
   */
  onPendingInput?: (handler: (p: { draft: string; queued: string[] }, acked: boolean) => void) => void
  /** /queue: the follow-ups waiting for after the turn, oldest first. */
  peekQueued?: () => string[]
  /** /queue drop: remove the n-th (0-based) waiting follow-up; its text, or null. */
  dropQueued?: (index: number) => string | null
  /** /queue send: hand the n-th (0-based) follow-up to the running turn now; false if it can't take it. */
  sendQueuedNow?: (index: number) => boolean
  /** /queue clear: drop every waiting follow-up; what was dropped. */
  clearQueued?: () => string[]
  takeQueued?: () => string[]
  /**
   * Take (and clear) the line typed while the agent was working but not yet sent:
   * it opens the next composer, rather than being thrown away when the turn ends.
   */
  takeDraft?: () => string
  /**
   * Register a handler for Shift-Tab (cycle the approval mode). Fires at the
   * composer and mid-run alike; the driver decides what cycling means.
   */
  onCycleMode?: (handler: () => void) => void
  /**
   * Register the handler for an image pasted at the composer: Ctrl-V / Alt-V (the
   * clipboard image), or a paste that is nothing but image file paths (a file
   * dragged onto the terminal arrives that way). The driver stages the images and
   * returns the notes to print; `handled: false` means "not images after all, paste
   * the text".
   */
  onImagePaste?: (handler: (req: ImagePasteRequest) => ImagePasteResult) => void
  /**
   * Register the handler for Esc Esc on an empty composer. The composer read then
   * resolves null, and the driver opens the /rewind picker instead of exiting.
   */
  onRewindKey?: (handler: () => void) => void
  /**
   * Show the approval mode on the spinner line while a turn runs — the composer's
   * status line is gone exactly when it matters most.
   */
  setMode?: (label: string) => void
  /**
   * The rest of the status line (model, branch, context use), shown on the spinner
   * line while a turn runs so it does not vanish with the composer.
   */
  setStatus?: (status: string) => void
  /**
   * Present an arrow-key selectable picker (for approvals / `ask_user`). Resolves
   * with the committed value, a request to fall back to typing, or a cancel.
   * Optional — when absent (off-TTY / tests) the driver uses the typed prompt.
   */
  select?: (spec: PickerSpec) => Promise<PickerOutcome>
  /**
   * The transcript viewer: `source` full screen on the alternate screen until the
   * user closes it. Resolves false when it could not open (no terminal). Output
   * written meanwhile is held and printed, in order, when it closes. Absent off-TTY
   * and in tests.
   */
  pager?: (source: PagerSource) => Promise<boolean>
  /**
   * Register the handler for Ctrl-O: at the composer (which is restored as it was
   * once the handler settles) or mid-run, as `during` says.
   */
  onTranscript?: (handler: (during: 'composer' | 'run') => Promise<void>) => void
  /** Register the handler for Alt-T (cycle the reasoning display), at the composer or mid-run. */
  onCycleThoughts?: (handler: () => void) => void
  /** Register the handler for Ctrl-B mid-run (move the running command to the background). */
  onBackground?: (handler: () => void) => void
  /**
   * Rows drawn under the spinner line while a turn runs (the subagents at work),
   * rendered at each redraw for the terminal's width so elapsed times stay current;
   * null removes them. Redrawn in place under synchronized output. A no-op in
   * screen-reader mode, where the driver prints plain step lines instead.
   */
  setLivePanel?: (render: ((width: number) => string[]) | null) => void
  /** Register the handler for Enter on an empty line mid-run while the live panel shows. */
  onOpenLivePanel?: (handler: () => Promise<void>) => void
}

export interface TuiDeps {
  getSettings: () => AppSettings
  /** Run just before the farewell on a clean exit (the host waits on background sessions). */
  beforeExit?: () => Promise<void>
  startRun: (
    req: AgentRunRequest,
    send: (e: AgentEvent) => void,
    onMessages?: (messages: ChatMessage[]) => void
  ) => Promise<void>
  /**
   * Deliver the user's verdict, plus any guidance they attached ("no, do X
   * instead"), which the loop hands to the model with the refusal.
   */
  resolveApproval: (
    runId: string,
    callId: string,
    decision: ToolApprovalDecision,
    note?: string
  ) => void
  resolveQuestion: (runId: string, callId: string, answer: string) => void
  /** Deliver the user's verdict on a `present_plan` review (accept / suggest / reject). */
  resolvePlan: (runId: string, callId: string, decision: PlanDecision) => void
  /** Deliver the user's answer to an MCP server's mid-call input request. */
  resolveElicitation: (runId: string, elicitId: string, result: ElicitationResult) => void
  cancelRun: (runId: string) => void
  /**
   * Change a RUNNING turn's approval policy. The core has always supported this
   * (the GUI switches mid-run); the terminal could only change the policy for the
   * next turn, so loosening it to get past a wall meant interrupting the work you
   * were trying to unblock.
   */
  setRunPolicy?: (runId: string, policy: ApprovalPolicy) => void
  /** Retarget a running turn's reasoning effort (its next model turn), like setRunPolicy. */
  setRunEffort?: (runId: string, effort: ReasoningEffort) => void
  /**
   * Move a run's foreground run_shell command to the background (Ctrl-B): its tool call
   * returns at once and the process goes on as a background shell. Returns how many
   * commands were moved; 0 when none was running.
   */
  backgroundShells?: (runId: string) => number
  /**
   * Hand a running turn a course correction, seen before its next step. Returns
   * false when the run is already over (nothing to steer), which is what lets the
   * caller fall back to sending the line as its own turn. Absent ⇒ no steering, and
   * a line typed mid-run queues as a follow-up.
   */
  steerRun?: (runId: string, text: string, id?: string) => boolean
  /** Take a steer back before the run reads it; false when it already landed. */
  unsteerRun?: (runId: string, id: string) => boolean
  /**
   * Where each chat's unsent draft is saved (see tui-drafts.ts), so a quit, a Ctrl-C
   * or a /resume doesn't lose it. Absent ⇒ drafts live only as long as the process.
   */
  drafts?: DraftStore
  io: TuiIo
  /**
   * Optional persistence. When present, each session is saved as a conversation
   * (resumable with `/resume`, visible in the GUI); when absent, the session is
   * ephemeral — kept only in memory, exactly like a one-shot headless run.
   */
  persist?: TuiPersist
  newId?: () => string
  /** Clock for relative timestamps; injectable for tests. Defaults to Date.now. */
  now?: () => number
  /** Terminal width for the status line + wrapping; injectable. Defaults to 80. */
  columns?: () => number
  /** Persist a submitted composer line to history (for Up/Down across restarts). */
  persistHistory?: (line: string) => void
  /** Snapshot of the workspace's skills / agents / MCP servers / hooks, for /mcp etc. */
  capabilities?: () => Promise<CapabilitySnapshot>
  /** Load the workspace's custom `.houston/commands`, so `/<name>` runs one as a turn. */
  commands?: () => Promise<Command[]>
  /**
   * The connected MCP servers' prompts as `/mcp__<server>__<prompt>` commands (this
   * folder's own servers only), and how to fetch one. Read when such a line is typed.
   */
  mcpPrompts?: { commands: () => Promise<Command[]>; fetch: McpPromptFetch }
  /**
   * Run one of a command template's `` !`command` `` pieces. Absent: the user's own
   * shell, bounded in time and output (tests inject a fake).
   */
  runContextShell?: (command: string) => Promise<ShellCapture>
  /**
   * Replace part of a chat with a summary (the rewind picker's "Summarize from here" and
   * "Summarize up to here"), saved so `/rewind undo` reverses it. Absent: not offered.
   */
  summarize?: (
    id: string,
    providerId: string,
    model: string,
    part: { turn: number; text: string; side: 'from' | 'before' },
    opts?: CompactOptions
  ) => Promise<CompactResult>
  /**
   * Fill in a message's `@path#20-45`, `@server:uri` and `@agent-<name>` mentions
   * before it is sent (see agent/messageMentions.ts). `confirm` asks before a
   * credential file is read; `addDirs` are the folders /add-dir added this session,
   * which a file may also be in. Absent: every mention stays text.
   */
  expandMentions?: (
    text: string,
    opts: { confirm: (consent: ContextConsent) => Promise<boolean>; addDirs: string[] }
  ) => Promise<MessageMentionResult>
  /** Compact the given conversation on demand (the `/compact` command). */
  compact?: (id: string, providerId: string, model: string, opts?: CompactOptions) => Promise<CompactResult>
  /** Persist a settings patch (for /hooks and /mcp editing). Absent ⇒ editing disabled. */
  updateSettings?: (patch: Partial<AppSettings>) => void
  /** The calls denied at an approval prompt this session, newest first (for /permissions). */
  recentDenials?: () => RecentDenial[]
  /**
   * Save the allow rules "Always allow" would have saved for a recent denial (by its id),
   * and drop it from the list. Null when it is no longer listed. `deniedByRule` says a
   * saved deny rule still matches it, which wins over any allow.
   */
  allowRecentDenial?: (id: string) => { added: PermissionRule[]; deniedByRule: boolean } | null
  /**
   * OAuth sign-in/out for remote MCP servers (the `/mcp login|logout <n>` verbs).
   * `login` runs the interactive browser flow for the server and persists the
   * minted tokens; `onStatus` receives user-facing progress lines (including the
   * authorize URL fallback). Absent ⇒ the verbs report sign-in as unavailable.
   */
  mcpOAuth?: {
    login: (server: McpServerConfig, onStatus: (message: string) => void) => Promise<void>
    logout: (serverId: string) => void
  }
  /** Live per-server connection status for `/mcp` (from the MCP manager). */
  mcpStatuses?: () => McpServerStatus[]
  /** Read-only MCP Registry client for `/mcp search` and `/mcp add-from-registry`. Absent ⇒ unavailable. */
  mcpRegistry?: {
    search: (query: string, cursor?: string) => Promise<RegistrySearchResult>
    get: (name: string) => Promise<RegistryGetResult>
  }
  /**
   * Restart the named servers' connections now (`/mcp reconnect`), resolving to their
   * new statuses. Absent ⇒ the verb says a changed server reconnects on the next message.
   */
  mcpReconnect?: (ids: string[]) => Promise<McpServerStatus[]>
  /**
   * Whether this host persists secret VALUES (headers / stdio env) from settings
   * saves. False on the standalone CLI, whose store keeps only the keys — the
   * /mcp add flow then tells the user where the values actually go.
   */
  canStoreHeaderSecrets?: boolean
  /**
   * Persist an API key for a provider (the `/login` flow). Returns the env var
   * currently shadowing the id, if any, so the driver can warn. Absent ⇒ no
   * writable key store, so `/login` and the keyless-start wizard are disabled and
   * the driver falls back to printing the missing-key error.
   */
  setKey?: (id: string, key: string) => { shadowedByEnv: string | null }
  /**
   * The administrator's and this folder's permission rules (with the folder's trust),
   * read as the desktop's Settings > Permissions reads them. Absent ⇒ /permissions
   * shows only the user's own rules.
   */
  permissionPolicy?: () => Promise<PermissionPolicyView>
  /** When each permission rule last decided a call, keyed by permissionRuleKey. */
  ruleUsage?: () => Record<string, number>
  /** The scheduler service the host wired, for /schedule. Absent ⇒ the command says it's unavailable. */
  schedules?: ScheduleBackend
  /** Forget a stored API key (`/login forget-key`); true if one was removed. Absent ⇒ unavailable. */
  removeKey?: (id: string) => boolean
  /**
   * Ask a provider for its full model list (`/model refresh`), with a longer wait
   * than the setup menu's quick `listModels` probe. Absent ⇒ the verb says it's unavailable.
   */
  fetchModels?: (provider: ProviderConfig) => Promise<ModelOption[]>
  /** Whether the host is macOS — filters the provider catalog (e.g. oMLX). Defaults to the current platform. */
  isMac?: boolean
  /** The verification command a folder suggests, for /settings. Defaults to the real inference. */
  inferVerifyCommand?: (cwd: string) => { command: string; source: string } | null
  /** Absolute path to settings.json, shown by /settings, /hooks, and /mcp. */
  settingsPath?: () => string
  /** What only the host knows for /status (install method, sandbox, this chat's network, managed policy). */
  statusFacts?: (conversationId: string | null) => Promise<HostStatusFacts>
  /** The desktop's issue report, for /feedback. Absent ⇒ /feedback says it's unavailable. */
  issueReport?: IssueReportHost
  /** Read + validate an image file for `/image`; returns the attachment or an error. */
  loadImage?: (path: string) => { image: ImageAttachment } | { error: string; missing?: boolean }
  /**
   * The image on the system clipboard, for a bare `/image`. The desktop app has
   * had this forever through Electron; the terminal shells out to whatever the
   * platform ships, since the whole vision path already works and only the bytes
   * were missing. Absent ⇒ the command says to use `/image <path>`.
   */
  clipboardImage?: () => { image: ImageAttachment } | { error: string }
  /**
   * Put text on the system clipboard through the platform's own helper, for
   * `/copy`. True when it took the text. Absent (or false, as over SSH) leaves
   * OSC 52, which the command always sends too.
   */
  copyText?: (text: string) => boolean
  /**
   * The session's working folder moved (`/cd`): whatever the host keeps per folder (the
   * command menu, composer history) follows it. `TuiOptions.cwd` already holds the new one.
   */
  onCwdChange?: (cwd: string) => void
  /**
   * A masker for text leaving the machine (`/export`): the transcript redacter, bound to
   * this install's stored secret values. Absent: the redacter's patterns alone.
   */
  secretRedactor?: () => (text: string) => string
  /**
   * The user's keybindings file, for `/keybindings` and for reporting its mistakes.
   * Absent ⇒ the command says keybindings are unavailable here.
   */
  keybindings?: {
    /** Where the file is. */
    path: string
    /** Create the file with a commented template when it is missing. */
    ensureFile: () => { created: boolean }
    /** Read it again now (it is also read whenever it changes). */
    reload: () => void
    /** Problems found since the last call, each a line; cleared by the call. */
    takeProblems: () => string[]
    /** What is wrong with the file as last read, each a line. */
    problems: () => string[]
    /** Called when a later read of the file found problems to report. */
    onProblems: (cb: () => void) => void
    /** How many bindings are in force, for the line after a reload. */
    count: () => number
  }
  /**
   * Open a file in the user's `$VISUAL`/`$EDITOR` (for `/keybindings`). Resolves
   * false when no editor is set or it failed.
   */
  editFile?: (path: string) => Promise<boolean>
  /**
   * Spend and tokens per day and per project over the chats saved on this computer,
   * for `/usage` (the desktop usage view's report). Absent ⇒ the command says so.
   */
  usageReport?: () => UsageReport
  /** The loop scorecard over the chats saved on this computer, for `/scorecard`. Absent ⇒ unavailable. */
  scorecard?: () => Scorecard
  /**
   * Open `initial` text in the user's `$VISUAL`/`$EDITOR` and return the edited
   * result (null if no editor is configured or the edit was aborted). Used by the
   * plan-review "edit" action so the user can revise a plan in a real editor.
   */
  editText?: (initial: string) => Promise<string | null>
  /**
   * The running version, shown in the banner and by /doctor. A terminal user
   * otherwise has no way to tell which build they are on — which matters most
   * exactly when something is broken and they are reporting it.
   */
  version?: string
  /** Why theme files under ~/.houston/themes were skipped, listed by /theme. */
  themeErrors?: string[]
  /**
   * Run the custom status line command (the `statusLine` setting) in the user's shell,
   * with `input` on stdin, bounded in time and output. Absent: the setting is ignored
   * and the built-in status line shows.
   */
  runStatusLine?: StatusLineExec
  /**
   * A project's own `statusLine` (from its `.houston/settings.json`), and whether the
   * folder is trusted to run it. Read once at launch. Absent: no project command.
   */
  projectStatusLine?: () => Promise<{ config: StatusLineConfig | null; trusted: boolean }>
  /**
   * Ask for a model-written title for a chat still on its placeholder (as the desktop
   * app does), calling `onTitle` once it is saved. Fire-and-forget; absent: chats keep
   * the title derived from their first message.
   */
  generateTitle?: (conversationId: string, providerId: string, model: string, onTitle: (title: string) => void) => void
  /**
   * Run a command in the USER's shell for `!cmd` — unsandboxed, in the workspace,
   * with their environment. Streams output through `onOutput`; resolves the exit
   * code. Absent ⇒ `!` reports that the shell escape is unavailable.
   *
   * Deliberately NOT the agent's sandboxed shell. The sandbox confines the AGENT,
   * which may be prompt-injected; a command the user typed is their own intent —
   * they could run it in another window — and confining it would only surprise
   * them (`!git push` failing offline, `!npm i` unable to write).
   */
  runUserShell?: (command: string, onOutput: (chunk: string) => void) => Promise<number>
  /**
   * The background sessions the agent spawned from this chat (`spawn_session`),
   * so `/spawned` can list and open them. Absent ⇒ the command says fan-out
   * isn't available here.
   */
  backgroundSessions?: () => BackgroundSession[]
  /**
   * The background shell registry (`run_shell` background mode) and the subagent stop
   * handles, for `/tasks`. Absent ⇒ /tasks lists the subagents it saw and says shells
   * are unavailable here.
   */
  backgroundTasks?: {
    /** Every background shell this process started (the driver keeps this chat's). */
    shells: () => BackgroundShellInfo[]
    /** A shell's last lines, secrets masked; moves no read cursor. Undefined when unknown. */
    shellTail: (id: string, maxLines: number) => string[] | undefined
    /** Stop a shell the way the desktop's Stop does: SIGTERM, then SIGKILL after a grace. */
    killShell: (id: string) => KillShellOutcome
    /** Stop one running subagent of a run; false when it can't be (finished, or a reviewer). */
    stopSubagent: (runId: string, recordId: string) => boolean
  }
  /**
   * The chat's `propose_session` cards and what to do with them (`/proposals`).
   * Absent ⇒ the command says proposals are unavailable here.
   */
  proposals?: {
    list: (conversationId: string) => TuiProposal[]
    start: (
      conversationId: string,
      callId: string,
      policy: ApprovalPolicy
    ) => Promise<{ conversationId: string; title: string }>
    decide: (conversationId: string, callId: string, status: 'here' | 'dismissed') => void
  }
  /**
   * The saved chat's side chat (`/btw`): a read-only aside, stored with the chat and
   * shared with the desktop app's side chat panel. Its answers are printed, never
   * added to the chat. Absent ⇒ unavailable here.
   */
  sideChat?: {
    ask: (input: {
      conversationId: string
      question: string
      providerId: string
      model: string
    }) => Promise<{ answer?: string; error?: string }>
    /** Start the chat's side chat over (`/btw clear`). */
    clear: (conversationId: string) => void
    /** The chat's stored side-chat exchanges, oldest first (a bare `/btw` reprints the latest). */
    recent?: (conversationId: string) => SideChatTurn[]
    /** Stop the chat's in-flight side chat answer (Ctrl-C / Esc while it works). */
    cancel?: (conversationId: string) => void
  }
  /**
   * Append a standing instruction to the project's or the user's rules file (the
   * `#` capture). Returns the path written, so the user can see where it went —
   * a note that vanished into an unnamed file is worse than no note.
   */
  saveMemory?: (scope: MemoryScope, text: string) => Promise<string>
  /** The cross-session memory store for this folder, for /memory. Absent ⇒ /memory says it's unavailable. */
  memoryStore?: () => MemoryStore
  /**
   * Roll the last turn's file writes back (or forward again). Houston snapshots
   * every write already; this is the terminal's way in. Absent ⇒ /undo says so.
   */
  checkpoint?: {
    info: (conversationId: string) => Promise<CheckpointInfo | null>
    undo: (runId: string) => Promise<number>
    redo: (runId: string) => Promise<number>
  }
  /**
   * Hand a saved chat to the desktop app (a `houston://chat/<id>` link through the
   * OS's URL handler). Absent ⇒ /open-in-app says it is unavailable.
   */
  openInApp?: (conversationId: string) => Promise<void>
  /**
   * The desktop app's suggested next message, through the same helper its run drain
   * uses (agent/drain.ts), which checks the suggestNextPrompt setting itself.
   * Best-effort, never blocks a turn. Absent ⇒ no suggestion. (Titles: generateTitle.)
   */
  chatAssist?: {
    suggest: (conversationId: string, providerId: string, model: string, onSuggestion: (text: string) => void) => void
  }
  /**
   * `/import <file>`: save a JSON or HTML chat export as a new chat in this folder
   * (tui-import.ts). Throws with the reason to show. Absent ⇒ /import is unavailable.
   */
  importChat?: (path: string) => ImportedChat
  /**
   * Rewind the chat to an earlier message (agent/rewind.ts): preview, apply, undo.
   * Absent ⇒ /rewind says it is unavailable.
   */
  rewind?: {
    preview: (conversationId: string, turn: number, mode: RewindMode, text: string) => Promise<RewindPreviewResult>
    apply: (conversationId: string, turn: number, mode: RewindMode, text: string) => Promise<RewindResult>
    undo: (conversationId: string) => Promise<UndoRewindResult>
  }
  /**
   * Ask a host for its models (with a short timeout), so the setup menu can show
   * which local servers and added endpoints are running. Rejects when the host does
   * not answer. Absent ⇒ hosts are listed without a probe.
   */
  listModels?: (provider: ProviderConfig) => Promise<ModelOption[]>
  /**
   * The checked-out branch for the status line; null outside a repo. Absent ⇒ no branch
   * shown. Read before every status line and never waited for: a value shows at once, a
   * promise shows on the status line after it settles.
   */
  gitBranch?: () => string | null | Promise<string | null>
  /**
   * Write an export (`/export`) to `path`, relative to the working folder, without
   * replacing an existing file. Returns the full path written; throws on failure.
   */
  writeExport?: (path: string, content: string) => string
  /** The desktop's commit, push, and pull-request handlers, for /commit, /push, /ship, /pr. */
  git?: GitDeps
  /** The Changes view's scopes and revert, for /changes. */
  changes?: ChangesDeps
  /**
   * Probe the environment for /doctor (binaries, sandbox backend, MCP state).
   * Absent ⇒ the command reports that diagnostics are unavailable.
   */
  doctor?: () => Promise<DoctorFacts>
  /**
   * Look for a newer release, or null. Never awaited before the prompt: the
   * result is surfaced at the next composer draw, so a slow feed can't delay
   * startup and a write can't land in the middle of the composer's region.
   */
  checkUpdate?: () => Promise<{ latest: string; url: string; headline?: string; hint?: string } | null>
  /**
   * Optional one-time "global rules moved" check: true when the notice should be
   * shown this launch. The host records it as shown when it says so, so it prints
   * at most once ever. That record is the terminal's own: the desktop banner (with
   * its Import it button) still shows until it is answered there.
   */
  takeLegacyRulesNotice?: () => boolean
  /**
   * Optional one-time "What's new" after an upgrade: the bundled highlights when the
   * terminal last ran an older version, else null. The host records the version, so
   * it prints once per upgrade (the desktop app keeps its own record).
   */
  takeWhatsNew?: () => { version: string; highlights: string } | null
  /**
   * Optional waking of this session when background work it started finishes while
   * the composer sits idle (see agent/backgroundEvents.ts). `register` installs the
   * driver's handler (`tryWake` says whether it took the wake); `take` takes the
   * chat's waiting news as the automated note that opens the turn, or null.
   */
  wake?: {
    register: (tryWake: (conversationId: string) => boolean) => void
    /**
     * The note's text, or the note with its {@link ChatMessage.taintSource} (a note
     * quoting spawned sessions' reports), which the turn's message keeps.
     */
    take: (conversationId: string) => string | Pick<ChatMessage, 'content' | 'taintSource'> | null
  }
  /**
   * Optional syntax highlighter returning highlight.js token HTML for a fenced
   * code block, or null to render it plain. Kept as HTML (not ANSI) so the hljs
   * dependency stays at the entry point and the driver + its tests need no hljs.
   */
  highlightHtml?: (lang: string, code: string) => string | null
}

export { parseShellEscape, renderShellEscapeRecord, SHELL_ESCAPE_MAX_LINES } from '@shared/shellEscape'

/**
 * The next approval mode, in the order they appear in APPROVAL_POLICIES: plan →
 * ask → auto-edit → full-auto → plan.
 *
 * Ordered least-to-most permissive on purpose, so Shift-Tab reads as "loosen",
 * and the wrap lands back on the most restrictive rather than sliding past it.
 */
export function nextPolicy(current: ApprovalPolicy): ApprovalPolicy {
  const i = APPROVAL_POLICIES.indexOf(current)
  return APPROVAL_POLICIES[(i + 1) % APPROVAL_POLICIES.length]
}

/**
 * Whether the active model can reason at all: true / false from the host's
 * capability metadata, or null when it says nothing either way.
 *
 * Worth knowing before promising an effort setting will do something. Turning
 * thinking up on a model that cannot think is the kind of thing that looks like a
 * bug in Houston rather than a fact about the model.
 */
function activeModelReasons(deps: TuiDeps, providerId: string | null, model: string | null): boolean | null {
  if (!providerId || !model) return null
  const p = deps.getSettings().providers.find((x) => x.id === providerId)
  return p?.models.find((m) => m.id === model)?.caps?.reasoning ?? null
}

/** Whether the active provider passes `xhigh` to the active model rather than clamping it. */
function activeModelSendsXhigh(deps: TuiDeps, providerId: string | null, model: string | null): boolean {
  if (!providerId || !model) return false
  const p = deps.getSettings().providers.find((x) => x.id === providerId)
  return p ? providerSendsXhigh(p.kind, model, Boolean(p.baseUrl)) : false
}

/** `/reasoning` with no argument: what it is now, and what it can be. */
export function renderReasoningStatus(
  current: ReasoningEffort,
  modelReasons: boolean | null,
  paint: Painter
): string {
  const lines = [
    `${paint('thinking effort:', 'bold')} ${paint(current, 'cyan')}`,
    paint(`  options: ${REASONING_EFFORTS.join(' | ')}   (usage: /reasoning <effort>)`, 'dim')
  ]
  if (modelReasons === false) {
    lines.push(paint('  the active model does not support reasoning, so this has no effect on it', 'yellow'))
  }
  return lines.join('\n')
}

// `parseMemoryCapture` + `MemoryScope` now live in `@shared/memory` so the desktop
// app recognizes a `#`-capture identically (imported at the top); re-exported here
// so existing callers of the TUI module keep working.
export { parseMemoryCapture, type MemoryScope }

// `parseAgentInvocation` + `agentInvocationPrompt` now live in `@shared/commands`
// and are re-exported so existing callers of the TUI module keep working.
export { parseAgentInvocation, agentInvocationPrompt } from '@shared/commands'

/** Prompt string shown for the composer, reflecting the live approval policy. */
export function composerPrompt(policy: ApprovalPolicy, paint: Painter, screenReader = false, images = 0): string {
  // Staged images ride in front of the prompt, so what the next message will carry is
  // in view while it is typed.
  const staged = images ? `${images === 1 ? '1 image' : `${images} images`}` : ''
  // A screen reader hears who is speaking; the mode is on the status line above.
  if (screenReader) return staged ? `you (${staged}): ` : 'you: '
  return `${staged ? `${paint(`[${staged}]`, 'cyan')} ` : ''}${paint(policy, 'dim')} ${paint('›', 'green')} `
}

/**
 * Run the interactive session to completion, returning an exit code (0 normal
 * exit, 2 terms declined). Keeps conversation context in memory across turns via
 * the run loop's `onMessages` callback; runs are started without a conversation
 * id (like headless), so nothing is persisted and turns can't collide.
 */
/** Pluralized summary of a project's elevating config, e.g. "2 hooks, 1 MCP server". */
export function summarizeElevated(c: {
  allowRules: unknown[]
  hooks: unknown[]
  mcpServers: unknown[]
  commands?: unknown[]
  plugins?: Array<{ name: string }>
  statusLine?: unknown
}): string {
  const commands = c.commands?.length ?? 0
  const plugins = c.plugins ?? []
  return [
    c.allowRules.length ? `${c.allowRules.length} allow rule${c.allowRules.length === 1 ? '' : 's'}` : '',
    c.hooks.length ? `${c.hooks.length} hook${c.hooks.length === 1 ? '' : 's'}` : '',
    c.mcpServers.length ? `${c.mcpServers.length} MCP server${c.mcpServers.length === 1 ? '' : 's'}` : '',
    commands
      ? `${commands} command${commands === 1 ? '' : 's'} that pre-approve${commands === 1 ? 's' : ''} tools or run${commands === 1 ? 's' : ''} shell commands`
      : '',
    // Each plugin file by name: trusting the folder consents to running exactly these.
    plugins.length
      ? `${plugins.length} plugin${plugins.length === 1 ? '' : 's'} (${plugins.map((p) => p.name).join(', ')})`
      : '',
    c.statusLine ? 'a status line command' : ''
  ]
    .filter(Boolean)
    .join(', ')
}

/** Which of the project's files define its elevating config, for the trust prompt. */
export function elevatedSource(c: {
  allowRules: unknown[]
  hooks: unknown[]
  mcpServers: unknown[]
  commands?: unknown[]
  plugins?: unknown[]
  statusLine?: unknown
}): string {
  const settings = c.allowRules.length > 0 || c.hooks.length > 0 || c.mcpServers.length > 0 || Boolean(c.statusLine)
  const commands = (c.commands?.length ?? 0) > 0
  const plugins = (c.plugins?.length ?? 0) > 0
  const sources = [
    settings || (!commands && !plugins) ? '.houston/settings.json' : '',
    commands ? '.houston/commands' : '',
    plugins ? '.houston/plugins' : ''
  ].filter(Boolean)
  return sources.length < 3 ? sources.join(' and ') : `${sources.slice(0, -1).join(', ')}, and ${sources[sources.length - 1]}`
}

/**
 * The terminal counterpart of the desktop's trusted-folders banner: if the
 * workspace's `.houston/settings.json` elevates (allow rules, hooks, MCP
 * servers) and the folder is undecided — or its elevating config changed since
 * it was trusted — ask before the session starts. `y` trusts (bound to the
 * current config fingerprint), `never` persistently refuses, anything else
 * leaves it off and asks again next session. No-op when nothing elevates, the
 * decision already stands, or this host can't persist settings.
 */
export async function promptFolderTrust(
  cwd: string,
  deps: TuiDeps,
  paint: Painter,
  opts: {
    /**
     * Fingerprints already asked about this session. Re-checked after every turn (the
     * agent or the user may have changed the project's config), the question is asked
     * once per configuration: an unchanged one that was declined isn't asked again.
     */
    asked?: Set<string>
  } = {}
): Promise<void> {
  if (!deps.updateSettings) return
  const cfg = await loadProjectConfig(cwd)
  if (!cfg.elevatedHash) return
  if (opts.asked?.has(cfg.elevatedHash)) return
  let path = cwd
  try {
    path = realpathSync(cwd)
  } catch {
    // Keep the raw path; the loop normalizes the same way, so they still match.
  }
  const settings = deps.getSettings()
  const state = folderTrustState(settings.trustedFolders, path, cfg.elevatedHash)
  if (state === 'trusted' || state === 'untrusted') return
  opts.asked?.add(cfg.elevatedHash)

  deps.io.out(
    `\n${paint(state === 'changed' ? 'This project’s trusted configuration changed.' : 'This project asks for extra permissions.', 'cyan')}\n` +
      `  It defines ${summarizeElevated(cfg.elevated)} (in ${elevatedSource(cfg.elevated)}).\n` +
      paint(
        '  Hooks, MCP servers, plugins, and command templates\' shell commands run as you, and allow rules and pre-approving commands auto-approve matching actions.\n' +
          '  Only trust folders whose authors you trust; until then Houston ignores them.\n' +
          (cfg.elevated.plugins.length
            ? '  Plugins also need the projectPlugins setting on; a plugin added or edited later asks again.\n'
            : ''),
        'dim'
      )
  )
  const answer = (await deps.io.readLine('Trust this folder? [y/N/never] ', { discardPending: true }))?.trim().toLowerCase()
  const decision = answer === 'y' || answer === 'yes' ? 'trusted' : answer === 'never' ? 'never' : null
  if (!decision) {
    deps.io.out(paint('· leaving the extra permissions off (will ask again next session, or sooner if they change)\n', 'dim'))
    return
  }
  deps.updateSettings({
    trustedFolders: upsertFolderTrust(settings.trustedFolders, {
      path,
      decision,
      hash: cfg.elevatedHash,
      decidedAt: Date.now()
    })
  })
  deps.io.out(
    paint(
      decision === 'trusted'
        ? '· folder trusted: its allow rules, hooks, MCP servers, and plugins now apply\n'
        : '· never trusting this folder: its extra permissions stay off\n',
      'dim'
    )
  )
}

/**
 * /trust: show where this folder's project-config trust stands, or forget the
 * recorded decision (/trust forget) and immediately re-ask — the way to reverse
 * a "never" (or retire a stale "trust") without hand-editing settings.json.
 */
export async function runTrustCommand(
  op: 'status' | 'forget' | 'list' | 'usage',
  cwd: string,
  deps: TuiDeps,
  paint: Painter,
  index?: number
): Promise<void> {
  if (op === 'usage') {
    deps.io.out(paint('usage: /trust   ·   /trust forget   ·   /trust list   ·   /trust forget <n>\n', 'yellow'))
    return
  }
  // Every folder's decision, as Settings > Trusted folders lists them.
  if (op === 'list') return void deps.io.out(`${renderTrustList(deps.getSettings(), paint)}\n`)
  if (op === 'forget' && index !== undefined) {
    return forgetTrustAt(
      index,
      {
        getSettings: deps.getSettings,
        ...(deps.updateSettings ? { updateSettings: deps.updateSettings } : {}),
        out: (t) => deps.io.out(t)
      },
      paint
    )
  }
  const cfg = await loadProjectConfig(cwd)
  if (!cfg.elevatedHash) {
    deps.io.out(
      paint('· this project defines no extra permissions (nothing in its .houston folder elevates)\n', 'dim')
    )
    return
  }
  let path = cwd
  try {
    path = realpathSync(cwd)
  } catch {
    // Keep the raw path; trust records normalize the same way, so they still match.
  }
  const settings = deps.getSettings()
  const state = folderTrustState(settings.trustedFolders, path, cfg.elevatedHash)

  if (op === 'status') {
    const label =
      state === 'trusted'
        ? 'trusted: its allow rules, hooks, MCP servers, and plugins apply'
        : state === 'untrusted'
          ? 'never trusted: its extra permissions are ignored'
          : state === 'changed'
            ? 'was trusted, but its config changed: extra permissions are off until you re-decide'
            : 'undecided: its extra permissions are off'
    deps.io.out(
      `· this folder is ${label}\n  it defines ${summarizeElevated(cfg.elevated)}\n` +
        paint('  /trust forget clears the decision and asks again; /trust list shows every folder\n', 'dim')
    )
    return
  }

  // op === 'forget'
  if (!deps.updateSettings) {
    deps.io.out(paint('· editing settings is unavailable here\n', 'dim'))
    return
  }
  const had = settings.trustedFolders?.some((r) => r.path === path) ?? false
  if (had) {
    deps.updateSettings({ trustedFolders: removeFolderTrust(settings.trustedFolders, path) })
    deps.io.out(paint('· forgot the trust decision for this folder\n', 'dim'))
  } else {
    deps.io.out(paint('· no decision was recorded for this folder yet\n', 'dim'))
  }
  await promptFolderTrust(cwd, deps, paint)
}

export async function runTui(opts: TuiOptions, deps: TuiDeps): Promise<number> {
  // A bad flag value is a usage mistake: say so and stop before anything runs.
  if (opts.usageError) {
    deps.io.out(`${opts.usageError}\n`)
    return 2
  }
  const settings = deps.getSettings()
  // Reassigned by /theme (takes effect from the next output). The terminal adapter
  // draws the spinner, picker and menus itself, so it is handed the same painter
  // (through setPaint, whenever it is rebuilt here).
  // Screen-reader mode drops color: nothing may depend on it, and the escapes are noise.
  let screenReader = opts.screenReader === true
  let theme: ThemeName = resolveTheme(settings.tuiTheme ?? '') ?? opts.detectedTheme ?? 'default'
  const makeSessionPainter = (): Painter => makePainter(opts.color && !screenReader, theme)
  // What reply links point at: built once, so file lookups are cached for the session.
  let sessionLinks: MarkdownLinks | null = null
  const replyLinks = (): MarkdownLinks => (sessionLinks ??= markdownLinks(opts.cwd))
  let paint = makeSessionPainter()
  // Reduced motion: the spinner stays still. Resolved at launch (env + setting).
  // Applied before anything reads or prints: the trust prompt and first-run setup
  // below are the first things a screen-reader user meets.
  let reduceMotion = opts.reduceMotion ?? settings.reduceMotion === true
  // Screen-reader mode implies reduced motion; the preference itself is kept apart.
  const applyAccessibility = (): void =>
    deps.io.setAccessibility?.({ screenReader, reduceMotion: reduceMotion || screenReader })
  applyAccessibility()
  deps.io.setPaint?.(paint)
  const newId = deps.newId ?? randomUUID

  // Trusted-folders gate: if this project's .houston/settings.json ELEVATES
  // (allow rules / hooks / MCP servers) and the folder is undecided (or its
  // elevating config changed since it was trusted), ask now — this is the
  // terminal counterpart of the desktop's trust banner. Declining just leaves
  // the elevation off; the session proceeds either way.
  // Fingerprints asked about this session: the check runs again after every turn.
  const trustAsked = new Set<string>()
  await promptFolderTrust(opts.cwd, deps, paint, { asked: trustAsked })

  // The launch flags that shape every turn of this session: tool scope, appended
  // system prompt text, extra MCP servers, extra folders. Said once, up front.
  const sessionRunFields = sessionRunRequestFields(opts.sessionInputs)
  for (const line of sessionInputLines(opts)) deps.io.out(paint(`· ${line}\n`, 'dim'))

  // Mutable session state. providerId/model may be null until a provider is set up:
  // an interactive session never ejects for a missing key (see below).
  // Directories added for this session (`--add-dir`, `/add-dir`), sent with every run.
  const sessionAddDirs: string[] = [...(opts.addDirs ?? [])]
  let providerId: string | null
  let model: string | null
  const resolved = resolveHeadlessModel(settings, opts)
  if ('error' in resolved) {
    // A missing key (or nothing configured yet) is a setup step here, not a fatal
    // error: when a writable key store is wired, auto-launch the /login wizard
    // instead of exiting. A non-recoverable error (an unknown --provider, a provider
    // with no model) is a real usage mistake — print it and exit, don't misdirect the
    // user into key setup.
    if (resolved.recoverable && deps.setKey) {
      const setup = await runProviderSetup(deps, paint, newId, { firstRun: true })
      providerId = setup?.providerId ?? null
      model = setup?.model ?? null
      if (!setup) {
        deps.io.out(
          paint(
            '· No provider set up yet. Run /login any time, or set an env var\n' +
              '  (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY) and restart.\n',
            'dim'
          )
        )
      }
    } else {
      deps.io.out(`${resolved.error}\n`)
      return 1
    }
  } else {
    providerId = resolved.providerId
    model = resolved.model
  }

  let policy = opts.approvalPolicy ?? deps.getSettings().approvalPolicy ?? 'ask'
  // /memory's undo target lives for the session.
  const memoryState: MemoryCommandState = {}
  // This chat's own reasoning effort: starts at the default, changed by /reasoning,
  // restored on /resume. The default changes only with `/reasoning <effort> --default`.
  // `--effort` sets where this session's chats start; /reasoning still changes it.
  let effort: ReasoningEffort = opts.effort ?? deps.getSettings().reasoningEffort ?? DEFAULT_REASONING_EFFORT
  let messages: ChatMessage[] = []
  let activeRunId: string | null = null
  // A /compact in flight: Ctrl-C or Esc cancels it and returns the prompt.
  let compactAbort: AbortController | null = null
  // Prints whatever assistant text the running turn is still holding back (markdown
  // renders block by block, so a paragraph waits for its end). The interrupt handler
  // calls it first, so the text the user stopped lands above "^C interrupted", not
  // after it.
  let flushStreamedText: () => void = () => {}
  // The last turn's run id. Checkpoints are keyed by run, so this is what /undo
  // needs; the conversation lookup is only a way to find it across restarts.
  let lastRunId: string | null = null
  // The persisted conversation backing this session, created lazily on the first
  // turn (so merely opening and closing the REPL doesn't litter history). Null
  // until then, or after `/clear` starts a fresh one.
  let conversationId: string | null = null
  // This chat's saved title (for /export, /rename and /delete), read from the store.
  const currentTitle = (): string | null => {
    if (!conversationId || !deps.persist) return null
    try {
      // From the chat itself: the folder's recent list stops at 20 chats, and a chat
      // opened from another folder or a worktree is not in it at all.
      if (deps.persist.title) return deps.persist.title(conversationId) ?? null
      return deps.persist.list(opts.cwd).find((c) => c.id === conversationId)?.title ?? null
    } catch {
      return null
    }
  }
  // `--name`: the title the session's chat starts with. Applied once, to the chat the
  // launch opens (a resumed one, or the first one created), never to later /new chats.
  let launchTitlePending = opts.title !== undefined
  const applyLaunchTitle = (): void => {
    if (!launchTitlePending || !conversationId || !opts.title) return
    launchTitlePending = false
    if (!deps.persist?.rename) return
    try {
      deps.persist.rename(conversationId, opts.title)
    } catch (e) {
      deps.io.out(paint(`· couldn't set the chat title: ${(e as Error).message}\n`, 'yellow'))
    }
  }
  // Persist the running message log, best-effort. A store failure (disk full, bad
  // perms) must degrade to an ephemeral session, not crash the REPL mid-turn — a
  // throw here otherwise propagates out of startRun (no catch there) to a Fatal.
  let warnedPersistFail = false
  const persistMessages = (msgs: ChatMessage[]): void => {
    if (!deps.persist || !conversationId) return
    try {
      deps.persist.setMessages(conversationId, msgs)
    } catch (e) {
      if (!warnedPersistFail) {
        warnedPersistFail = true
        deps.io.out(paint(`· couldn't save the conversation (continuing unsaved): ${(e as Error).message}\n`, 'dim'))
      }
    }
  }
  // The settings last written to the backing conversation. `create` stores them
  // once; after that a `/model`, `/reasoning` or `/approval` change leaves the stored
  // values stale (see setSettings). We track what we've persisted and, when a turn
  // runs under different settings, rewrite them, mirroring the GUI, which calls
  // updateConversationMeta on every send. null means "unknown" (freshly forked, or
  // resumed from a chat that never stored them), which forces the next turn to re-sync.
  type ChatSettingsKey = string
  const settingsKey = (): ChatSettingsKey => JSON.stringify([providerId, model, effort, policy])
  let persistedSettings: ChatSettingsKey | null = null
  const syncPersistedModel = (): void => {
    if (!deps.persist || !conversationId || !providerId || !model) return
    if (persistedSettings === settingsKey()) return
    try {
      deps.persist.setSettings(conversationId, { providerId, model, reasoningEffort: effort, approvalPolicy: policy })
      persistedSettings = settingsKey()
    } catch (e) {
      if (!warnedPersistFail) {
        warnedPersistFail = true
        deps.io.out(paint(`· couldn't save the conversation (continuing unsaved): ${(e as Error).message}\n`, 'dim'))
      }
    }
  }
  // Opening a saved chat (--continue, /resume, /spawned) switches the session to that
  // chat's own settings, the ones it last ran under. A stored model that is no longer
  // set up moves to another of its provider's models, or keeps the session's (and says
  // so); values a chat never stored keep the session's too, and
  // the first turn then writes them. Says what changed, so a switch is never silent.
  const adoptChatSettings = (conv: ConversationSettingsPatch): void => {
    const before = settingsKey()
    const providers = deps.getSettings().providers
    const known = providers.some((p) => p.id === conv.providerId)
    // The chat's model when it is still set up; otherwise the desktop app's fallback
    // (another model of its provider, else this session's), and say so.
    const chosen = reconcileChatModel(providers, conv, { providerId: providerId ?? '', model: model ?? '' })
    if (chosen) {
      if (chosen.model) {
        providerId = chosen.providerId
        model = chosen.model
      }
      if (chosen.note) deps.io.out(paint(`· ${chosen.note}\n`, 'yellow'))
    }
    if (isReasoningEffort(conv.reasoningEffort)) effort = conv.reasoningEffort
    if (isApprovalPolicy(conv.approvalPolicy)) {
      policy = conv.approvalPolicy
      deps.io.setMode?.(policy)
    }
    const complete =
      known && !chosen?.note && conv.model && isReasoningEffort(conv.reasoningEffort) && isApprovalPolicy(conv.approvalPolicy)
    persistedSettings = complete ? settingsKey() : null
    if (settingsKey() !== before) {
      deps.io.out(
        paint(`· this chat's settings: ${providerId} / ${model}, thinking ${effort}, approval ${policy}\n`, 'dim')
      )
    }
  }
  // Short project label, folded into titles/notifications so two terminals in two
  // projects are tellable apart at a glance.
  let workspaceName = workspaceLabel(opts.cwd)
  // Which attention signals fire (/notify). Read once rather than per event (that
  // would cost a settings load on every streamed token); /notify changes it live.
  let notifyMode: NotifyMode = resolveNotifyMode(settings)
  // Show each tool's full output as it runs (/verbose). Off by default: the
  // transcript is a conversation, and most results are noise until they aren't.
  // Remembered across sessions once chosen.
  let verbose = settings.tuiVerbose === true
  // The focus view (/focus): your messages, one line per tool call, and each turn's
  // final reply; reasoning, progress and the text between tool calls are left out.
  // Remembered like /verbose; the transcript viewer always has everything.
  let focusView = settings.tuiFocus === true
  // How the model's reasoning shows as it streams (/thoughts, Alt-T): one line per
  // thought by default, since a long chain of thought buries the reply. Remembered
  // like /verbose; the transcript viewer always has it in full.
  let reasoningDisplay: ReasoningDisplay = isReasoningDisplay(settings.reasoningDisplay)
    ? settings.reasoningDisplay
    : DEFAULT_REASONING_DISPLAY
  // Whether streamed reasoning left the cursor mid-line, so a note printed while a
  // turn runs starts on a line of its own.
  let thoughtLineOpen = false
  const freshLine = (): string => {
    const nl = thoughtLineOpen ? '\n' : ''
    thoughtLineOpen = false
    return nl
  }
  // Prints the tool lines the running turn is holding for their results (set per run,
  // see the tool line folding in runTurn), so a note printed mid-run lands after them.
  let flushHeldCalls: () => void = () => {}
  const flushPendingOutput = (): string => {
    flushHeldCalls()
    return freshLine()
  }
  const setReasoningDisplay = (d: ReasoningDisplay): void => {
    reasoningDisplay = d
    deps.updateSettings?.({ reasoningDisplay: d })
    deps.io.out(`${flushPendingOutput()}${paint(reasoningDisplayNote(d), 'dim')}\n`)
  }
  /**
   * Change one of the terminal's own preferences and say so: the body of /vim,
   * /verbose, /focus, /notify <mode>, /reduce-motion, /screen-reader and /theme <name>, shared
   * with /config so a value set either way behaves the same.
   */
  const applyTerminalSetting = (
    r:
      | { kind: 'vim'; on: boolean }
      | { kind: 'verbose'; on: boolean }
      | { kind: 'focus'; on: boolean }
      | { kind: 'reduce-motion'; on: boolean }
      | { kind: 'screen-reader'; on: boolean }
      | { kind: 'notify'; mode: NotifyMode }
      | { kind: 'set-theme'; theme: ThemeName }
  ): void => {
    switch (r.kind) {
      case 'vim':
        if (!deps.updateSettings) {
          deps.io.out(paint('· changing settings is unavailable here\n', 'dim'))
          return
        }
        deps.updateSettings({ tuiEditor: r.on ? 'vim' : 'emacs' })
        deps.io.out(
          paint(
            r.on
              ? '· vim keys on: Esc for normal mode, i to type again (takes effect at the next prompt)\n'
              : '· vim keys off: the composer is back to the readline keys\n',
            'dim'
          )
        )
        return
      case 'verbose':
        verbose = r.on
        deps.updateSettings?.({ tuiVerbose: verbose })
        deps.io.out(
          paint(
            verbose
              ? '· verbose: showing each tool\'s output as it runs (/output reprints one in full)\n'
              : '· verbose off: tool output collapses to one line again\n',
            'dim'
          )
        )
        return
      case 'focus':
        focusView = r.on
        deps.updateSettings?.({ tuiFocus: focusView })
        deps.io.out(
          paint(
            focusView
              ? '· focus: only your messages, one line per tool call, and the final reply (Ctrl-O has everything)\n'
              : '· focus off: the turn\'s working shows again\n',
            'dim'
          )
        )
        return
      case 'reduce-motion':
        reduceMotion = r.on
        deps.updateSettings?.({ reduceMotion })
        applyAccessibility()
        deps.io.out(
          paint(
            reduceMotion
              ? '· reduced motion on: the activity line holds still and its timer updates every few seconds\n'
              : '· reduced motion off: the spinner animates again\n',
            'dim'
          )
        )
        return
      case 'screen-reader':
        screenReader = r.on
        deps.updateSettings?.({ tuiScreenReader: screenReader })
        applyAccessibility()
        paint = makeSessionPainter()
        deps.io.setPaint?.(paint)
        deps.io.out(
          paint(
            screenReader
              ? '· screen-reader mode on: plain lines, no spinner or redraws, and numbered choices\n'
              : '· screen-reader mode off: the spinner, colors and arrow-key pickers are back\n',
            'dim'
          )
        )
        return
      case 'notify':
        notifyMode = r.mode
        deps.updateSettings?.({ tuiNotify: notifyMode })
        deps.io.out(paint(`· notifications → ${notifyMode}, ${describeNotifyMode(notifyMode)}\n`, 'dim'))
        return
      case 'set-theme':
        theme = r.theme
        paint = makeSessionPainter()
        deps.io.setPaint?.(paint)
        // Persist it: a theme you have to re-pick on every launch is not a setting,
        // it is a party trick.
        deps.updateSettings?.({ tuiTheme: r.theme })
        deps.io.out(paint(`· theme → ${r.theme}\n`, 'dim'))
        return
    }
  }
  const configLive = (): ConfigLive => ({ theme, verbose, focus: focusView, reasoningDisplay, notifyMode, reduceMotion, screenReader })
  const configContext = (): ConfigContext => ({ settings: deps.getSettings(), themes: themeNames(), resolveTheme })
  /** Save one /config value (already validated) through the same path its own command takes. */
  const applyConfig = (key: ConfigKeyName, value: string): void => {
    switch (key) {
      case 'theme': {
        const t = resolveTheme(value)
        if (t) applyTerminalSetting({ kind: 'set-theme', theme: t })
        return
      }
      case 'vim':
      case 'verbose':
      case 'focus':
      case 'reduce-motion':
      case 'screen-reader':
        applyTerminalSetting({ kind: key, on: value === 'on' })
        return
      case 'notify':
        if (isNotifyMode(value)) applyTerminalSetting({ kind: 'notify', mode: value })
        return
      case 'thoughts':
        if (isReasoningDisplay(value)) setReasoningDisplay(value)
        return
      default: {
        const change = configPatch(key, value, deps.getSettings())
        if (!change) return
        if (!deps.updateSettings) {
          deps.io.out(paint('· changing settings is unavailable here\n', 'dim'))
          return
        }
        deps.updateSettings(change.patch)
        deps.io.out(paint(`· ${change.note}\n`, 'dim'))
      }
    }
  }
  /** /status: the session's facts, the host's, and this folder's project config, on one screen. */
  const statusReport = async (): Promise<string> => {
    const current = deps.getSettings()
    let host: HostStatusFacts | null
    try {
      host = deps.statusFacts ? await deps.statusFacts(conversationId) : null
    } catch {
      host = null
    }
    let project: StatusView['project']
    try {
      const cfg = await loadProjectConfig(opts.cwd)
      let path = opts.cwd
      try {
        path = realpathSync(opts.cwd)
      } catch {
        // Trust records normalize the same way, so the raw path still matches.
      }
      const elevates = Boolean(cfg.elevatedHash)
      project = {
        exists: elevates || existsSync(resolvePath(opts.cwd, '.houston', 'settings.json')),
        elevates,
        trust: elevates ? folderTrustState(current.trustedFolders, path, cfg.elevatedHash) : 'undecided'
      }
    } catch {
      project = null
    }
    const kind = providerId ? current.providers.find((p) => p.id === providerId)?.kind : undefined
    return renderStatus(
      {
        version: deps.version ?? 'dev',
        host,
        provider:
          providerId && model ? { id: providerId, model, name: kind ? modelDisplayName(kind, model) : model } : null,
        effort,
        policy,
        mcp: {
          configured: (current.mcpServers ?? []).filter((m) => m.enabled).length,
          statuses: deps.mcpStatuses?.() ?? []
        },
        settingsPath: deps.settingsPath?.() ?? null,
        project,
        cost: formatSessionCost(sessionCost),
        usageLimitWait: current.usageLimitWait !== false
      },
      paint
    )
  }
  /**
   * /config: the picker (Enter steps the highlighted setting to its next value, or
   * picks a model, then the list comes back on the same row), `--help`, one key, or
   * `key=value`. In screen-reader mode the picker is a numbered list, and a typed
   * `key=value` at its prompt sets that key.
   */
  const runConfig = async (op: ConfigOp): Promise<void> => {
    if (op.op === 'error') return void deps.io.out(paint(`· ${op.message}\n`, 'yellow'))
    if (op.op === 'help') {
      return void deps.io.out(`${wrapHelp(renderConfigHelp(deps.getSettings(), configLive(), configContext()), columns())}\n`)
    }
    if (op.op === 'show') {
      const spec = findConfigKey(op.key)
      if (spec) deps.io.out(`${renderConfigValue(spec, deps.getSettings(), configLive(), configContext())}\n`)
      return
    }
    if (op.op === 'set') return applyConfig(op.key, op.value)
    if (!deps.io.select) {
      return void deps.io.out(`${wrapHelp(renderConfigHelp(deps.getSettings(), configLive(), configContext()), columns())}\n`)
    }
    let cursor = 0
    for (;;) {
      const current = deps.getSettings()
      const live = configLive()
      const options = CONFIG_KEYS.map((k) => ({
        label: `${k.key}: ${stripControlChars(k.current(current, live))}`,
        value: k.key,
        description: k.description
      }))
      const r = await deps.io.select({
        title: 'Settings (Enter changes the highlighted one, Esc closes):',
        options,
        initialCursor: cursor,
        maxRows: CONFIG_KEYS.length
      })
      if (r.kind === 'type' && r.text?.trim()) {
        // A typed `key=value` at the numbered list (screen-reader mode).
        const typed = parseConfigArgs(r.text, configContext())
        if (typed.op === 'picker' || typed.op === 'help') return
        await runConfig(typed)
        continue
      }
      if (r.kind !== 'commit') return
      const spec = findConfigKey(r.value)
      if (!spec) return
      cursor = CONFIG_KEYS.indexOf(spec)
      if (spec.key === 'model') {
        const sel = current.selected
        const choices = modelChoices(current, sel?.providerId ?? null, sel?.model ?? null)
        if (!choices.length) {
          deps.io.out(paint('· no model is ready to pick: /login adds a provider key\n', 'yellow'))
          continue
        }
        const m = await deps.io.select({
          title: 'Model new chats start on:',
          options: choices.map((c, i) => ({ label: c.label, value: String(i), description: c.description }))
        })
        const picked = m.kind === 'commit' ? choices[Number(m.value)] : undefined
        if (picked) applyConfig('model', `${picked.providerId}/${picked.model}`)
        continue
      }
      const next = nextConfigValue(spec, spec.current(current, live), configContext())
      if (next) applyConfig(spec.key, next)
    }
  }
  // Follow-ups typed while the agent was working, dispatched as the next turn.
  let pendingQueued: string[] = []
  // A line half-typed while a turn ran (never sent with Enter): the next composer opens with it.
  let halfDraft = ''
  // What a run hands back unsent: steers it accepted but ended before reading
  // (`steers_returned`), and, when the user interrupted it, the follow-ups typed
  // while it ran. Nothing typed is dropped: after an interrupt it comes back as the
  // next prompt's draft to edit or resend (sending it into the turn just abandoned
  // would be worse); after any other ending it goes out as the next turn.
  let returnedSteers: string[] = []
  let interruptedQueued: string[] | null = null
  let restoreDraft = ''
  // A message handed back to the composer without the interrupted-turn notice: a `#`
  // line the user stepped back from remembering.
  let keptDraft = ''
  // The chat's unsent draft, saved as it changes so a quit, a Ctrl-C or a /resume
  // can't lose it (see tui-drafts.ts). What was typed mid-run and acknowledged on
  // screen is written at once; the text being typed, after a pause.
  const draftSaver = deps.drafts
    ? createDraftSaver(deps.drafts, (fn, ms) => {
        const id = setTimeout(fn, ms)
        id.unref?.()
        return () => clearTimeout(id)
      })
    : null
  const saveDraft = (record: DraftRecord | null, now = false): void =>
    draftSaver?.update(draftKey(conversationId, opts.cwd), record, now)
  // What the driver holds unsent (a draft handed back by an interrupt, a half-typed
  // line, follow-ups still to dispatch), saved as this chat's draft.
  const saveHeldDraft = (): void =>
    saveDraft({ text: [restoreDraft, keptDraft, halfDraft].filter(Boolean).join('\n\n'), queued: pendingQueued }, true)
  // A chat's saved draft, read when the chat is opened: the next composer starts with it.
  let savedDraft: DraftRecord | null = null
  // Leaving this chat for another (/clear, /resume, /spawned, /fork, a delete): what
  // the driver still holds (follow-ups queued during the last turn) is session state
  // that goes on to the next chat, so the old chat keeps no record of it. Saved under
  // the old key, it came back later as an unsent draft of text already sent elsewhere.
  const leaveChatDraft = (): void => saveDraft(null, true)
  const loadSavedDraft = (): void => {
    draftSaver?.flush()
    savedDraft = deps.drafts?.load(draftKey(conversationId, opts.cwd)) ?? null
  }
  deps.io.onPendingInput?.((p, acked) => saveDraft({ text: p.draft, queued: p.queued }, acked))
  /** /queue: the follow-ups waiting for this turn. Mid-run it only prints, like /tasks. */
  const runQueue = (op: QueueOp, midRun: boolean): void => {
    if (midRun) deps.io.out('\n')
    const items = deps.io.peekQueued?.() ?? []
    const nth = (index: number): string | null => {
      const t = items[index - 1]
      if (t !== undefined) return t
      deps.io.out(paint(items.length ? `· no queued message ${index}; /queue lists them\n` : '· nothing is queued\n', 'dim'))
      return null
    }
    const quoted = (t: string): string => truncate(stripControlChars(t).replace(/\s+/g, ' '), 60)
    switch (op.op) {
      case 'usage':
        deps.io.out(paint(`${QUEUE_USAGE}\n`, 'dim'))
        return
      case 'list': {
        const [head, ...rest] = renderQueueList(items)
        deps.io.out(`${paint(head, items.length ? 'bold' : 'dim')}\n`)
        if (rest.length) {
          const hint = rest.pop() ?? ''
          deps.io.out(`${rest.join('\n')}\n${paint(hint, 'dim')}\n`)
        }
        return
      }
      case 'drop': {
        const t = nth(op.index)
        if (t === null) return
        deps.io.dropQueued?.(op.index - 1)
        deps.io.out(paint(`· removed: ${quoted(t)}\n`, 'dim'))
        return
      }
      case 'send': {
        const t = nth(op.index)
        if (t === null) return
        if (!activeRunId) {
          deps.io.out(paint('· no turn is running; queued messages go out when it ends\n', 'dim'))
          return
        }
        if (!(deps.io.sendQueuedNow?.(op.index - 1) ?? false)) {
          deps.io.out(paint("· that can't go to the running turn (a command, or too long to steer); it stays queued\n", 'dim'))
          return
        }
        deps.io.out(paint(`· sent to the running turn, which reads it at its next step: ${quoted(t)}\n`, 'dim'))
        return
      }
      case 'clear': {
        const gone = deps.io.clearQueued?.() ?? []
        deps.io.out(paint(gone.length ? `· cleared ${plural(gone.length, 'queued message')}\n` : '· nothing is queued\n', 'dim'))
        return
      }
    }
  }
  // Set while a /btw side chat answer is in flight: Ctrl-C / Esc stops it.
  let stopSideChat: (() => void) | null = null
  const sessionCost: SessionCost = { inputTokens: 0, outputTokens: 0, cost: 0 }
  // Per-model tallies for /cost. The aggregate above still drives the status line;
  // this is what makes "which model spent it, and how much was cached?" answerable.
  let modelCosts: ModelCost[] = []
  // The subagents this session's runs dispatched, as their start and end events
  // described them: /cost lists what they spent beside the tallies above, which hold
  // this session's spend only (a resumed chat's earlier subagents are not in them).
  const sessionAgents = new Map<string, SubagentRecord>()
  // Image attachments staged via /image, attached to (and cleared by) the next turn.
  let pendingImages: ImageAttachment[] = []
  // Stage an image for the next turn, from the clipboard or a file. Each returns the
  // note to print; shared by /image, /paste, Ctrl-V, and a pasted image path.
  // The same cap a message's attachments have everywhere else (the desktop composer,
  // the queue, the IPC boundary).
  const MAX_STAGED_IMAGES = MAX_ATTACHMENTS
  const fullNote = (): string => paint(`· already have ${MAX_STAGED_IMAGES} images staged (the max)`, 'yellow')
  // Whether the model this chat sends to can see images. Unknown (no model yet) reads
  // as yes, as in the desktop app.
  const modelSeesImages = (): boolean => {
    if (!model) return true
    const caps = deps.getSettings().providers.find((p) => p.id === providerId)?.models.find((m) => m.id === model)?.caps
    return resolveCapabilities(model, caps).vision
  }
  const noVisionNote = (): string =>
    paint(`· ${model} can't see images: switch to a vision model (/model) to attach one`, 'yellow')
  const stageClipboardImage = (): string => {
    if (!deps.clipboardImage) return paint('· pasting images is unavailable here; use /image <path>', 'dim')
    if (!modelSeesImages()) return noVisionNote()
    if (pendingImages.length >= MAX_STAGED_IMAGES) return fullNote()
    const img = deps.clipboardImage()
    if ('error' in img) return paint(`· ${stripControlChars(img.error)}`, 'dim')
    pendingImages.push(img.image)
    return paint(`· attached the image from your clipboard (${pendingImages.length} staged)`, 'dim')
  }
  const stageLoadedImage = (path: string, loaded: ReturnType<NonNullable<TuiDeps['loadImage']>>): string => {
    if (!modelSeesImages()) return noVisionNote()
    if (pendingImages.length >= MAX_STAGED_IMAGES) return fullNote()
    if ('error' in loaded) return paint(`· ${stripControlChars(loaded.error)}`, 'yellow')
    pendingImages.push(loaded.image)
    return paint(`· attached ${stripControlChars(path)} (${pendingImages.length} staged)`, 'dim')
  }
  deps.io.onImagePaste?.((req) => {
    if (req.kind === 'clipboard') return { handled: true, notes: [stageClipboardImage()] }
    if (!deps.loadImage) return { handled: false, notes: [] }
    // Only a paste that names real files is images: a path that does not exist
    // means it was text that happened to end in .png, and pastes as text.
    const loaded = req.paths.map((p) => ({ path: p, result: deps.loadImage!(p) }))
    if (loaded.some((l) => 'error' in l.result && l.result.missing)) return { handled: false, notes: [] }
    return { handled: true, notes: loaded.map((l) => stageLoadedImage(l.path, l.result)) }
  })
  // Esc Esc on an empty composer: run /rewind once the composer read closes.
  let rewindRequested = false
  deps.io.onRewindKey?.(() => {
    rewindRequested = true
  })
  // Estimated current context size (last turn's input tokens), for the status line.
  let contextTokens = 0
  // This session's landed edits (newest last), for `/diff last [n]`.
  let recentEdits: FileDiffPreview[][] = []
  // The checked-out branch, re-read before each status line (a turn or `!git`
  // may switch it). Never waited for: the prompt, and a queued turn's request behind
  // it, must not sit behind a git process. A slow answer shows on the next status line.
  let branch: string | null = null
  let branchReads = 0
  const refreshBranch = (): void => {
    if (!deps.gitBranch) return
    const read = ++branchReads
    try {
      const got = deps.gitBranch()
      if (got === null || typeof got === 'string') {
        branch = got
        return
      }
      got.then(
        (b) => {
          if (read === branchReads) branch = b
        },
        () => {
          if (read === branchReads) branch = null
        }
      )
    } catch {
      branch = null
    }
  }
  // What filled the context on the last main round, for /context (estimated parts).
  let contextParts: ContextParts | null = null
  // What belongs to the chat on screen rather than the session: the staged /image, the
  // context meter and the run /undo falls back to. Reset whenever another chat (or a
  // fresh one) takes its place, or the status bar, /context and /undo act on the old one.
  // The suggested next message for the chat on screen (chatAssist.suggest), shown dim
  // in the empty composer until a turn is sent or another chat takes its place.
  let suggestion: string | null = null
  let redrawSuggestion: (() => void) | null = null
  const resetChatState = (): void => {
    suggestion = null
    pendingImages = []
    contextTokens = 0
    contextParts = null
    lastRunId = null
  }
  const nowFn = deps.now ?? Date.now
  const columns = deps.columns ?? (() => 80)
  // The rewind picker's "Summarize from here" / "Summarize up to here": the /compact
  // summarizer over that part of the chat, saved as a rewind so /rewind undo reverses it.
  const summarizeAround = async (turn: number, point: RewindPoint, side: 'from' | 'before'): Promise<void> => {
    if (!deps.summarize || !conversationId || !providerId || !model) {
      deps.io.out(paint('· summarizing part of a chat is unavailable here\n', 'dim'))
      return
    }
    const count = side === 'from' ? messages.length - point.messageIndex : point.messageIndex
    if (count <= 0) {
      deps.io.out(paint(`· nothing before message ${turn + 1} to summarize\n`, 'dim'))
      return
    }
    deps.io.out(
      `${paint(`Summarize ${side === 'from' ? 'from' : 'up to'} “${terminalText(point.label, { lines: false })}”?`, 'bold')} ` +
        `${side === 'from' ? `Replaces this message and everything after it (${plural(count, 'message')})` : `Replaces the ${plural(count, 'message')} before it`} with a summary. Files stay as they are, and /rewind undo brings the messages back.\n`
    )
    const focusAns = await deps.io.readLine('What should the summary keep in detail? (Enter for nothing in particular) ', {
      discardPending: true
    })
    if (focusAns === null) {
      deps.io.out(paint('· cancelled\n', 'dim'))
      return
    }
    const yes = await deps.io.readLine('Summarize? [y/N] ', { discardPending: true })
    if (!yes || !/^y(es)?$/i.test(yes.trim())) {
      deps.io.out(paint('· cancelled\n', 'dim'))
      return
    }
    deps.io.out(paint('· summarizing… (Esc or Ctrl-C cancels)\n', 'dim'))
    const ctl = new AbortController()
    compactAbort = ctl
    deps.io.startSpinner?.('Summarizing')
    let res: CompactResult
    try {
      const focus = focusAns.trim()
      res = await deps.summarize(
        conversationId,
        providerId,
        model,
        { turn, text: turnText(messages[point.messageIndex]), side },
        {
          signal: ctl.signal,
          ...(focus ? { focus } : {}),
          onRetry: ({ attempt, max }) =>
            deps.io.setSpinnerLabel?.(`Summarizing (retrying, attempt ${attempt}${max ? ` of ${max}` : ''})`)
        }
      )
    } catch (e) {
      res = { ok: false, summarized: 0, error: (e as Error).message }
    } finally {
      compactAbort = null
      deps.io.stopSpinner?.()
    }
    if (res.ok && res.messages) {
      messages = res.messages
      // The meter measured the log before the rewrite, as after a rewind.
      contextTokens = 0
      contextParts = null
      // The last turn's run may now be inside the summary: /undo must not reach for it.
      if (side === 'from') lastRunId = null
      deps.io.out(
        paint(
          `· summarized ${plural(res.summarized, 'message')} ${side === 'from' ? `from message ${turn + 1} on` : `before message ${turn + 1}`}; files are as they were. /rewind undo reverses it.\n`,
          'dim'
        )
      )
    } else if (res.ok) {
      deps.io.out(paint('· nothing to summarize there\n', 'dim'))
    } else if (res.reason === 'cancelled') {
      deps.io.out(paint('· summary cancelled; nothing changed\n', 'dim'))
    } else {
      deps.io.out(paint(`· couldn't summarize: ${stripControlChars(res.error ?? 'unknown error')}\n`, 'yellow'))
    }
  }
  // `/fork <n>` and the rewind picker's "Fork from here": a new chat holding the chat
  // up to before message `turn`, with that message back in the prompt to edit or send,
  // as the desktop's fork from a message does.
  const forkFromMessage = (turn: number): void => {
    if (!deps.persist || !conversationId) {
      deps.io.out(paint('· nothing to fork yet; start a conversation first\n', 'dim'))
      return
    }
    const point = rewindPoints(messages)[turn]
    if (!point) {
      const count = rewindPoints(messages).length
      deps.io.out(paint(`· no message ${turn + 1} to fork from (there are ${count})\n`, 'yellow'))
      return
    }
    if (!deps.persist.forkAt) {
      deps.io.out(paint('· forking from a message is unavailable here\n', 'dim'))
      return
    }
    const draft = turnText(messages[point.messageIndex])
    let forked: { id: string } | null
    try {
      forked = deps.persist.forkAt(conversationId, { kind: 'turn', n: turn, text: draft })
    } catch (e) {
      deps.io.out(paint(`· could not fork this session: ${(e as Error).message}\n`, 'dim'))
      return
    }
    if (!forked) {
      deps.io.out(paint('· could not fork this session\n', 'dim'))
      return
    }
    conversationId = forked.id
    // The fork is a fresh conversation whose stored model we don't track; mark it
    // stale so the next turn re-syncs the meta to the active model.
    persistedSettings = null
    messages = deps.persist.get(forked.id)?.messages ?? messages.slice(0, point.messageIndex)
    // The meter and /undo described the longer chat.
    contextTokens = 0
    contextParts = null
    lastRunId = null
    if (deps.io.readComposer) halfDraft = draft
    deps.io.out(
      paint(
        `· forked from before message ${turn + 1}: continuing on a copy, original left intact${deps.io.readComposer && draft ? '; that message is back in the prompt' : ''}\n`,
        'dim'
      )
    )
  }

  // Custom slash commands from the workspace's `.houston/commands`, loaded once for
  // the session. Merged with the first-party template commands (e.g. /review), which
  // win on a name collision. Typing `/<name>` runs the expanded template as a turn.
  let customCommands: Command[] = []
  if (deps.commands) {
    try {
      // A custom command named like a built-in (in either client) or an alias never
      // runs, here or in the desktop app, so it isn't listed either.
      customCommands = (await deps.commands()).filter((c) => !isReservedCommandName(c.name))
    } catch {
      /* no custom commands — fine, carry on with the built-ins */
    }
  }
  let templateCommands = mergeCommands(BUILTIN_TEMPLATE_COMMANDS, customCommands)

  // `/cd <path>`: move the session's working folder, and with it everything a session
  // reads from its folder, as a fresh start there would: the project's trust question,
  // its own commands, the status line, and the chat's recorded folder. The agent's
  // instructions, project settings and sandbox roots follow on the next message, since
  // each run reads them from the folder it is given.
  const changeFolder = async (path: string): Promise<void> => {
    if (!path) {
      deps.io.out(paint(`· working folder: ${stripControlChars(homeRelative(opts.cwd))}. /cd <path> moves it\n`, 'dim'))
      return
    }
    const target = resolveCdTarget(path, opts.cwd)
    if ('error' in target) {
      deps.io.out(paint(`· /cd ${stripControlChars(target.error)}\n`, 'yellow'))
      return
    }
    let current = opts.cwd
    try {
      current = realpathSync(opts.cwd)
    } catch {
      // A folder removed under the session: any existing one is a move.
    }
    if (target.dir === current) {
      deps.io.out(paint(`· already in ${stripControlChars(homeRelative(target.dir))}\n`, 'dim'))
      return
    }
    opts.cwd = target.dir
    workspaceName = workspaceLabel(opts.cwd)
    deps.io.signal?.({ title: idleTitle(workspaceName) })
    deps.onCwdChange?.(opts.cwd)
    if (conversationId && deps.persist?.setWorkspace) {
      try {
        deps.persist.setWorkspace(conversationId, opts.cwd)
      } catch (e) {
        deps.io.out(paint(`· couldn't record the chat's new folder: ${stripControlChars((e as Error).message)}\n`, 'yellow'))
      }
    }
    deps.io.out(paint(`· working folder is now ${stripControlChars(homeRelative(opts.cwd))}\n`, 'dim'))
    await promptFolderTrust(opts.cwd, deps, paint)
    customCommands = []
    if (deps.commands) {
      try {
        customCommands = await deps.commands()
      } catch {
        /* no custom commands there: the built-ins still work */
      }
    }
    templateCommands = mergeCommands(BUILTIN_TEMPLATE_COMMANDS, customCommands)
  }

  // Ctrl-C at the composer (no run in flight): first press discards the in-progress
  // input and re-prompts; a second press within the window exits, like a shell. The
  // composer read loop reads this to tell a reset from a real EOF.
  let composerInterrupt: 'reset' | 'exit' | null = null
  let lastComposerCtrlCAt = -Infinity
  // True only while reading the composer, so a Ctrl-C at a between-turn sub-prompt
  // (/resume, /login, plan handoff) is handled as a plain cancel, not a composer
  // reset/exit whose flag would leak into the next composer read.
  let atComposer = false
  // Set when background news closed the idle composer: the next pass runs a turn on it.
  let wakeRequested = false
  deps.wake?.register((id) => {
    if (id !== conversationId || !atComposer || activeRunId !== null || wakeRequested) return false
    if (!deps.io.yieldComposer?.()) return false
    wakeRequested = true
    return true
  })
  // The subagents this session's runs dispatched, for /tasks (shells come from the
  // registry each time; agents only exist as the events that described them).
  const subagentTracker = new SubagentTracker()
  // The subagents the live panel and live view follow: this turn's, and any agent of
  // this chat still at work (a background one from an earlier turn).
  const liveSubagents = (): TrackedSubagent[] =>
    subagentTracker
      .forChat(conversationId)
      .filter((a) => a.runId !== undefined && (a.runId === activeRunId || a.status === 'running'))
  // The live view's redraw hooks while it is open (see the pager's `subscribe`).
  const liveViewers = new Set<() => void>()
  // Enter on an empty line under the panel: the agents' steps, full screen, as they
  // happen. The viewer gives the keyboard back by itself when a prompt needs it.
  deps.io.onOpenLivePanel?.(async () => {
    if (!deps.io.pager) return
    await deps.io.pager({
      title: 'Subagents at work (live)',
      render: (width) => ({
        lines: liveAgentLines(liveSubagents(), nowFn()).flatMap((l) => (width > 0 ? wrapAnsi(l, width).split('\n') : [l])),
        prompts: []
      }),
      plain: () => `${liveAgentLines(liveSubagents(), nowFn()).join('\n')}\n`,
      subscribe: (changed) => {
        liveViewers.add(changed)
        return () => void liveViewers.delete(changed)
      }
    })
  })
  // /tasks: this chat's background shells and subagents, numbered oldest first.
  const currentTasks = (): TaskRow[] => {
    const shells = deps.backgroundTasks
      ? deps.backgroundTasks
          .shells()
          .filter((sh) => shellInChat(sh, conversationId, opts.cwd))
          .map((sh) => ({ ...sh, lastLine: deps.backgroundTasks?.shellTail(sh.id, 1)?.[0] }))
      : []
    const agents = chatSubagents(messages, subagentTracker.forChat(conversationId), conversationId)
    return taskRows(shells, agents)
  }
  const showTask = (rows: TaskRow[], n: number): void => {
    const r = rows[n - 1]
    if (!r) {
      deps.io.out(paint(`· no task ${n}; /tasks lists them\n`, 'dim'))
      return
    }
    const text =
      r.kind === 'shell'
        ? renderShellDetail(r, n, deps.backgroundTasks?.shellTail(r.shell.id, TASK_TAIL_LINES), nowFn(), paint)
        : renderSubagentDetail(r, n, nowFn(), paint, columns())
    deps.io.out(`${text}\n`)
  }
  const killTask = (rows: TaskRow[], n: number): void => {
    const r = rows[n - 1]
    if (!r) {
      deps.io.out(paint(`· no task ${n}; /tasks lists them\n`, 'dim'))
      return
    }
    if (!taskRunning(r)) {
      deps.io.out(paint(`· task ${n} already finished; nothing to stop\n`, 'dim'))
      return
    }
    if (r.kind === 'shell') {
      if (!deps.backgroundTasks) {
        deps.io.out(paint('· stopping background shells is unavailable here\n', 'dim'))
        return
      }
      const outcome = deps.backgroundTasks.killShell(r.shell.id)
      deps.io.out(paint(`${shellKillPhrase(n, outcome)}\n`, outcome === 'not-found' ? 'yellow' : 'dim'))
      return
    }
    const a = r.agent
    const stopped = a.runId ? (deps.backgroundTasks?.stopSubagent(a.runId, a.recordId) ?? false) : false
    deps.io.out(
      stopped
        ? paint(`· stopping task ${n}: the subagent ends at its next step and the turn goes on without it\n`, 'dim')
        : paint(`· task ${n} can't be stopped on its own; Esc stops the whole turn\n`, 'yellow')
    )
  }
  /**
   * /loop: a recurring run on the scheduler the agent's schedule tools and /schedule
   * use, so it is listed and managed there. It starts as a background session in this
   * chat's folder, on this chat's model, approval mode and effort, so it is never more
   * permissive than the chat.
   */
  const runLoopCommand = (arg: string): void => {
    const store = deps.schedules
    if (!store) {
      deps.io.out(paint('· scheduled runs are unavailable here\n', 'dim'))
      return
    }
    const parsed = parseLoopArgs(arg)
    if (!parsed.ok) {
      deps.io.out(paint(`· ${parsed.error}\n`, 'yellow'))
      return
    }
    if (!providerId || !model) {
      deps.io.out(paint('No model is ready yet. Run /login to set an API key first.\n', 'yellow'))
      return
    }
    let created: ScheduledRunInfo
    try {
      created = store.create({
        name: loopScheduleName(parsed.task),
        spec: parsed.spec,
        prompt: parsed.task,
        workspace: opts.cwd,
        providerId,
        model,
        approvalPolicy: policy,
        reasoningEffort: effort
      })
    } catch (e) {
      deps.io.out(paint(`· ${stripControlChars((e as Error).message)}\n`, 'yellow'))
      return
    }
    const next = created.nextRunAt !== null ? `, next at ${scheduleWhen(created.nextRunAt, nowFn())}` : ''
    deps.io.out(
      paint(
        `· scheduled "${stripControlChars(created.name)}": ${stripControlChars(created.spec)}${next}. Each run is a background session in this folder while Houston is open; /schedule lists them, and /schedule pause <n> or /schedule delete <n> stops one.\n`,
        'dim'
      )
    )
  }
  /**
   * Run /tasks. Mid-run (typed while a turn streams) it only prints, with no prompt or
   * picker: the run owns the screen and the input, and an approval may need them.
   */
  const runTasks = async (op: TasksOp, midRun: boolean): Promise<void> => {
    // Mid-run the cursor sits on the spinner row: start below it, as steering does.
    if (midRun) deps.io.out('\n')
    if (op.op === 'usage') {
      deps.io.out(paint(`${TASKS_USAGE}\n`, 'dim'))
      return
    }
    const rows = currentTasks()
    if (op.op === 'show') return showTask(rows, op.index)
    if (op.op === 'kill') return killTask(rows, op.index)
    if (!deps.backgroundTasks) {
      deps.io.out(paint('· background shells are unavailable here; listing subagents only\n', 'dim'))
    }
    if (midRun || !rows.length || !deps.io.select) {
      deps.io.out(`${renderTaskList(rows, nowFn(), paint, columns())}\n`)
      return
    }
    const r = await deps.io.select(taskPickerSpec(rows, nowFn(), columns()))
    if (r.kind === 'commit') showTask(rows, Number(r.value) + 1)
    else if (r.kind === 'action' && r.id === 'kill' && r.value !== null) killTask(rows, Number(r.value) + 1)
    else if (r.kind === 'type') deps.io.out(`${renderTaskList(rows, nowFn(), paint, columns())}\n`)
  }
  // A line typed mid-run goes to the turn that is running, so "no, not that" lands
  // while it can still change the outcome. With no live run there is nothing to
  // steer, and the io layer queues it as a follow-up instead. A slash command is
  // never steering: injected into the run it reached the model as the literal text
  // "/plan" and the command never ran. Declining it queues it, so it runs as a
  // command once the turn ends.
  deps.io.onSteer?.((typed, id) => {
    if (!activeRunId) return false
    // An MCP prompt's command is a command even before its server's prompts are read:
    // it waits for the turn, like any other, rather than reaching the model as text.
    if (isMcpPromptLine(typed.trim())) return false
    const slash = parseSlashCommand(typed.trim(), deps.getSettings(), templateCommands)
    // /tasks only reads the task lists or stops one task, so it runs now rather than
    // waiting for the turn: that is when you want to see what the turn started.
    if (slash.kind === 'tasks') {
      runTasks(slash.op, true).catch(() => {})
      return 'handled'
    }
    // /queue manages what waits for this turn, so it too runs now.
    if (slash.kind === 'queue') {
      runQueue(slash.op, true)
      return 'handled'
    }
    if (slash.kind !== 'not-a-command' && slash.kind !== 'unknown') return false
    // A `!` line is a shell escape, never text for the model: declined, it queues and
    // runs in your shell once the turn ends (it adds its output to the chat, which
    // can't happen while the turn is writing it).
    if (parseShellEscape(typed.trim()) !== null) return false
    // The same invisible-character strip as a message sent from the composer.
    const cleaned = stripInvisible(typed)
    if (!cleaned.text.trim()) return false
    const took = deps.steerRun?.(activeRunId, cleaned.text, id) ?? false
    if (took && cleaned.removed) deps.io.out(paint(`\n· ${invisibleNote(cleaned.removed)}\n`, 'dim'))
    return took
  })
  // Up on an empty mid-run line takes the newest steer back, if the run has not read it.
  deps.io.onUnsteer?.((id) => (activeRunId ? (deps.unsteerRun?.(activeRunId, id) ?? false) : false))
  // Ctrl-C. Also called by a picker that took the key itself (an approval, a question,
  // a plan), so it stops the run there as it does everywhere else while one works.
  const interrupt = (): void => {
    if (compactAbort) {
      compactAbort.abort()
      return
    }
    if (activeRunId) {
      deps.cancelRun(activeRunId)
      deps.io.stopSpinner?.()
      flushStreamedText()
      // Whatever was queued was a follow-up to the turn being thrown away: held back
      // as the next prompt's draft rather than sent into the wreckage.
      interruptedQueued = [...(interruptedQueued ?? []), ...(deps.io.takeQueued?.() ?? [])]
      // Show that the interrupt registered — otherwise an aborted turn just stops
      // with no feedback — then release any approval/question prompt blocked on
      // input so the aborted run doesn't leave the loop waiting on a dead read.
      deps.io.out(paint('\n^C interrupted\n', 'dim'))
      deps.io.cancelRead?.()
      return
    }
    // A /btw side chat is working: there is no run to cancel, but the user is waiting
    // on it with the spinner up, so stop it and hand the composer back.
    if (stopSideChat) {
      stopSideChat()
      return
    }
    // A between-turn sub-prompt (the /resume picker, /login, plan handoff, …) also
    // reads with no active run. Ctrl-C there should just cancel that read, NOT set
    // the composer reset/exit flag (which the sub-prompt never consumes — it would
    // leak into the next composer read and swallow a later Ctrl-D) or advance the
    // double-tap timer.
    if (!atComposer) {
      deps.io.cancelRead?.()
      return
    }
    // No run, at the composer → discard whatever's typed and re-prompt; a second
    // Ctrl-C in quick succession exits (the composer read loop acts on the flag).
    const t = nowFn()
    if (t - lastComposerCtrlCAt < 1500) {
      composerInterrupt = 'exit'
    } else {
      composerInterrupt = 'reset'
      deps.io.clearLine?.() // erase the abandoned input line
      deps.io.out(paint('(Ctrl-C again or Ctrl-D to exit)\n', 'dim'))
    }
    lastComposerCtrlCAt = t
    deps.io.cancelRead?.() // settle the outstanding composer read so the loop reacts
  }
  deps.io.onInterrupt?.(interrupt)

  // Kick the update check off now, but never await it: the answer is printed at
  // the next composer draw (see updateNotice), where a write is safe.
  let updateNotice: string | null = null
  if (deps.checkUpdate) {
    void deps.checkUpdate()
      .then((u) => {
        if (!u) return
        const head = u.headline ? `: ${u.headline}` : ''
        updateNotice =
          paint(`· update available: ${u.latest} (you have ${deps.version ?? 'this build'})${head}`, 'yellow') +
          // The upgrade command for how this copy was installed, when the host knows it.
          paint(`\n  ${u.hint ?? u.url}`, 'dim')
      })
      .catch(() => {
        /* a failed update check is a non-event */
      })
  }

  // Global rules moved to ~/.houston/AGENTS.md; ~/.claude/CLAUDE.md is no longer
  // loaded unless imported. Checked (and so recorded as shown) only at the first
  // composer draw, right where it prints: checking at startup would use it up on a
  // launch that exits before then (e.g. from first-run model setup), unseen.
  let rulesNoticeChecked = false

  deps.io.signal?.({ title: idleTitle(workspaceName) })
  // --continue / --resume: open the chat before the first prompt, so picking up
  // where you left off is the launch itself rather than a step after it.
  if ((opts.continueSession || opts.resumeId) && deps.persist) {
    const wanted = opts.resumeId
    let entry: Pick<ResumeEntry, 'id' | 'title'> | undefined
    try {
      // --resume <id> opens that chat wherever it was saved, not only among this
      // folder's newest (the host has already moved the session into its folder).
      entry = wanted
        ? (deps.persist.list(opts.cwd).find((c) => c.id === wanted) ??
          (deps.persist.get(wanted) ? { id: wanted, title: deps.persist.title?.(wanted) ?? 'New chat' } : undefined))
        : deps.persist.list(opts.cwd)[0]
    } catch {
      entry = undefined
    }
    // An explicit --resume <id> that isn't there is a mistake worth naming; a
    // --continue with nothing to continue is just a fresh start.
    const conv = entry ? deps.persist.get(entry.id) : null
    if (conv) {
      conversationId = entry!.id
      messages = conv.messages
      loadSavedDraft()
      deps.io.out(
        paint(`· continuing "${terminalText(entry!.title, { lines: false })}" (${plural(messages.length, 'message')})\n`, 'dim')
      )
      const recap = renderRecap(messages, paint, { width: columns() })
      if (recap) deps.io.out(`${recap}\n`)
      const ended = runEndNotice(messages)
      if (ended) deps.io.out(paint(`${ended}\n`, 'yellow'))
      // What the launch flags set wins over the chat's own for this session, as it
      // does for a headless --resume: `--approval plan` on a chat saved in full-auto
      // must not quietly run it in full-auto.
      const { providerId: _p, model: _m, approvalPolicy: _a, ...rest } = conv
      adoptChatSettings({
        ...rest,
        ...(opts.providerId || opts.model ? {} : { providerId: conv.providerId, model: conv.model }),
        ...(opts.approvalPolicy ? {} : { approvalPolicy: conv.approvalPolicy }),
        ...(opts.effort ? { reasoningEffort: opts.effort } : {})
      })
      applyLaunchTitle()
    } else if (wanted) {
      deps.io.out(paint(`· no saved session "${terminalText(wanted, { lines: false })}"; starting fresh\n`, 'yellow'))
    } else {
      deps.io.out(paint('· no saved session in this folder yet; starting fresh\n', 'dim'))
    }
  }
  // A new chat: the folder's new-chat draft, left there by a quit before its first send.
  if (!conversationId) loadSavedDraft()

  // Alt-T, at the composer or mid-run: the live turn's next thought already follows it.
  deps.io.onCycleThoughts?.(() => setReasoningDisplay(nextReasoningDisplay(reasoningDisplay)))
  // Ctrl-B mid-run: the command the agent is waiting on goes on in the background, and
  // the turn carries on with its shell id. `/tasks` lists it from then on.
  deps.io.onBackground?.(() => {
    const moved = activeRunId ? (deps.backgroundShells?.(activeRunId) ?? 0) : 0
    const note = moved
      ? `· moved ${moved === 1 ? 'the running command' : `${moved} running commands`} to the background; /tasks lists ${moved === 1 ? 'it' : 'them'}`
      : '· no command is running to move to the background (Ctrl-B moves a running shell command)'
    deps.io.out(`${flushPendingOutput()}${paint(note, 'dim')}\n`)
  })
  // Ctrl-O and /transcript: the whole session full screen. Not while a turn runs:
  // the viewer would have to hold back the run's output and its approval prompts,
  // so it says when it can open instead. In screen-reader mode there is no full
  // screen: the transcript is printed as plain lines, in order, for the reader.
  const openTranscript = async (): Promise<void> => {
    if (screenReader) {
      const plainDoc = transcriptPlain([...messages], currentTitle() ?? 'Houston chat').replace(/\n*$/, '')
      deps.io.out(`\n${plainDoc}\n\nend of transcript\n`)
      return
    }
    if (!deps.io.pager) {
      deps.io.out(paint('· the transcript viewer needs an interactive terminal; /export writes the chat to a file\n', 'dim'))
      return
    }
    const title = currentTitle() ?? 'Houston chat'
    const shown = [...messages]
    const opened = await deps.io.pager({
      title,
      render: (width) => renderTranscript(shown, paint, { width }),
      plain: () => transcriptPlain(shown, title)
    })
    if (!opened) {
      deps.io.out(paint('· the transcript viewer could not open here; /export writes the chat to a file\n', 'dim'))
    }
  }
  deps.io.onTranscript?.(async (during) => {
    if (during === 'run') {
      deps.io.out(`${flushPendingOutput()}${paint('· the transcript opens at the prompt once this turn ends (Ctrl-O or /transcript)', 'dim')}\n`)
      return
    }
    await openTranscript()
  })

  // Shift-Tab, at the composer or mid-run. Mid-run it also retargets the live run,
  // so you can loosen the mode to get past an approval without killing the turn.
  deps.io.setMode?.(policy)
  // Set once the custom status line is set up below: a mode change reruns it.
  let onModeChange = (): void => {}
  deps.io.onCycleMode?.(() => {
    policy = nextPolicy(policy)
    deps.io.setMode?.(policy)
    onModeChange()
    if (activeRunId) {
      deps.setRunPolicy?.(activeRunId, policy)
      deps.io.out(`${flushPendingOutput()}${paint(`\n· approval → ${APPROVAL_POLICY_LABEL[policy]} (this run too)\n`, 'dim')}`)
    } else if (screenReader) {
      // The arrow-key composer shows the mode in its prompt; a screen reader is told.
      deps.io.out(`approval: ${APPROVAL_POLICY_LABEL[policy]}\n`)
    }
  })

  deps.io.out(
    `${paint('Houston', 'bold', 'cyan')} ${paint(deps.version ? `v${deps.version}` : '', 'dim')} ${paint('(interactive)', 'dim')}\n` +
      // `~` for the home folder keeps the usual path on one line; /cwd prints it in full.
      `${paint(`  cwd:      ${homeRelative(opts.cwd)}`, 'dim')}\n` +
      `${paint(
        providerId && model
          ? `  model:    ${providerId} / ${model}`
          : '  model:    (none yet, /login to set a key)',
        'dim'
      )}\n` +
      `${paint(`  approval: ${APPROVAL_POLICY_LABEL[policy]}`, 'dim')}\n` +
      `${paint('  /help for commands and keys, Ctrl-D to exit', 'dim')}\n` +
      // Seconds since the epoch: a different pair of tips on each launch.
      pickTips(Math.floor(nowFn() / 1000))
        .map((t) => `${paint(`  tip: ${t}`, 'dim')}\n`)
        .join('')
  )
  // Mistakes in ~/.houston/keybindings.json: said once at startup, and again only when
  // a later save of the file has different ones. Never fatal: the rest of it applies.
  const reportKeybindingProblems = (): void => {
    const problems = deps.keybindings?.takeProblems() ?? []
    if (problems.length) deps.io.out(formatKeybindingProblems(problems, paint))
  }
  reportKeybindingProblems()
  deps.keybindings?.onProblems(reportKeybindingProblems)

  // After the chat you're in is deleted (/delete, or from the /resume picker): what
  // was this chat's is dropped, and the next turn starts a fresh one.
  const forgetDeletedChat = (): void => {
    leaveChatDraft()
    messages = []
    conversationId = null
    persistedSettings = null
    resetChatState() // /context and /undo must not act on the deleted chat
  }

  /**
   * The arrow-key `/resume` picker: rows filter live as you type (a title and content
   * search), the highlighted chat is previewed under the list, Ctrl-R renames and
   * Ctrl-D or `x` deletes in place, 1-9 open a row, and Ctrl-A switches between this
   * folder and every folder. Resolves the chosen id, null on cancel, or undefined when
   * the terminal can't show a picker (the caller falls back to the numbered list).
   */
  const pickSession = async (
    persist: TuiPersist,
    select: (spec: PickerSpec) => Promise<PickerOutcome>,
    query: string,
    initial: ResumeEntry[]
  ): Promise<string | null | undefined> => {
    const canScope = Boolean(persist.listAll && persist.searchAll)
    let all = false
    let deletedCurrent: string | null = null
    const byId = new Map<string, ResumeEntry>()
    // Each chat is read once per picker for its preview (and the delete question).
    const read = new Map<string, ChatMessage[] | null>()
    const messagesOf = (id: string): ChatMessage[] | null => {
      if (!read.has(id)) {
        try {
          read.set(id, persist.get(id)?.messages ?? null)
        } catch {
          read.set(id, null)
        }
      }
      return read.get(id) ?? null
    }
    const fetch = (q: string): ResumeEntry[] =>
      all
        ? q
          ? persist.searchAll!(q)
          : persist.listAll!()
        : q
          ? persist.search(opts.cwd, q)
          : persist.list(opts.cwd)
    const toOptions = (list: ResumeEntry[]): PickerOption[] => {
      byId.clear()
      const now = nowFn()
      return list.map((c, i) => {
        byId.set(c.id, c)
        const row = renderSessionRow(c, i, { now, paint, showFolder: all, current: c.id === conversationId })
        return { value: c.id, label: row.label, detail: row.detail }
      })
    }
    const titleOf = (id: string | null): string =>
      stripControlChars((id && byId.get(id)?.title) || '') || 'New chat'
    const heading = (): string => (all ? 'Sessions in all folders' : 'Sessions in this folder')
    const rows = (q: string): PickerOption[] => {
      try {
        return toOptions(fetch(q))
      } catch {
        return toOptions([])
      }
    }
    const actions: PickerAction[] = []
    if (persist.rename) {
      actions.push({ id: 'rename', keys: ['ctrl-r'], input: { label: 'new title', initial: (o) => titleOf(o.value) } })
    }
    if (persist.remove) {
      actions.push({
        id: 'delete',
        keys: ['ctrl-d'],
        confirm: (o) => {
          const title = titleOf(o.value)
          if (o.value === conversationId) {
            return `Delete "${title}"? It's the chat you're in: you'll be in a new chat. This cannot be undone.`
          }
          const msgs = messagesOf(o.value)
          const count = msgs ? ` and its ${plural(msgs.length, 'message')}` : ''
          return `Delete "${title}"${count}? This cannot be undone.`
        }
      })
    }
    if (persist.pin) actions.push({ id: 'pin', keys: ['ctrl-p'] })
    if (persist.archive) actions.push({ id: 'archive', keys: ['ctrl-e'] })
    if (canScope) actions.push({ id: 'scope', keys: ['ctrl-a'], global: true })
    const hint = (): string =>
      sessionPickerHint({
        rename: !!persist.rename,
        remove: !!persist.remove,
        scope: canScope,
        all,
        pin: !!persist.pin,
        archive: !!persist.archive
      })
    const outcome = await select({
      title: heading(),
      options: toOptions(initial),
      filter: true,
      initialQuery: query,
      onQuery: rows,
      digitCommits: true,
      maxRows: 9,
      empty: query ? 'no sessions match' : 'no saved sessions here yet',
      hint: hint(),
      actions,
      preview: (o, width) => {
        const c = byId.get(o.value)
        if (!c) return []
        return sessionPreviewLines(c, messagesOf(c.id), {
          width,
          paint,
          when: formatRelativeTime(c.updatedAt, nowFn()),
          ...(all && c.workspace ? { folder: sessionFolder(c.workspace) } : {})
        })
      },
      onAction: async (req) => {
        if (req.id === 'scope') {
          all = !all
          // The hint names the other scope, so it changes too.
          return {
            options: rows(req.query.trim()),
            title: heading(),
            hint: hint(),
            notice: all ? 'showing all folders' : 'showing this folder'
          }
        }
        const id = req.value
        if (!id) return { notice: 'nothing selected' }
        const title = titleOf(id)
        if (req.id === 'rename') {
          const next = stripControlChars(req.text ?? '').trim()
          if (!next || next === title) return { notice: 'title unchanged' }
          persist.rename!(id, next)
          return { options: rows(req.query.trim()), notice: `renamed to "${next}"` }
        }
        // The desktop sidebar's Pin and Archive: an archived chat leaves this list (the
        // app's Archived section has it), and a pinned one is marked here and pinned there.
        if (req.id === 'pin') {
          const pinned = !byId.get(id)?.pinned
          persist.pin!(id, pinned)
          return { options: rows(req.query.trim()), notice: pinned ? `pinned "${title}"` : `unpinned "${title}"` }
        }
        if (req.id === 'archive') {
          persist.archive!(id)
          return { options: rows(req.query.trim()), notice: `archived "${title}"; the desktop app's Archived section has it` }
        }
        if (req.id === 'delete') {
          // The picker asks one yes/no, so a worktree holding work is kept (the safe
          // choice; /delete inside the chat offers removal) and a clean, merged one goes
          // with the chat, as in the desktop app.
          let plan: TuiDeletePlan = { kind: 'plain', shared: false }
          try {
            // Never the worktree this session runs in: it would go from under the session.
            if (persist.planDelete) plan = planForSession(await persist.planDelete(id), opts.cwd)
          } catch {
            // No plan: a plain delete, which keeps any worktree.
          }
          let removed: DeleteConversationResult | void
          try {
            removed = await persist.remove!(id, { plan, removeWorktree: plan.kind === 'disposableWorktree' })
          } catch (e) {
            return { notice: `couldn't delete: ${(e as Error).message}` }
          }
          const wtNote = deleteWorktreeOutcome(plan, removed)
          const tail = wtNote ? `; ${stripControlChars(wtNote)}` : ''
          read.delete(id)
          if (id === conversationId) {
            forgetDeletedChat()
            deletedCurrent = title
            return { options: rows(req.query.trim()), notice: `deleted "${title}", the chat you were in${tail}` }
          }
          return { options: rows(req.query.trim()), notice: `deleted "${title}"${tail}` }
        }
        return {}
      }
    })
    // Say it in the transcript too: the picker's notice goes with the picker.
    if (deletedCurrent) deps.io.out(paint(`· deleted "${deletedCurrent}"; this is a new chat\n`, 'dim'))
    if (outcome.kind === 'commit') return outcome.value
    if (outcome.kind === 'type') return undefined
    return null
  }

  // The tab title follows the chat's title (derived from its first message, generated,
  // or chosen with --name or /rename). Re-read at each prompt and when a generated one
  // lands; written only when it changed.
  let tabChatTitle: string | null = null
  const syncTabTitle = (title: string | null = currentTitle()): void => {
    if (title === tabChatTitle) return
    tabChatTitle = title
    if (!activeRunId) deps.io.signal?.({ title: idleTitle(workspaceName, tabChatTitle) })
  }
  const requestGeneratedTitle = (): void => {
    if (!deps.generateTitle || !conversationId || !providerId || !model) return
    const id = conversationId
    deps.generateTitle(id, providerId, model, (title) => {
      if (id === conversationId) syncTabTitle(title)
    })
  }

  // The custom status line (`statusLine`): the user's command, or a trusted project's.
  // Resolved once at launch; a run that fails keeps the last good output, and before
  // any good output the built-in line shows.
  let statusRunner: StatusLineRunner | null = null
  let statusSource: ResolvedStatusLine | null = null
  if (deps.runStatusLine) {
    const user = deps.getSettings().statusLine
    let project: { config: StatusLineConfig | null; trusted: boolean } = { config: null, trusted: false }
    if (deps.projectStatusLine && !resolveStatusLine(user, null, () => false)) {
      try {
        project = await deps.projectStatusLine()
      } catch {
        // An unreadable project config has no status line.
      }
    }
    statusSource = resolveStatusLine(user, project.config, () => project.trusted)
    if (statusSource) {
      statusRunner = new StatusLineRunner(
        statusSource,
        deps.runStatusLine,
        () => {
          if (atComposer) deps.io.redrawComposer?.()
        },
        nowFn
      )
    }
  }
  const worktreeRoot = statusRunner ? linkedWorktreeRoot(opts.cwd) : null
  onModeChange = () => {
    if (!activeRunId) void statusRunner?.refresh(statusPayload())
  }
  const statusPayload = (): StatusLinePayload => ({
    version: deps.version ?? null,
    sessionId: conversationId,
    title: tabChatTitle,
    provider: providerId,
    model,
    effort,
    approvalMode: policy,
    cwd: opts.cwd,
    branch,
    worktree: worktreeRoot,
    contextPercent: model ? contextPercent(contextTokens, contextWindowFor(model)) : null,
    contextTokens,
    cost: {
      usd: sessionCost.cost,
      inputTokens: sessionCost.inputTokens,
      outputTokens: sessionCost.outputTokens,
      unknown: sessionCost.costUnknown === true
    },
    vimMode: deps.getSettings().tuiEditor === 'vim' ? 'insert' : null
  })
  // Rerun it on an interval while the composer is open, when the setting asks.
  let stopStatusTimer = (): void => {}
  if (statusRunner?.config.refreshSeconds) {
    const timer = setInterval(() => {
      if (atComposer && !activeRunId) void statusRunner?.refresh(statusPayload())
    }, statusRunner.config.refreshSeconds * 1000)
    timer.unref?.()
    stopStatusTimer = () => clearInterval(timer)
  }
  /** The status rows the composer shows: the command's last good output, else the built-in line. */
  const statusRows = (builtIn: string): string[] => {
    const rows = statusRunner?.lines() ?? []
    return rows.length ? rows : [builtIn]
  }

  for (;;) {
    // The update check resolves whenever it resolves; print it HERE, between turns,
    // where nothing else owns the screen. Writing it from the promise would land in
    // the middle of the composer's redraw region (or a streaming turn) and corrupt it.
    if (!rulesNoticeChecked) {
      rulesNoticeChecked = true
      try {
        const news = deps.takeWhatsNew?.()
        if (news) deps.io.out(`${renderWhatsNew(news, paint)}\n`)
      } catch {
        /* a failed check is a non-event */
      }
      let due = false
      try {
        due = deps.takeLegacyRulesNotice?.() === true
      } catch {
        /* a failed check is a non-event */
      }
      if (due) {
        deps.io.out(
          `${paint(
            '· global rules now live in ~/.houston/AGENTS.md; ~/.claude/CLAUDE.md is no longer loaded\n' +
              '  to keep it, add this line there: @~/.claude/CLAUDE.md',
            'yellow'
          )}\n`
        )
      }
    }
    if (updateNotice) {
      deps.io.out(`${updateNotice}\n`)
      updateNotice = null // one nudge per session, not per prompt
    }
    // A persistent status line above the composer: model, policy, cwd, cost, and
    // context-window fill — so live session state is always visible. Before a
    // provider is set up it shows a "no model" prompt pointing at /login instead.
    refreshBranch()
    syncTabTitle()
    const builtInStatus = (): string =>
      providerId && model
        ? renderStatusLine(
            {
              providerId,
              model,
              policy,
              cwd: opts.cwd,
              cost: sessionCost,
              contextTokens,
              branch,
              quota: footerQuota(providerId, providerQuota(providerId, model)),
              effort,
              modelReasons: activeModelReasons(deps, providerId, model) ?? modelCapabilities(model).reasoning
            },
            columns(),
            paint
          )
        : renderNoModelStatus(policy, opts.cwd, columns(), paint)
    // A custom status line: refreshed now (waited for, up to its timeout, only on its
    // first run, so a command that keeps failing never slows the prompt; otherwise the
    // last output shows and the new one redraws in).
    // With the raw-mode composer it rides in the composer's redraw region, so a refresh
    // repaints it in place; otherwise it prints here like the built-in line.
    let statusHeader: (() => string[]) | undefined
    if (statusRunner) {
      const refreshing = statusRunner.refresh(statusPayload())
      if (!statusRunner.lines().length && !statusRunner.lastFailure()) await refreshing
      if (deps.io.readComposer && !pendingQueued.length) statusHeader = () => statusRows(builtInStatus())
      else deps.io.out(`${statusRows(builtInStatus()).join('\n')}\n`)
    } else deps.io.out(`${builtInStatus()}\n`)
    // Read a message. On a real terminal this is the raw-mode editor, which takes a
    // pasted block whole (bracketed paste) and edits multi-line drafts in place.
    // Without one (tests, a pipe) it falls back to reading physical lines, where a
    // trailing backslash or an open code fence continues onto the next line.
    let raw: string | null = null
    let resetComposer = false
    // Set when a key (Esc Esc) stood in for typing a command: nothing to save to history.
    let fromKey = false
    atComposer = true // Ctrl-C now means "clear/exit the composer" (see onInterrupt)
    // Ctrl-C settles either read: 'reset' discards this entry and re-prompts, 'exit'
    // (a second Ctrl-C) leaves like Ctrl-D; otherwise a null is a real EOF.
    const consumeInterrupt = (): 'reset' | 'exit' | null => {
      const flag = composerInterrupt
      composerInterrupt = null
      return flag
    }
    if (pendingQueued.length) {
      // Typed while the last turn ran. Dispatch it instead of prompting: waiting for
      // an Enter they already pressed would be the exact tax queueing removes.
      // A command among them runs as itself, one entry per pass: joined, "/compact" then
      // "/cost" became one message the second command vanished into, and a steer
      // followed by "/plan" reached the model as text.
      if (pendingQueued.some((q) => /^[/!#]/.test(q.trim()))) {
        raw = pendingQueued[0]
        pendingQueued = pendingQueued.slice(1)
      } else {
        raw = pendingQueued.join('\n\n')
        pendingQueued = []
      }
      deps.io.out(`${composerPrompt(policy, paint, screenReader)}${raw}\n`)
    } else if (deps.io.readComposer) {
      // A thunk, not a string: Shift-Tab can change the policy WHILE this read is
      // open, and the prompt has to say what will actually happen when you hit Enter.
      const draft = restoreDraft
      restoreDraft = ''
      const half = halfDraft
      halfDraft = ''
      const kept = keptDraft
      keptDraft = ''
      if (draft) deps.io.out(paint('· not sent (the turn was interrupted): back in the prompt to edit or send\n', 'dim'))
      // The draft this chat had when it was last open (or when Houston last quit).
      const saved = savedDraft ? draftRestoreText(savedDraft) : ''
      if (saved) deps.io.out(paint(`${draftRestoreNote(savedDraft!)}\n`, 'dim'))
      savedDraft = null
      const initial = [draft, kept, half, saved].filter(Boolean).join('\n\n')
      const text = await deps.io.readComposer(() => composerPrompt(policy, paint, screenReader, pendingImages.length), initial || undefined, {
        onDraft: (t) => saveDraft({ text: t, queued: [] }),
        // Read on each redraw: what the keyword would do on this chat's model right now.
        ultrathinkEffect: () =>
          ultrathinkEffect(
            effort,
            activeModelReasons(deps, providerId, model) ?? (model ? modelCapabilities(model).reasoning : false),
            activeModelSendsXhigh(deps, providerId, model)
          ),
        ...(statusHeader ? { header: statusHeader } : {}),
        // The suggested next message, dim in the empty composer (Tab takes it). It can
        // land while this read is open, so the composer subscribes a redraw.
        suggestion: () => suggestion ?? undefined,
        watchSuggestion: (redraw) => {
          redrawSuggestion = redraw
          return () => {
            if (redrawSuggestion === redraw) redrawSuggestion = null
          }
        }
      })
      if (text === null && rewindRequested) {
        // Esc Esc on an empty composer: the same picker /rewind opens.
        rewindRequested = false
        raw = '/rewind'
        fromKey = true
      } else if (text === null) {
        resetComposer = consumeInterrupt() === 'reset'
      } else {
        raw = text
      }
    } else {
      // No editor to put it back into: show it, so it can at least be copied.
      if (restoreDraft) {
        deps.io.out(paint(`· not sent (the turn was interrupted): ${stripControlChars(restoreDraft)}\n`, 'dim'))
        restoreDraft = ''
      }
      const composer = new ComposerBuffer()
      for (;;) {
        // In an open code fence, hint how to send so a stray ``` can't trap the
        // composer with no visible way out (typing the closing ``` submits).
        const p = composer.pending
          ? paint(composer.inFence ? '… (``` to close and send) ' : '… ', 'dim')
          : composerPrompt(policy, paint, screenReader, pendingImages.length)
        const line = await deps.io.readLine(p)
        if (line === null) {
          const flag = consumeInterrupt()
          if (flag === 'reset') {
            resetComposer = true
            break
          }
          if (flag === 'exit') break // raw stays null → exit below
          if (composer.pending) raw = composer.flush() // EOF mid-entry → submit what we have
          break
        }
        const done = composer.push(line)
        if (done !== null) {
          raw = done
          break
        }
      }
    }
    atComposer = false // sub-prompts below are not the composer
    // What was typed is now on its way (a turn or a command): the saved draft is what
    // is still held, if anything. A Ctrl-C or a quit leaves the saved draft as it was.
    if (raw !== null) saveHeldDraft()
    // Background work finished while the composer was idle: its news is this turn's
    // input. Taken now, not when it arrived, so a draft typed meanwhile still wins.
    let wakeTurn = false
    // What the wake note carries from outside (see ChatMessage.taintSource), kept on
    // the turn's message so the memory taint rule still sees it.
    let wakeTaint: string | undefined
    if (wakeRequested) {
      wakeRequested = false
      const taken = raw === null && !resetComposer && conversationId ? deps.wake?.take(conversationId) : null
      const note = typeof taken === 'string' ? taken : (taken?.content ?? null)
      if (note) {
        raw = note
        wakeTurn = true
        if (taken && typeof taken === 'object') wakeTaint = taken.taintSource
        deps.io.out(paint('· background work finished; continuing on its own\n', 'dim'))
      } else if (raw === null && !resetComposer) continue
    }
    if (resetComposer) continue // Ctrl-C discarded the input — draw a fresh prompt
    if (raw === null) break // clean Ctrl-D (or a second Ctrl-C) at the composer → exit
    let text = raw.trim()
    // Characters that draw nothing (zero-width, bidi overrides, tag characters) can
    // hide text the user never saw; send what they reviewed. Not on a message
    // Houston wrote itself (a background wake).
    if (!wakeTurn && !fromKey) {
      const cleaned = stripInvisible(text)
      if (cleaned.removed) {
        text = cleaned.text.trim()
        deps.io.out(paint(`· ${invisibleNote(cleaned.removed)}\n`, 'dim'))
      }
    }
    if (!text) continue
    // Set when this turn's text is a prompt Houston wrote for a command (/review,
    // /agent): saved on the message so every client shows the command, not the prompt.
    let invokedAs: PromptInvocation | undefined
    // A custom command's per-turn model, effort and pre-approved tools (its
    // frontmatter): this one turn only, never saved as the chat's settings.
    let turnRun: PreparedCommandRun | null = null
    // Where this turn's text came from when the user didn't write it (an MCP prompt's
    // server): saved on the message as its taintSource.
    let turnTaint: string | undefined
    // Persist composer submissions (commands included) for cross-restart recall;
    // approval/question answers go through a different read and aren't saved.
    if (!wakeTurn && !fromKey) deps.persistHistory?.(text)

    // `#note` — remember this for next time. Checked with the other prefixes, before
    // the line is treated as something to say to the model. A line can start with `#`
    // without being a note ("#123 is failing", a pasted "# Spec"), so sending it as a
    // message is one of the answers, as it is in the desktop app.
    const memory = parseMemoryCapture(text)
    if (memory !== null) {
      if (!deps.saveMemory) {
        deps.io.out(paint('· remembering instructions is unavailable here\n', 'dim'))
        continue
      }
      let choice: MemoryScope | 'send' | null = null
      let typed = true
      // An answer the numbered list (screen-reader mode) already took, so it isn't asked again.
      let typedScope: string | undefined
      if (deps.io.select) {
        const r = await deps.io.select({
          title: 'Remember this where?',
          typeLabel: null,
          options: [
            { label: 'This project', value: 'project', description: 'everyone working in this repo', key: 'p' },
            { label: 'Everywhere', value: 'global', description: 'you, in every project', key: 'e' },
            { label: 'Send as message', value: 'send', description: 'to the agent, not remembered', key: 's' }
          ]
        })
        if (r.kind === 'commit') choice = r.value as MemoryScope | 'send'
        // Esc (or Ctrl-C) steps back: nothing saved, nothing sent.
        typed = r.kind === 'type'
        if (r.kind === 'type') typedScope = r.text
      }
      if (choice === null && typed) {
        const ans =
          typedScope ??
          (await deps.io.readLine('Remember for [p]roject or [e]verywhere, or [s]end as a message? ', {
            discardPending: true
          }))
        const a = (ans ?? '').trim().toLowerCase()
        if (a === 'p' || a === 'project') choice = 'project'
        else if (a === 'e' || a === 'everywhere' || a === 'g' || a === 'global') choice = 'global'
        else if (a === 's' || a === 'send') choice = 'send'
      }
      if (choice === null) {
        // The line goes back to the composer rather than being dropped.
        keptDraft = text
        deps.io.out(
          paint(deps.io.readComposer ? '· not remembered: back in the prompt to edit or send\n' : '· not remembered\n', 'dim')
        )
        continue
      }
      if (choice !== 'send') {
        try {
          const where = await deps.saveMemory(choice, memory)
          deps.io.out(paint(`· remembered in ${where}\n`, 'dim'))
        } catch (e) {
          deps.io.out(paint(`· couldn't remember that: ${(e as Error).message}\n`, 'yellow'))
        }
        continue
      }
      // 'send': on to the agent below, like any other message.
    }

    // `!cmd` — the user's own shell, checked before slash commands so a `!` line is
    // never mistaken for prompt text. Between turns, so writing output is safe.
    const shellCmd = parseShellEscape(text)
    if (shellCmd !== null) {
      if (!deps.runUserShell) {
        deps.io.out(paint('· the shell escape (!) is unavailable here\n', 'dim'))
        continue
      }
      deps.io.out(paint(`$ ${shellCmd}\n`, 'dim'))
      let captured = ''
      let code: number
      // The tail of a chunk that may continue in the next one (an escape sequence cut
      // by a pipe read, or a carriage return before its line feed): held back so the
      // filter sees it whole, rather than showing it as `<U+001B>[3` or `<U+000D>`.
      let carry = ''
      try {
        code = await deps.runUserShell(shellCmd, (chunk) => {
          // Stream it: a build or a test run should look alive, not hung. Its colours
          // stay, but nothing else in it (a file it printed, say) can drive the terminal.
          const [ready, held] = splitShellCarry(carry + chunk)
          carry = held
          if (ready) deps.io.out(filterTerminalOutput(ready))
          captured += chunk
        })
      } catch (e) {
        if (carry) deps.io.out(filterTerminalOutput(carry))
        deps.io.out(paint(`· couldn't run it: ${(e as Error).message}\n`, 'yellow'))
        continue
      }
      if (carry) deps.io.out(filterTerminalOutput(carry))
      if (code !== 0) deps.io.out(paint(`· exited ${code}\n`, 'yellow'))
      // Record it in the conversation, so "now fix those failures" works without
      // pasting the output back in — the whole reason to run it HERE rather than in
      // another window. Capped: a chatty command must not eat the context window.
      messages.push({ role: 'user', content: renderShellEscapeRecord(shellCmd, captured, code) })
      persistMessages(messages)
      continue
    }

    if (text.startsWith('/')) {
      // The connected MCP servers' prompts are read when one is typed: a server
      // connects with a turn, after the session's commands were loaded.
      const slashCommands = isMcpPromptLine(text) && deps.mcpPrompts
        ? mergeCommands(templateCommands, await deps.mcpPrompts.commands().catch((): Command[] => []))
        : templateCommands
      let result = parseSlashCommand(text, deps.getSettings(), slashCommands)
      if (result.kind === 'exit') break
      if (result.kind === 'clear') {
        subagentTracker.forget(conversationId)
        leaveChatDraft()
        messages = []
        conversationId = null // next turn starts (and persists) a fresh conversation
        persistedSettings = null // stored meta belongs to the old conversation
        resetChatState()
        deps.io.out(paint('· conversation cleared\n', 'dim'))
        continue
      }
      if (result.kind === 'resume') {
        if (!deps.persist) {
          deps.io.out(paint('· resume is unavailable (no session store)\n', 'dim'))
          continue
        }
        const query = result.query.trim()
        let convs: ResumeEntry[]
        try {
          convs = query ? deps.persist.search(opts.cwd, query) : deps.persist.list(opts.cwd)
        } catch (e) {
          deps.io.out(paint(`· couldn't list sessions: ${(e as Error).message}\n`, 'dim'))
          continue
        }
        // The arrow-key picker when the terminal has one: live filter, preview, and
        // rename/delete in place. `undefined` means it isn't available here, so fall
        // back to the numbered list and a typed answer. Screen-reader mode always takes
        // the numbered list: the picker's live filter, preview and in-place actions
        // all redraw, and its rows carry their own numbers, so the numbered rendering
        // of it would read "1. 1. title".
        let id: string | null | undefined
        const canScope = Boolean(deps.persist.listAll && deps.persist.searchAll)
        if (deps.io.select && !screenReader && (convs.length || canScope)) {
          id = await pickSession(deps.persist, deps.io.select, query, convs)
        }
        if (id === undefined) {
          deps.io.out(`${renderConversationList(convs, nowFn(), paint)}\n`)
          if (screenReader) deps.io.out(`${screenReaderResumeNote(deps.persist, canScope)}\n`)
          if (!convs.length) continue
          // discardPending like the other prompts, so type-ahead can't auto-select.
          const ans = await deps.io.readLine('> ', { discardPending: true })
          id = ans === null ? null : parseResumeSelection(ans, convs)
        }
        if (!id) {
          deps.io.out(paint('· cancelled\n', 'dim'))
          continue
        }
        let conv: ReturnType<TuiPersist['get']>
        try {
          conv = deps.persist.get(id)
        } catch (e) {
          deps.io.out(paint(`· couldn't load that session: ${(e as Error).message}\n`, 'dim'))
          continue
        }
        if (!conv) {
          deps.io.out(paint('· that session could not be loaded\n', 'dim'))
          continue
        }
        // A chat from another folder (Ctrl-A lists every folder, a worktree chat among
        // them) runs in its own folder: continued here, its turns would read and edit
        // this folder's files under that chat's history and approval mode.
        if (conv.workspace && resolvePath(conv.workspace) !== resolvePath(opts.cwd)) {
          deps.io.out(paint(`${otherFolderNote(conv.workspace, id)}\n`, 'yellow'))
          continue
        }
        leaveChatDraft()
        conversationId = id
        messages = conv.messages
        resetChatState()
        loadSavedDraft()
        deps.io.out(paint(`· resumed: ${plural(messages.length, 'message')}\n`, 'dim'))
        const recap = renderRecap(messages, paint, { width: columns() })
        if (recap) deps.io.out(`${recap}\n`)
        const ended = runEndNotice(messages)
        if (ended) deps.io.out(paint(`${ended}\n`, 'yellow'))
        adoptChatSettings(conv)
        continue
      }
      if (result.kind === 'export') {
        if (!messages.length) {
          deps.io.out(paint('· nothing to export yet; this chat has no messages\n', 'dim'))
          continue
        }
        if (!deps.writeExport && !(result.copy && !result.path)) {
          deps.io.out(paint('· export is unavailable here\n', 'dim'))
          continue
        }
        if (result.bad) {
          deps.io.out(
            paint(
              `· /export has no option ${stripControlChars(result.bad)}: use --copy, --no-reasoning, --no-tools or --no-redact\n`,
              'yellow'
            )
          )
          continue
        }
        const at = new Date(nowFn())
        const title = currentTitle() ?? 'Houston chat'
        const meta = { id: conversationId, title, providerId, model, at }
        const kept = { reasoning: !result.noReasoning, tools: !result.noTools }
        // Secrets are masked unless asked not to: an export is made to leave this machine.
        const redact = result.noRedact ? null : (deps.secretRedactor?.() ?? ((t: string) => redactSecrets(t)))
        const content =
          result.format === 'json'
            ? chatToJson(redact ? redactExport(messages, redact) : messages, meta, kept)
            : result.format === 'html'
              ? // The desktop app's self-contained HTML export (no scripts, no network).
                conversationToHtml({
                  id: conversationId ?? 'unsaved',
                  title,
                  workspace: opts.cwd,
                  providerId: providerId ?? '',
                  model: model ?? '',
                  createdAt: at.getTime(),
                  updatedAt: at.getTime(),
                  messages: redact ? redactExport(messages, redact) : messages
                })
              : chatToMarkdown(messages, meta, kept)
        const text = redact && result.format === 'md' ? redact(content) : content
        const masked = redact ? ' (secrets masked; --no-redact keeps them)' : ''
        if (result.copy) {
          const native = putOnClipboard(text, deps)
          const what = `this chat as ${result.format === 'json' ? 'JSON' : result.format === 'html' ? 'HTML' : 'Markdown'}`
          deps.io.out(
            paint(
              `✓ copied ${what} (${describeCopied(text)})${native ? '' : ', if your terminal allows clipboard access'}${masked}\n`,
              'green'
            )
          )
          if (!result.path) continue
        }
        const target = result.path ?? defaultExportName(title, at, result.format)
        if (!deps.writeExport) continue
        try {
          const written = deps.writeExport(target, text)
          deps.io.out(paint(`· exported ${plural(messages.length, 'message')} to ${stripControlChars(written)}${masked}\n`, 'dim'))
        } catch (e) {
          deps.io.out(paint(`· couldn't export: ${stripControlChars((e as Error).message)}\n`, 'yellow'))
        }
        continue
      }
      if (result.kind === 'import') {
        if (!result.path) {
          deps.io.out(paint('· usage: /import <file>, a chat exported as JSON or HTML\n', 'dim'))
          continue
        }
        if (!deps.importChat) {
          deps.io.out(paint('· import is unavailable here\n', 'dim'))
          continue
        }
        let imported: ImportedChat
        try {
          imported = deps.importChat(result.path)
        } catch (e) {
          deps.io.out(paint(`· couldn't import: ${terminalText((e as Error).message, { lines: false })}\n`, 'yellow'))
          continue
        }
        // Continue in the imported chat, as the desktop app opens it.
        conversationId = imported.id
        messages = imported.messages
        resetChatState()
        persistedSettings = null
        const shownTitle = terminalText(imported.title || 'Imported chat', { lines: false })
        deps.io.out(paint(`· imported "${shownTitle}" (${plural(messages.length, 'message')}); this chat is now that one\n`, 'dim'))
        if (imported.textOnly) {
          deps.io.out(paint('· only the chat text came back (an HTML export from an older version)\n', 'yellow'))
        }
        const recap = renderRecap(messages, paint, { width: columns() })
        if (recap) deps.io.out(`${recap}\n`)
        adoptChatSettings({ providerId: imported.providerId, model: imported.model })
        continue
      }
      if (result.kind === 'rename') {
        if (!deps.persist?.rename || !conversationId) {
          deps.io.out(
            paint(
              conversationId ? '· renaming is unavailable here\n' : '· nothing to rename yet; send a message first\n',
              'dim'
            )
          )
          continue
        }
        if (!result.title) {
          deps.io.out(paint(`· this chat is "${currentTitle() ?? 'New chat'}". /rename <title> changes it\n`, 'dim'))
          continue
        }
        try {
          deps.persist.rename(conversationId, result.title)
          deps.io.out(paint(`· renamed to "${terminalText(result.title, { lines: false })}"\n`, 'dim'))
        } catch (e) {
          deps.io.out(paint(`· couldn't rename: ${(e as Error).message}\n`, 'yellow'))
        }
        continue
      }
      if (result.kind === 'delete') {
        if (!deps.persist?.remove || !conversationId) {
          deps.io.out(
            paint(
              conversationId ? '· deleting is unavailable here\n' : '· nothing to delete; this chat is not saved yet\n',
              'dim'
            )
          )
          continue
        }
        const title = terminalText(currentTitle() ?? 'this chat', { lines: false })
        const deleting = conversationId
        let plan: TuiDeletePlan = { kind: 'plain', shared: false }
        try {
          // The worktree this session runs in stays: removing it would leave the session
          // (its next turn, `!` commands, the next new chat) in a folder that is gone.
          if (deps.persist.planDelete) plan = planForSession(await deps.persist.planDelete(deleting), opts.cwd)
        } catch {
          // No plan: a plain delete, which keeps any worktree.
        }
        // discardPending: type-ahead must not answer a question about deleting.
        const ans = await deps.io.readLine(
          paint(deletePromptText(plan, title, plural(messages.length, 'message')), 'yellow'),
          { discardPending: true }
        )
        const choice = parseDeleteAnswer(plan, ans)
        if (!choice.delete) {
          deps.io.out(paint('· kept\n', 'dim'))
          continue
        }
        let removed: DeleteConversationResult | void
        try {
          removed = await deps.persist.remove(deleting, { plan, removeWorktree: choice.removeWorktree })
        } catch (e) {
          deps.io.out(paint(`· couldn't delete: ${(e as Error).message}\n`, 'yellow'))
          continue
        }
        forgetDeletedChat()
        const wtNote = deleteWorktreeOutcome(plan, removed)
        deps.io.out(
          paint(`· deleted "${title}"${wtNote ? `; ${terminalText(wtNote, { lines: false })}` : ''}; this is a new chat\n`, 'dim')
        )
        continue
      }
      if (result.kind === 'permissions') {
        await runPermissionsCommand(
          result.op,
          {
            getSettings: deps.getSettings,
            ...(deps.updateSettings ? { updateSettings: deps.updateSettings } : {}),
            readLine: deps.io.readLine,
            ...(deps.permissionPolicy ? { policy: deps.permissionPolicy } : {}),
            ...(deps.ruleUsage ? { ruleUsage: deps.ruleUsage } : {}),
            ...(deps.recentDenials ? { recentDenials: deps.recentDenials } : {}),
            ...(deps.allowRecentDenial ? { allowRecentDenial: deps.allowRecentDenial } : {}),
            width: columns(),
            now: nowFn,
            out: (t) => deps.io.out(t)
          },
          paint
        )
        // Under the list: web reads, the extra folders, and the sandbox egress mode.
        if (result.op.op === 'list') deps.io.out(`${renderAccessSummary(deps.getSettings(), paint)}\n`)
        continue
      }
      if (result.kind === 'fork') {
        if (!deps.persist || !conversationId) {
          deps.io.out(paint('· nothing to fork yet; start a conversation first\n', 'dim'))
          continue
        }
        if (result.bad) {
          deps.io.out(paint('· usage: /fork, or /fork <n> to fork from before message n (numbers as in /rewind)\n', 'dim'))
          continue
        }
        if (result.turn !== undefined) {
          forkFromMessage(result.turn)
          continue
        }
        let forked: { id: string } | null
        try {
          forked = deps.persist.fork(conversationId)
        } catch (e) {
          deps.io.out(paint(`· could not fork this session: ${(e as Error).message}\n`, 'dim'))
          continue
        }
        if (!forked) {
          deps.io.out(paint('· could not fork this session\n', 'dim'))
          continue
        }
        leaveChatDraft()
        conversationId = forked.id
        // The fork is a fresh conversation whose stored model we don't track; mark it
        // stale so the next turn re-syncs the meta to the active model.
        persistedSettings = null
        deps.io.out(paint('· forked: continuing on a copy, original left intact\n', 'dim'))
        continue
      }
      if (result.kind === 'open-in-app') {
        if (!deps.openInApp) {
          deps.io.out(paint('· opening chats in the desktop app is unavailable here\n', 'dim'))
          continue
        }
        if (!conversationId || !deps.persist) {
          deps.io.out(paint('· nothing to open yet; this chat is not saved\n', 'dim'))
          continue
        }
        try {
          await deps.openInApp(conversationId)
          deps.io.out(paint('· opening this chat in the Houston app\n', 'dim'))
        } catch (e) {
          deps.io.out(paint(`· couldn't open the Houston app: ${terminalText((e as Error).message, { lines: false })}\n`, 'yellow'))
        }
        continue
      }
      if (result.kind === 'capability') {
        if (!deps.capabilities) {
          deps.io.out(paint('· capability info is unavailable\n', 'dim'))
          continue
        }
        let snap: CapabilitySnapshot
        try {
          snap = await deps.capabilities()
        } catch (e) {
          deps.io.out(paint(`· couldn't read ${result.which}: ${(e as Error).message}\n`, 'dim'))
          continue
        }
        const labels = { skills: 'Skills', agents: 'Agents' }
        deps.io.out(`${renderCapabilityList(labels[result.which], snap[result.which], paint)}\n`)
        continue
      }
      if (result.kind === 'settings') {
        await runSettingsCommand(result.cmd, {
          getSettings: deps.getSettings,
          ...(deps.updateSettings ? { updateSettings: deps.updateSettings } : {}),
          ...(deps.setKey ? { setKey: deps.setKey } : {}),
          settingsPath: deps.settingsPath?.() ?? '(unknown)',
          cwd: opts.cwd,
          live: { reduceMotion, screenReader, notifyMode },
          out: deps.io.out,
          readLine: deps.io.readLine,
          ...(deps.io.readSecret ? { readSecret: deps.io.readSecret } : {}),
          inferVerifyCommand: deps.inferVerifyCommand ?? inferVerifyCommand,
          paint
        })
        continue
      }
      if (result.kind === 'config') {
        await runConfig(result.op)
        continue
      }
      if (result.kind === 'status') {
        deps.io.out(`${await statusReport()}\n`)
        continue
      }
      if (result.kind === 'feedback') {
        await runFeedbackCommand(deps, paint)
        continue
      }
      if (result.kind === 'cd') {
        await changeFolder(result.path)
        continue
      }
      if (result.kind === 'add-dir') {
        deps.io.out(paint(`${applyAddDir(sessionAddDirs, result.path, opts.cwd)}\n`, 'dim'))
        continue
      }
      if (result.kind === 'vim') {
        applyTerminalSetting({ kind: 'vim', on: result.on ?? deps.getSettings().tuiEditor !== 'vim' })
        continue
      }
      if (result.kind === 'keybindings') {
        const kb = deps.keybindings
        if (!kb) {
          deps.io.out(paint('· keybindings are unavailable here\n', 'dim'))
          continue
        }
        let created: boolean
        try {
          created = kb.ensureFile().created
        } catch (e) {
          deps.io.out(paint(`· could not create ${homeRelative(kb.path)}: ${stripControlChars(String(e))}\n`, 'dim'))
          continue
        }
        if (created) deps.io.out(paint(`· created ${homeRelative(kb.path)} with every key commented out\n`, 'dim'))
        const opened = (await deps.editFile?.(kb.path)) ?? false
        if (!opened) {
          deps.io.out(
            paint(
              `· edit ${homeRelative(kb.path)} in any editor (or set $VISUAL or $EDITOR); Houston reads it again when it changes\n`,
              'dim'
            )
          )
        }
        kb.reload()
        // Said here in full, whether or not they are new: this is where you look.
        kb.takeProblems()
        const problems = kb.problems()
        if (problems.length) deps.io.out(formatKeybindingProblems(problems, paint))
        const n = kb.count()
        deps.io.out(paint(`· keybindings: ${n === 0 ? 'none set, the default keys apply' : `${n} in force`} (? on an empty prompt lists them)\n`, 'dim'))
        continue
      }
      if (result.kind === 'thoughts') {
        if (result.bad) {
          deps.io.out(
            paint(`· no thoughts mode "${stripControlChars(result.bad)}": use /thoughts show, summary or hide\n`, 'yellow')
          )
          continue
        }
        setReasoningDisplay(result.mode ?? nextReasoningDisplay(reasoningDisplay))
        continue
      }
      if (result.kind === 'transcript') {
        await openTranscript()
        continue
      }
      if (result.kind === 'todos') {
        const todos = latestTodos(messages)
        if (todos === null) deps.io.out(paint('· no todo list in this chat yet\n', 'dim'))
        else {
          deps.io.out(`${renderTodoList(todos, paint)}\n`)
          if (todos.length) deps.io.out(paint(`  ${todoProgress(todos)}\n`, 'dim'))
        }
        continue
      }
      if (result.kind === 'reduce-motion') {
        applyTerminalSetting({ kind: 'reduce-motion', on: result.on ?? !reduceMotion })
        continue
      }
      if (result.kind === 'notify') {
        if (result.invalid !== undefined) {
          deps.io.out(
            paint(`· unknown notification mode "${stripControlChars(result.invalid)}" (use ${NOTIFY_MODES.join(' | ')})\n`, 'yellow')
          )
          continue
        }
        if (result.mode) {
          applyTerminalSetting({ kind: 'notify', mode: result.mode })
          continue
        }
        deps.io.out(
          paint(
            `· notifications: ${notifyMode}, ${describeNotifyMode(notifyMode)}\n  /notify ${NOTIFY_MODES.join(' | ')} to change it\n`,
            'dim'
          )
        )
        continue
      }
      if (result.kind === 'screen-reader') {
        applyTerminalSetting({ kind: 'screen-reader', on: result.on ?? !screenReader })
        continue
      }
      if (result.kind === 'focus') {
        applyTerminalSetting({ kind: 'focus', on: result.on ?? !focusView })
        continue
      }
      if (result.kind === 'verbose') {
        applyTerminalSetting({ kind: 'verbose', on: result.on ?? !verbose })
        continue
      }
      if (result.kind === 'tasks') {
        await runTasks(result.op, false)
        continue
      }
      if (result.kind === 'queue') {
        runQueue(result.op, false)
        continue
      }
      if (result.kind === 'spawned') {
        if (!deps.backgroundSessions) {
          deps.io.out(paint('· background sessions are unavailable here\n', 'dim'))
          continue
        }
        const list = deps.backgroundSessions()
        deps.io.out(`${renderBackgroundSessions(list, nowFn(), paint)}\n`)
        if (!list.length) continue
        const ans = await deps.io.readLine('> ', { discardPending: true })
        const id = ans === null ? null : parseSessionSelection(ans, list)
        if (!id) {
          deps.io.out(paint('· cancelled\n', 'dim'))
          continue
        }
        if (!deps.persist) {
          deps.io.out(paint('· opening a session needs a session store\n', 'dim'))
          continue
        }
        let conv: ReturnType<TuiPersist['get']>
        try {
          conv = deps.persist.get(id)
        } catch (e) {
          deps.io.out(paint(`· couldn't open that session: ${(e as Error).message}\n`, 'dim'))
          continue
        }
        if (!conv) {
          deps.io.out(paint('· that session could not be opened\n', 'dim'))
          continue
        }
        // Opening a still-running session is deliberately allowed: you see its work
        // so far while its own run keeps going and keeps persisting. That is how you
        // check on parallel work without stopping it.
        const stillRunning = list.find((x) => x.id === id)?.running
        leaveChatDraft()
        conversationId = id
        messages = conv.messages
        resetChatState()
        adoptChatSettings(conv)
        loadSavedDraft()
        deps.io.out(
          paint(
            stillRunning
              ? `· opened a running session (${plural(messages.length, 'message')} so far); it keeps going in the background\n`
              : `· opened: ${plural(messages.length, 'message')}\n`,
            'dim'
          )
        )
        continue
      }
      if (result.kind === 'output') {
        deps.io.out(`${renderRecoveredOutput(toolResultsFrom(messages), result.index, paint)}\n`)
        continue
      }
      if (result.kind === 'copy') {
        await runCopyCommand(result, messages, deps, paint)
        continue
      }
      if (result.kind === 'scorecard') {
        if (!deps.scorecard) {
          deps.io.out(paint('· the scorecard is unavailable here\n', 'dim'))
          continue
        }
        try {
          deps.io.out(`${renderScorecard(deps.scorecard(), paint)}\n`)
        } catch (e) {
          deps.io.out(paint(`· couldn't build the scorecard: ${(e as Error).message}\n`, 'yellow'))
        }
        continue
      }
      if (result.kind === 'model-fallback') {
        const op = result.op
        if (op.op === 'usage') {
          deps.io.out(paint(`· ${FALLBACK_USAGE}\n`, 'dim'))
          continue
        }
        if (op.op === 'list') {
          deps.io.out(`${renderFallbacks(deps.getSettings(), paint)}\n`)
          continue
        }
        if (!deps.updateSettings) {
          deps.io.out(paint('· changing settings is unavailable here\n', 'dim'))
          continue
        }
        // Read now (another process may have saved since) and written as a patch.
        const current = deps.getSettings()
        const change = fallbackChange(op, current, (typed) => resolveModelArg(typed, current))
        if ('error' in change) {
          deps.io.out(paint(`${change.error}\n`, 'yellow'))
          continue
        }
        deps.updateSettings({ fallbackModels: change.list.length ? change.list : undefined })
        deps.io.out(paint(`${change.message}\n`, 'dim'))
        continue
      }
      if (result.kind === 'loop') {
        runLoopCommand(result.arg)
        continue
      }
      if (result.kind === 'statusline') {
        deps.io.out(
          `${renderStatusLineInfo(
            statusSource,
            statusRunner?.lastFailure() ?? null,
            statusRunner ? JSON.stringify(statusPayload(), null, 2) : null,
            Boolean(deps.runStatusLine),
            paint
          )}\n`
        )
        continue
      }
      if (result.kind === 'usage') {
        if (!deps.usageReport) {
          deps.io.out(paint('· usage totals are unavailable here\n', 'dim'))
          continue
        }
        try {
          const limits = renderRateLimits(newestRateLimits(providerQuotas(), rateLimitSnapshot()), nowFn(), paint)
          deps.io.out(`${renderUsageReport(deps.usageReport(), paint)}${limits ? `\n${limits}` : ''}\n`)
        } catch (e) {
          deps.io.out(paint(`· couldn't read usage: ${(e as Error).message}\n`, 'yellow'))
        }
        continue
      }
      if (result.kind === 'reasoning') {
        if (!result.effort) {
          deps.io.out(`${renderReasoningStatus(effort, activeModelReasons(deps, providerId, model), paint)}\n`)
          continue
        }
        // This chat's effort; the next turn runs under it. --default also makes it
        // what new chats start with.
        effort = result.effort
        if (activeRunId) deps.setRunEffort?.(activeRunId, effort)
        if (result.asDefault) {
          if (deps.updateSettings) deps.updateSettings({ reasoningEffort: effort })
          else deps.io.out(paint('· saving the default is unavailable here; changed this chat only\n', 'dim'))
        }
        deps.io.out(
          paint(`· thinking effort → ${effort}${result.asDefault && deps.updateSettings ? ' (new chats too)' : ''}\n`, 'dim')
        )
        // Say it plainly rather than let someone wonder why nothing changed.
        if (result.effort !== 'off' && activeModelReasons(deps, providerId, model) === false) {
          deps.io.out(
            paint(`· note: ${model} does not support reasoning, so this has no effect on it\n`, 'yellow')
          )
        }
        continue
      }
      if (result.kind === 'rewind') {
        if (!deps.rewind) {
          deps.io.out(paint('· rewind is unavailable here\n', 'dim'))
          continue
        }
        if (!conversationId) {
          deps.io.out(paint('· nothing to rewind yet: send a message first\n', 'dim'))
          continue
        }
        if (result.undo) {
          const res = await deps.rewind.undo(conversationId)
          if (!res.ok) {
            deps.io.out(paint(`· ${res.error}\n`, 'yellow'))
            continue
          }
          messages = res.messages
          // The meter measured the log before the undo; the next turn reports the real size.
          contextTokens = 0
          contextParts = null
          const left = res.conflicts.length ? `; left ${plural(res.conflicts.length, 'file')} that changed since: ${res.conflicts.join(', ')}` : ''
          deps.io.out(paint(`· undid the rewind (${plural(res.reapplied, 'file')} put back${left})\n`, 'dim'))
          continue
        }
        const points = rewindPoints(messages)
        let turn = result.turn
        if (turn === undefined) {
          deps.io.out(`${renderRewindPoints(points, paint)}\n`)
          if (!points.length) continue
          // discardPending like the other prompts, so type-ahead can't pick a message.
          const ans = await deps.io.readLine('> ', { discardPending: true })
          const picked = ans === null ? null : parseRewindSelection(ans, points.length)
          if (picked === null) {
            deps.io.out(paint('· cancelled\n', 'dim'))
            continue
          }
          turn = picked
        }
        const point = points[turn]
        if (!point) {
          deps.io.out(paint(`· no message ${turn + 1} to rewind to (there are ${points.length})\n`, 'yellow'))
          continue
        }
        let mode = result.mode
        let action = result.action
        if (!mode && !action) {
          deps.io.out(`${renderRewindChoices(paint)}\n`)
          const ans = await deps.io.readLine('[1] > ', { discardPending: true })
          mode = ans === null ? undefined : (parseRewindMode(ans) ?? undefined)
          action = ans === null || mode ? undefined : (parseRewindExtra(ans) ?? undefined)
          if (!mode && !action) {
            deps.io.out(paint('· cancelled\n', 'dim'))
            continue
          }
        }
        if (action === 'fork') {
          forkFromMessage(turn)
          continue
        }
        if (action) {
          await summarizeAround(turn, point, action === 'summarize-from' ? 'from' : 'before')
          continue
        }
        if (!mode) continue
        const text = turnText(messages[point.messageIndex])
        const preview = await deps.rewind.preview(conversationId, turn, mode, text)
        if (!preview.ok) {
          deps.io.out(paint(`· ${preview.error}\n`, 'yellow'))
          continue
        }
        deps.io.out(`${paint(`Rewind to “${terminalText(point.label, { lines: false })}”?`, 'bold')} ${rewindConfirmText(mode, preview)}\n`)
        const yes = await deps.io.readLine('Rewind? [y/N] ', { discardPending: true })
        if (!yes || !/^y(es)?$/i.test(yes.trim())) {
          deps.io.out(paint('· cancelled\n', 'dim'))
          continue
        }
        const res = await deps.rewind.apply(conversationId, turn, mode, text)
        if (!res.ok) {
          deps.io.out(paint(`· ${res.error}\n`, 'yellow'))
          continue
        }
        messages = res.messages
        // The meter measured the log before the cut; the next turn reports the real size.
        if (rewindsConversation(mode)) {
          contextTokens = 0
          contextParts = null
        }
        // The last turn's run may be gone from the chat, or reverted already: /undo
        // must not fall back to it.
        lastRunId = null
        deps.io.out(paint(`· ${rewindDoneText(mode, res)} /rewind undo reverses it.\n`, res.conflicts.length ? 'yellow' : 'dim'))
        if (rewindsConversation(mode) && res.text.trim()) {
          // Back in the composer to edit and send again, as in the desktop app; a
          // terminal without the line editor can only show it.
          if (deps.io.readComposer) {
            halfDraft = res.text
            deps.io.out(paint('· your message is back in the prompt to edit or send\n', 'dim'))
          } else {
            deps.io.out(paint(`· your message was: ${res.text}\n`, 'dim'))
          }
        }
        continue
      }
      if (result.kind === 'undo') {
        if (!deps.checkpoint) {
          deps.io.out(paint('· undo is unavailable here\n', 'dim'))
          continue
        }
        // Prefer the stored checkpoint (it survives a restart), but fall back to
        // this session's last run: an ephemeral session has no conversation to look
        // up, and its writes are just as undoable.
        const cp = conversationId ? await deps.checkpoint.info(conversationId) : null
        const runId = cp?.runId ?? lastRunId
        if (!runId) {
          deps.io.out(`${renderCheckpoint(null, paint)}\n`)
          continue
        }
        const files = result.redo
          ? await deps.checkpoint.redo(runId)
          : await deps.checkpoint.undo(runId)
        deps.io.out(
          result.redo
            ? paint(`· put back ${plural(files, 'file')} the last turn had changed\n`, 'dim')
            : `${renderUndoResult(files, paint)}\n`
        )
        continue
      }
      if (result.kind === 'changes' && result.last !== undefined) {
        const edit = recentEdits[recentEdits.length - result.last]
        if (!edit) {
          deps.io.out(
            paint(
              recentEdits.length
                ? `· only ${recentEdits.length} edit${recentEdits.length === 1 ? '' : 's'} so far this session\n`
                : '· no edits yet this session (/changes shows the working tree)\n',
              'dim'
            )
          )
          continue
        }
        const html = deps.highlightHtml
        const plainEdit = screenReader ? renderPreviewDiff(edit) : null
        const view = plainEdit ? colorizeDiff(plainEdit, paint, SCREEN_READER_DIFF_LINES) : renderPreviewView(
          edit,
          paint,
          html
            ? (lang, code) => {
                const h = html(lang, code)
                return h ? htmlToAnsi(h, paint) : code
              }
            : undefined
        )
        if (view) deps.io.out(`${view}\n`)
        continue
      }
      if (result.kind === 'changes') {
        const html = deps.highlightHtml
        await runChangesCommand(result.op ?? { op: 'summary', scope: 'tree' }, {
          deps: deps.changes,
          conversationId,
          out: (text) => deps.io.out(text),
          // discardPending: type-ahead must not answer a question about discarding work.
          ask: (prompt) => deps.io.readLine(prompt, { discardPending: true }),
          paint,
          ...(html && !screenReader
            ? {
                highlight: (lang: string, code: string) => {
                  const h = html(lang, code)
                  return h ? htmlToAnsi(h, paint) : code
                }
              }
            : {})
        })
        continue
      }
      if (result.kind === 'doctor') {
        if (!deps.doctor) {
          deps.io.out(paint('· diagnostics are unavailable here\n', 'dim'))
          continue
        }
        deps.io.out(paint('· checking…\n', 'dim'))
        try {
          const facts = await deps.doctor()
          // The model this session runs on, which --provider/--model, /model or a
          // resumed chat may have chosen without touching the saved selection.
          const active = providerId && model ? { providerId, model } : facts.active
          deps.io.out(`${renderDoctor(buildDoctorReport({ ...facts, active }), paint)}\n`)
        } catch (e) {
          deps.io.out(paint(`· couldn't run diagnostics: ${(e as Error).message}\n`, 'yellow'))
        }
        continue
      }
      if (result.kind === 'hooks') {
        await runHooksCommand(result.action, deps, paint, opts.cwd)
        continue
      }
      if (result.kind === 'mcp') {
        await runMcpCommand(result.action, deps, paint, opts.cwd)
        if (result.action.op === 'reconnect') {
          // A line sent while "Reconnecting" spun was queued (no run to steer): send it
          // next, as after /compact and /btw, and a line still being typed stays a draft.
          const typedWhile = deps.io.takeQueued?.() ?? []
          const halfTyped = deps.io.takeDraft?.() ?? ''
          pendingQueued = [...pendingQueued, ...typedWhile]
          if (halfTyped) halfDraft = [halfDraft, halfTyped].filter(Boolean).join('\n\n')
          if (typedWhile.length || halfTyped) saveHeldDraft()
        }
        continue
      }
      if (result.kind === 'trust') {
        await runTrustCommand(result.op, opts.cwd, deps, paint, result.index)
        continue
      }
      if (result.kind === 'memory') {
        await runMemoryCommand(
          result.action,
          {
            ...(deps.memoryStore ? { store: deps.memoryStore } : {}),
            getSettings: deps.getSettings,
            ...(deps.updateSettings ? { updateSettings: deps.updateSettings } : {}),
            ...(deps.editText ? { editText: deps.editText } : {}),
            out: (t) => deps.io.out(t)
          },
          memoryState,
          paint
        )
        continue
      }
      if (result.kind === 'schedule') {
        await runScheduleCommand(
          result.op,
          {
            ...(deps.schedules ? { scheduler: deps.schedules } : {}),
            getSettings: deps.getSettings,
            readLine: deps.io.readLine,
            out: (t) => deps.io.out(t),
            cwd: opts.cwd,
            ...(providerId && model ? { providerId, model } : {}),
            now: nowFn
          },
          paint
        )
        continue
      }
      if (result.kind === 'login') {
        if (!deps.setKey) {
          deps.io.out(paint('· setting API keys isn’t available here\n', 'dim'))
          continue
        }
        const setup = await runProviderSetup(deps, paint, newId, { firstRun: false })
        if (setup) {
          providerId = setup.providerId
          model = setup.model
        }
        continue
      }
      if (result.kind === 'login-op' || result.kind === 'model-refresh') {
        const pdeps = providerCommandDeps(deps, providerId, model)
        if (result.kind === 'login-op') await runLoginOp(result.op, pdeps, paint)
        else await refreshProviderModels(result.provider, pdeps, paint)
        continue
      }
      if (result.kind === 'paste-image') {
        deps.io.out(`${stageClipboardImage()}\n`)
        continue
      }
      if (result.kind === 'clear-images') {
        const n = pendingImages.length
        pendingImages = []
        deps.io.out(paint(n ? `· dropped ${plural(n, 'staged image')}\n` : '· no images staged\n', 'dim'))
        continue
      }
      if (result.kind === 'image') {
        if (!deps.loadImage) {
          deps.io.out(paint('· image attachments are unavailable\n', 'dim'))
          continue
        }
        if (pendingImages.length >= MAX_STAGED_IMAGES) {
          deps.io.out(`${fullNote()}\n`)
          continue
        }
        deps.io.out(`${stageLoadedImage(result.path, deps.loadImage(result.path))}\n`)
        continue
      }
      if (result.kind === 'set-approval') {
        policy = result.policy
        deps.io.setMode?.(policy)
        const asDefault = result.asDefault && deps.updateSettings
        if (asDefault) deps.updateSettings?.({ approvalPolicy: policy })
        deps.io.out(paint(`· approval → ${APPROVAL_POLICY_LABEL[policy]}${asDefault ? ' (new chats too)' : ''}\n`, 'dim'))
        continue
      }
      if (result.kind === 'pick-model') {
        const choices = deps.io.select ? modelChoices(deps.getSettings(), providerId, model) : []
        if (choices.length === 0) {
          // No picker (or nothing ready to pick): list providers and models instead.
          handleInfoCommand(
            text,
            { providerId, model, policy, cwd: opts.cwd, sessionCost, modelCosts, contextParts, contextTokens },
            deps,
            paint
          )
          continue
        }
        const r = await deps.io.select!({
          title: 'Model:',
          // A fetched provider list runs to dozens of models: typing narrows it, on the
          // name, the provider or the id.
          filter: true,
          options: choices.map((c, i) => ({
            label: c.label,
            value: String(i),
            description: c.description,
            keywords: c.description
          }))
        })
        if (r.kind === 'cancel' || r.kind === 'interrupt') deps.io.out(paint('· cancelled\n', 'dim'))
        if (r.kind !== 'commit') continue
        const picked = choices[Number(r.value)]
        if (!picked) continue
        result = {
          kind: 'set-model',
          providerId: picked.providerId,
          model: picked.model,
          ...(result.asDefault ? { asDefault: true } : {})
        }
      }
      if (result.kind === 'set-model') {
        providerId = result.providerId
        model = result.model
        // This chat's model, stored on the chat at its next turn (so /resume and the
        // desktop app reopen it on this model). --default also makes it the model new
        // chats, and the next launch, start on.
        const asDefault = result.asDefault && deps.updateSettings
        if (asDefault) deps.updateSettings?.({ selected: { providerId, model } })
        const kind = deps.getSettings().providers.find((p) => p.id === providerId)?.kind
        const shown = kind ? modelDisplayName(kind, model) : model
        const where = `${providerId} / ${model}`
        const named = shown === model ? where : `${shown}  (${where})`
        deps.io.out(paint(`· model → ${named}${asDefault ? ' (new chats too)' : ''}\n`, 'dim'))
        continue
      }
      if (result.kind === 'set-theme') {
        applyTerminalSetting(result)
        continue
      }
      if (result.kind === 'compact') {
        if (!deps.compact || !conversationId || !providerId || !model) {
          deps.io.out(paint('· nothing to compact yet; start a conversation first\n', 'dim'))
          continue
        }
        deps.io.out(paint('· compacting… (Esc or Ctrl-C cancels)\n', 'dim'))
        const ctl = new AbortController()
        compactAbort = ctl
        deps.io.startSpinner?.('Compacting')
        let res: CompactResult
        try {
          res = await deps.compact(conversationId, providerId, model, {
            signal: ctl.signal,
            ...(result.focus ? { focus: result.focus } : {}),
            onRetry: ({ attempt, max }) =>
              deps.io.setSpinnerLabel?.(`Compacting (retrying, attempt ${attempt}${max ? ` of ${max}` : ''})`)
          })
        } catch (e) {
          res = { ok: false, summarized: 0, error: (e as Error).message }
        } finally {
          compactAbort = null
          deps.io.stopSpinner?.()
        }
        if (res.ok && res.messages) {
          messages = res.messages
          // The meter measured the log before it was summarized; the next turn reports
          // the real size, as after a rewind.
          contextTokens = 0
          contextParts = null
          deps.io.out(paint(`· compacted ${plural(res.summarized, 'earlier message')}\n`, 'dim'))
        } else if (res.ok) {
          deps.io.out(
            paint(
              res.reason === 'single-turn'
                ? '· single turn: /new starts a fresh chat to free up context\n'
                : '· nothing to compact yet\n',
              'dim'
            )
          )
        } else if (res.reason === 'cancelled') {
          deps.io.out(paint('· compaction cancelled; nothing changed\n', 'dim'))
        } else {
          deps.io.out(paint(`· couldn't compact: ${res.error ?? 'unknown error'}\n`, 'yellow'))
        }
        // A line sent while it compacted was queued (there was no run to steer): send it
        // next, as /btw does, rather than after the user's next turn. A cancel hands it
        // back as the draft instead, and a line still being typed stays a draft.
        const typedWhile = deps.io.takeQueued?.() ?? []
        const halfTyped = deps.io.takeDraft?.() ?? ''
        if (res.reason === 'cancelled') {
          restoreDraft = [restoreDraft, ...typedWhile, halfTyped].filter(Boolean).join('\n\n')
        } else {
          pendingQueued = [...pendingQueued, ...typedWhile]
          if (halfTyped) halfDraft = [halfDraft, halfTyped].filter(Boolean).join('\n\n')
        }
        saveHeldDraft()
        continue
      }
      if (result.kind === 'unknown') {
        deps.io.out(paint(`Unknown command: /${result.name}. Try /help.\n`, 'yellow'))
        continue
      }
      if (result.kind === 'btw') {
        if (!deps.sideChat) {
          deps.io.out(paint('· side chat is unavailable here\n', 'dim'))
          continue
        }
        const btwUsage = '· usage: /btw <question>, or /btw clear to start the side chat over\n'
        if (!result.question && !conversationId) {
          deps.io.out(paint(btwUsage, 'dim'))
          continue
        }
        if (!conversationId || !providerId || !model) {
          deps.io.out(paint('· side chat needs a saved chat: send a message first\n', 'dim'))
          continue
        }
        let question = result.question
        if (!question) {
          // Bare /btw: what the side chat said lately, as the desktop panel shows, then
          // ask for the question rather than make the user retype the command.
          const recent = renderRecentSideChat(deps.sideChat.recent?.(conversationId) ?? [], paint)
          if (recent) deps.io.out(`${recent}\n`)
          question = ((await deps.io.readLine(paint(BTW_QUESTION_PROMPT, 'green'), { discardPending: true })) ?? '').trim()
          if (!question) {
            deps.io.out(paint(btwUsage, 'dim'))
            continue
          }
        }
        if (question === 'clear') {
          deps.sideChat.clear(conversationId)
          deps.io.out(paint('· side chat cleared; the next /btw starts a new one\n', 'dim'))
          continue
        }
        const sideChat = deps.sideChat
        const sideConversationId = conversationId
        let stopped = false
        const stop = new Promise<null>((resolve) => {
          stopSideChat = () => {
            stopped = true
            stopSideChat = null
            sideChat.cancel?.(sideConversationId)
            resolve(null)
          }
        })
        deps.io.startSpinner?.('Side chat')
        try {
          // The chat's one side chat, stored with it: follow-ups keep its context.
          // Raced against Ctrl-C / Esc, so a stop returns to the composer at once even
          // if the answer is slow to wind down.
          const ask = sideChat.ask({ conversationId, question, providerId, model })
          ask.catch(() => {}) // a late failure after a stop has no one to report to
          const turn = await Promise.race([ask, stop])
          if (turn === null || stopped) {
            deps.io.stopSpinner?.()
            deps.io.out(paint('\n^C side chat stopped\n', 'dim'))
          } else if (turn.answer !== undefined) {
            // The model's answer, rendered as a reply is: markdown, wrapped, and with its
            // control characters dropped (line by line, so its lines stay).
            const clean = turn.answer.trim().split('\n').map(stripControlChars).join('\n')
            const body = renderMarkdownAnsi(clean, { paint, width: columns() })
            deps.io.out(`${paint('side chat (not added to this chat):', 'dim')}\n${body}\n`)
          } else {
            deps.io.out(paint(`· side chat failed: ${stripControlChars(turn.error ?? 'no answer')}\n`, 'red'))
          }
        } catch (e) {
          deps.io.out(paint(`· side chat failed: ${stripControlChars((e as Error).message)}\n`, 'red'))
        } finally {
          stopSideChat = null
          deps.io.stopSpinner?.()
        }
        // A line typed while the side chat worked was queued (there was no run to
        // steer): send it as the next turn, or after a stop, offer it as the draft.
        const typed = deps.io.takeQueued?.() ?? []
        const halfTyped = deps.io.takeDraft?.() ?? ''
        if (stopped) restoreDraft = [restoreDraft, ...typed, halfTyped].filter(Boolean).join('\n\n')
        else {
          pendingQueued = [...pendingQueued, ...typed]
          if (halfTyped) halfDraft = [halfDraft, halfTyped].filter(Boolean).join('\n\n')
        }
        saveHeldDraft()
        continue
      }
      if (result.kind === 'proposals') {
        if (!deps.proposals) {
          deps.io.out(paint('· proposals are unavailable here\n', 'dim'))
          continue
        }
        if (!conversationId) {
          deps.io.out(paint('· no sessions proposed in this chat yet\n', 'dim'))
          continue
        }
        const list = deps.proposals.list(conversationId)
        if (result.op === 'list' || result.index === undefined) {
          deps.io.out(`${renderProposals(list, paint)}\n`)
          continue
        }
        const picked = list[result.index - 1]
        if (!picked) {
          deps.io.out(paint(`· no proposal ${result.index}; /proposals lists them\n`, 'dim'))
          continue
        }
        if (picked.status === 'started') {
          deps.io.out(paint('· that proposal was already started; /spawned opens it\n', 'dim'))
          continue
        }
        try {
          if (result.op === 'start') {
            const started = await deps.proposals.start(conversationId, picked.callId, policy)
            deps.io.out(paint(`· started "${terminalText(started.title, { lines: false })}" in the background; /spawned opens it\n`, 'green'))
            continue
          }
          deps.proposals.decide(conversationId, picked.callId, result.op === 'here' ? 'here' : 'dismissed')
        } catch (e) {
          deps.io.out(paint(`· couldn't do that: ${(e as Error).message}\n`, 'red'))
          continue
        }
        if (result.op === 'dismiss') {
          deps.io.out(paint(`· dismissed "${terminalText(picked.title, { lines: false })}"\n`, 'dim'))
          continue
        }
        // "here": ask for it in this chat, as a normal turn. Fall through.
        const turn = proposalHereTurn(picked)
        text = turn.text
        invokedAs = turn.invokedAs
        deps.io.out(paint(`${invocationEcho(turn.invokedAs)}\n`, 'dim'))
      } else if (result.kind === 'git') {
        const turn = await runGitCommand(result.op, {
          deps: deps.git,
          conversationId,
          out: (t) => deps.io.out(t),
          // discardPending: type-ahead must not answer whether to commit.
          ask: (prompt) => deps.io.readLine(prompt, { discardPending: true }),
          paint
        })
        if (!turn) continue
        // /ship: the Changes view's ship button's request, as an invoked turn. Fall through.
        text = turn.text
        invokedAs = turn.invokedAs
        deps.io.out(paint(`${invocationEcho(turn.invokedAs)}\n`, 'dim'))
      } else if (result.kind === 'retry') {
        // The desktop's Retry: a history that ends in the user's own message means
        // its turn produced nothing (it failed or was stopped). Send that message
        // again; appendUserTurn swaps it in place rather than stacking a copy.
        const last = messages.at(-1)
        if (!last || last.role !== 'user' || last.content.startsWith(SYSTEM_NOTE_PREFIX)) {
          deps.io.out(paint('· nothing to retry: /retry runs your last message again after a turn fails\n', 'dim'))
          continue
        }
        text = last.content
        invokedAs = last.invokedAs
        pendingImages = last.images ?? []
        deps.io.out(paint('· retrying your last message\n', 'dim'))
      } else if (result.kind === 'mcp-prompt') {
        // A connected MCP server's prompt: fetched with the user's arguments, then run
        // as a turn labelled with the command (the server's text stays out of the
        // scrollback, as a template's does).
        if (!deps.mcpPrompts) {
          deps.io.out(paint('· MCP prompts are not available here\n', 'yellow'))
          continue
        }
        const ran = await prepareMcpPromptRun(result.command, result.args, text, deps.mcpPrompts.fetch)
        if (!ran.ok) {
          deps.io.out(paint(`· ${stripControlChars(ran.error)}\n`, 'yellow'))
          continue
        }
        text = ran.turn.text
        invokedAs = ran.turn.invokedAs
        turnTaint = ran.taintSource
        deps.io.out(paint(`${invocationEcho(ran.turn.invokedAs)}\n`, 'dim'))
      } else if (result.kind === 'prompt') {
        // A template command (custom `.houston/commands` or first-party /review):
        // run its expanded prompt as a normal turn. Fall through — don't `continue`.
        // The typed line is already on screen; one dim line says what it runs, and
        // the prompt itself stays out of the scrollback.
        if (result.command) {
          const commandName = `/${result.command.cmd.name}`
          const prepared = await prepareCommandRun(result.command.cmd, result.command.args, text, {
            settings: deps.getSettings(),
            trusted: await workspaceTrusted(opts.cwd, deps.getSettings().trustedFolders).catch(() => false),
            workspace: opts.cwd,
            // A template's shell commands (or a credential file it reads): shown
            // exactly, and run only on a yes.
            confirmContext: async (consent) => {
              const { title, lines } = describeContextConsent(commandName, consent)
              deps.io.out(
                `${paint(stripControlChars(title), 'cyan')}\n${lines.map((l) => `  ${stripControlChars(l)}`).join('\n')}\n`
              )
              const ans = await deps.io.readLine('Allow? [y/N] ', { discardPending: true })
              return /^(y|yes)$/i.test(ans?.trim() ?? '')
            },
            ...(deps.runContextShell ? { runShell: deps.runContextShell } : {})
          })
          if (prepared && !prepared.ok) {
            deps.io.out(paint(`· ${stripControlChars(prepared.error)}\n`, 'yellow'))
            continue
          }
          if (prepared) {
            turnRun = prepared.run
            result = { kind: 'prompt', ...prepared.run.turn }
          }
        }
        text = result.text
        invokedAs = result.invokedAs
        deps.io.out(paint(`${invocationEcho(result.invokedAs)}\n`, 'dim'))
        for (const note of turnRun?.notes ?? []) deps.io.out(paint(`· ${stripControlChars(note)}\n`, 'dim'))
      } else {
        // 'handled' — informational commands print here where the state lives.
        handleInfoCommand(
          text,
          {
            providerId,
            model,
            policy,
            cwd: opts.cwd,
            sessionCost,
            modelCosts,
            contextParts,
            contextTokens,
            agents: subagentSpend(sessionAgents.values())
          },
          deps,
          paint,
          customCommands
        )
        continue
      }
    }

    // A message's richer @ mentions (a file's lines, an MCP resource, an agent) are
    // filled in here, before it is sent; the typed message is what the chat shows.
    if (!invokedAs && !wakeTurn && deps.expandMentions && text.includes('@')) {
      const filled = await deps.expandMentions(text, {
        confirm: async (consent) => {
          const { lines } = describeContextConsent('This message', consent)
          deps.io.out(
            `${paint('This message reads a credential file:', 'cyan')}\n${lines.map((l) => `  ${stripControlChars(l)}`).join('\n')}\n`
          )
          const ans = await deps.io.readLine('Send its contents to the model? [y/N] ', { discardPending: true })
          return /^(y|yes)$/i.test(ans?.trim() ?? '')
        },
        addDirs: [...sessionAddDirs]
      })
      if (!filled.ok) {
        // Back in the prompt, so fixing the mention doesn't mean retyping the message.
        halfDraft = [halfDraft, text].filter(Boolean).join('\n\n')
        deps.io.out(paint(`· not sent: ${stripControlChars(filled.error)}\n`, 'yellow'))
        continue
      }
      if (filled.turn) {
        text = filled.turn.text
        invokedAs = filled.turn.invokedAs
        for (const note of filled.notes) deps.io.out(paint(`· ${stripControlChars(note)}\n`, 'dim'))
      }
    }

    // A turn needs a model. Until a provider is set up, gate submission and point at
    // /login — never eject, so the user can set a key and keep this session.
    if (!providerId || !model) {
      deps.io.out(paint('No model is ready yet. Run /login to set an API key first.\n', 'yellow'))
      continue
    }

    // Preflight the key. A provider that needs one but has none — switched to via
    // /model, a saved selection whose key was since removed, etc. — would otherwise
    // start a run that fails deep in the adapter with a raw error and leave the
    // typed prompt dangling in `messages` (double-stacked onto the next turn).
    // Surface an actionable /login hint and skip the run instead.
    const activeProvider = deps.getSettings().providers.find((p) => p.id === providerId)
    if (activeProvider?.requiresKey && !activeProvider.hasKey) {
      deps.io.out(paint(`· ${providerId} has no API key. Run /login to set one.\n`, 'yellow'))
      continue
    }

    // Images staged before a switch to a model that can't see them would be ignored by
    // it: dropped, and said so, rather than sent for nothing (as the desktop app does).
    if (pendingImages.length && !modelSeesImages()) {
      deps.io.out(paint(`· dropped ${plural(pendingImages.length, 'staged image')}: ${model} can't see images\n`, 'yellow'))
      pendingImages = []
    }
    // A resend of a message whose turn failed replaces it rather than repeating it.
    messages = appendUserTurn(messages, {
      role: 'user',
      content: text,
      // Staged images wait for the user's own message: an automated wake turn takes none.
      ...(pendingImages.length && !wakeTurn ? { images: pendingImages } : {}),
      ...(invokedAs ? { invokedAs } : {}),
      ...(wakeTurn && wakeTaint ? { taintSource: wakeTaint } : turnTaint ? { taintSource: turnTaint } : {})
    })
    if (!wakeTurn) pendingImages = [] // consumed by this turn
    // Lazily open a persisted conversation on the first turn so the session
    // survives restarts and is resumable. Ephemeral when no store is injected, or
    // when the store can't be written (degrade rather than crash the REPL).
    if (deps.persist && !conversationId) {
      try {
        conversationId = deps.persist.create({
          workspace: opts.cwd,
          providerId,
          model,
          reasoningEffort: effort,
          approvalPolicy: policy
        }).id
        // create() stored these, so the meta already matches — no sync needed below.
        persistedSettings = settingsKey()
        applyLaunchTitle()
      } catch (e) {
        if (!warnedPersistFail) {
          warnedPersistFail = true
          deps.io.out(paint(`· couldn't start a saved conversation (continuing unsaved): ${(e as Error).message}\n`, 'dim'))
        }
      }
    }
    // Persist the user's message up front (like the GUI) so an early run error can't
    // lose the prompt or leave an empty "New chat" orphan in /resume and the sidebar.
    persistMessages(messages)
    suggestion = null
    // Keep the stored provider/model in step with the model this turn actually runs
    // under (after a `/model` switch or a `/resume`) — same ordering as the GUI, which
    // follows setMessages with updateConversationMeta on every send.
    syncPersistedModel()
    const runId = newId()
    activeRunId = runId
    lastRunId = runId
    const req: AgentRunRequest = {
      runId,
      ...(conversationId ? { conversationId } : {}),
      workspace: opts.cwd,
      providerId: turnRun?.model?.providerId ?? providerId,
      model: turnRun?.model?.model ?? model,
      approvalPolicy: policy,
      reasoningEffort: turnRun?.effort ?? effort,
      ...(turnRun?.turnAllowRules?.length ? { turnAllowRules: turnRun.turnAllowRules } : {}),
      messages,
      // show_images results print as clickable file links (see renderImageLinks).
      imageLinks: true,
      // Under /verbose a running command's output prints as it arrives (see LiveTail);
      // /focus leaves progress out, so it wins here too.
      ...(verbose && !focusView ? { liveShellOutput: true } : {}),
      ...(sessionAddDirs.length ? { addDirs: [...sessionAddDirs] } : {}),
      ...(wakeTurn ? { wake: true } : {}),
      ...sessionRunFields
    }
    // Serialize interactive prompts (approvals/questions) so two readLine calls
    // never overlap on the single input stream.
    let prompts: Promise<void> = Promise.resolve()
    // The terminal's progress state (OSC 9;4 / 7501): blocked while a prompt waits.
    let progressState: ProgressState = 'working'
    const progressLabel = (): string => idleTitle(workspaceName, tabChatTitle)
    // Prompts queued or showing; the run reads as working again only once none waits.
    let pendingPrompts = 0
    // Once a prompt is answered the agent is working again, so the tab stops saying it
    // needs you (the title is set back to idle when the run returns), and so does the
    // terminal's progress indicator.
    // A prompt still queued when the run is interrupted is dropped unshown: stopping
    // the run already settled every approval, question and plan it was waiting on, so
    // asking would only answer a call that never runs.
    const interruptedNow = (): boolean => interruptedQueued !== null
    const enqueue = (task: () => Promise<void>): void => {
      pendingPrompts++
      prompts = prompts
        .then(async () => {
          if (interruptedNow()) return
          await task()
        })
        .finally(() => {
          pendingPrompts--
          if (pendingPrompts > 0 || interruptedNow()) return
          deps.io.signal?.({ title: workingTitle('working', workspaceName, tabChatTitle) })
          if (progressState !== 'working') {
            progressState = 'working'
            deps.io.progress?.('working', progressLabel())
          }
        })
        .catch(() => {})
    }
    // "2 of 5" on each approval while several wait at once (parallel subagents).
    const approvalCount = new ApprovalCounter()
    // Args captured at tool_start, so a write approval can show the actual diff
    // (the approval event itself only carries a human summary).
    const toolArgs = new Map<string, Record<string, unknown>>()
    // A write's diff, from its tool_start, until its result says whether it landed.
    const writePreviews = new Map<string, FileDiffPreview[]>()
    // Writes the user approved at a prompt, where the diff was already on screen.
    const promptedWrites = new Set<string>()
    // todo_write calls whose list we already drew, so their summary line is dropped.
    const todoCalls = new Set<string>()
    // Calls started and not yet finished, and those that ran alongside another one:
    // their result and progress lines name the call, since they can't sit under it.
    const liveCalls = new Map<string, string>()
    const parallelCalls = new Set<string>()
    const callTag = (callId: string): string | null => {
      const name = liveCalls.get(callId)
      return name && parallelCalls.has(callId) ? toolCallTag(name, toolArgs.get(callId)) : null
    }
    // Review findings print once per status change (line mode can't update in place).
    const printFinding = createFindingPrinter()
    // ...and are tallied by severity under the review's result, as the desktop's row is.
    const reviewTally = new ReviewTally()
    // The models this turn's rounds were billed to, for the line that ends it.
    const turnModels: string[] = []
    // The turn's output tokens so far (reported, plus the open round's estimate), for
    // the spinner, as the desktop's status bar counts them.
    let meter = startMeter(nowFn())
    // A stop that didn't come from this keyboard (a hook, another client) is said once.
    let stopSaid = false
    // Running commands' live output under /verbose: only the lines not printed yet.
    const liveTail = new LiveTail()
    // A subagent's start, finished steps and end (reviewers' steps only under /verbose).
    const subagentLines = new SubagentTermLines({
      get verbose() {
        return verbose
      }
    })
    // The live panel under the spinner (subagents at work). Not in screen-reader mode,
    // which never redraws in place: there each step prints as a plain line instead.
    const panelOn = (): boolean => !screenReader && deps.io.setLivePanel !== undefined
    const refreshPanel = (): void => {
      if (panelOn()) {
        const running = liveSubagents().some((a) => a.status === 'running')
        deps.io.setLivePanel?.(running ? (w) => liveAgentPanel(liveSubagents(), nowFn(), paint, w) : null)
      }
      for (const changed of liveViewers) changed()
    }

    // Tool rows, folded. Unless /verbose is on or a screen reader is reading (it hears
    // each call as it starts), a call's row waits for its result so the two print as
    // one line ("· Read  src/a.ts · 40 lines"), and calls of one kind in a row share
    // it. Anything that must print in between (progress, a prompt, a subagent) prints
    // the waiting rows first, the way they always looked, and their results render
    // under them as before. /focus folds every call, failures included, and prints
    // nothing in between.
    // File reads fold for a screen reader too, into one sentence, as they always have.
    const foldCalls = (name: string): boolean => focusView || (!verbose && (!screenReader || name === 'read_file'))
    const heldCalls = new Map<string, { name: string; args: Record<string, unknown>; at: number }>()
    let foldedGroup: { verb: string; items: FoldedCall[] } | null = null
    // The last thing printed is a folded tool line: the next one follows without a gap.
    let toolLineLast = false
    const flushGroup = (): void => {
      if (!foldedGroup) return
      const g = foldedGroup
      foldedGroup = null
      const alone = g.items.length === 1 ? g.items[0].alone : undefined
      if (alone) {
        deps.io.out(`\n${alone}\n`)
        toolLineLast = false
        return
      }
      // Several reads are "Read N files" and their paths, as the desktop folds them.
      const count = g.items.every((i) => i.alone !== undefined) ? 'files' : undefined
      deps.io.out(
        `${toolLineLast ? '' : '\n'}${renderFoldedCalls(g.verb, g.items, paint, { width: columns(), sentence: screenReader, ...(count ? { count } : {}) })}\n`
      )
      toolLineLast = true
    }
    const releaseHeld = (): void => {
      flushGroup()
      toolLineLast = false
      // The focus view never prints a row ahead of its result.
      if (focusView) return
      for (const c of heldCalls.values()) deps.io.out(`\n${renderToolStart(c.name, c.args, paint, { sentence: screenReader })}\n`)
      heldCalls.clear()
    }
    flushHeldCalls = releaseHeld
    // The focus view's reply: each round's text is held, and dropped when the round
    // turns out to be working (it calls a tool); what is left when the turn ends is the
    // final reply.
    let focusReply = ''
    const releaseFocusReply = (): void => {
      if (!focusReply) return
      const text = focusReply
      focusReply = ''
      flushGroup()
      toolLineLast = false
      deps.io.out(`${screenReader ? '\nhouston:\n' : '\n'}${text}`)
    }
    // Per-turn token/cost tally. The loop emits a `usage` event per model round
    // (and per subagent), which would be noisy to print each time — the live
    // session total already sits in the status line above the composer. So we sum
    // the round usages here and print one compact summary when the turn ends.
    // Back-to-back retries of one request: the first prints a line and later ones
    // only relabel the spinner, as the desktop updates one line in place instead of
    // stacking six. Any other output ends the streak.
    let retryStreak = 0
    // Whether the turn finished on its own (not stopped, not failed): only then is a
    // next message suggested, as in the desktop app.
    let turnFinished = false
    let turnErrored = false
    let turnInputTokens = 0
    let turnOutputTokens = 0
    let turnCost = 0
    let turnCostUnknown = false
    // Assistant text streams through a markdown renderer that emits whole blocks
    // as they finalize. Any non-text event flushes the pending block first, so
    // text always renders before the tool line / prompt that follows it.
    const highlight = deps.highlightHtml
      ? (lang: string, code: string): string => {
          const html = deps.highlightHtml?.(lang, code)
          return html ? htmlToAnsi(html, paint) : code
        }
      : undefined
    // Links and workspace file paths in the reply become clickable where the terminal
    // shows hyperlinks: a colour TTY, and not screen-reader mode (plain lines only).
    const md = new MarkdownStream({
      paint,
      width: columns(),
      highlight,
      ...(opts.color && !screenReader ? { links: replyLinks() } : {})
    })
    // Whether the model round now streaming has put any text or reasoning on screen.
    // A discarded round can only be struck out once printed (line mode can't erase),
    // so this decides whether there is anything above to disown.
    let roundShown = false
    const flushMd = (): void => {
      const s = md.flush()
      if (!s) return
      if (focusView) {
        focusReply += s
        return
      }
      releaseHeld()
      deps.io.out(s)
      roundShown = true
    }
    // The streaming round's reasoning: when it began and what it said, for the
    // one-line summary ('summary') printed when the next thing arrives.
    let thought: { start: number; text: string } | null = null
    // Screen-reader mode: who the streamed text belongs to, so each stretch is labeled.
    let speaking: 'reply' | 'thinking' | null = null
    const endThought = (discard: boolean): void => {
      if (!thought) return
      const t = thought
      thought = null
      // A dropped round's thought is dropped with it: its redo thinks again.
      if (discard || reasoningDisplay !== 'summary' || focusView) return
      releaseHeld()
      // A screen reader hears whose line it is, as it would for streamed thinking.
      const label = screenReader ? '\nhouston, thinking:\n' : ''
      deps.io.out(`${freshLine()}${label}${renderThoughtSummary(t.text, nowFn() - t.start, columns(), paint)}\n`)
      roundShown = true
    }
    // Shown in full ('show'), reasoning streams in fragments that seldom end a line
    // ("I need", " to check how"). Printed as they came, the spinner's next frame
    // wiped the half-written line, and the reply ran on from the end of it. So the
    // unfinished line is held and printed a row at a time, and whatever comes next
    // prints it first.
    let reasoningTail = ''
    const flushReasoning = (): void => {
      if (reasoningTail) deps.io.out(`${paint(reasoningTail, 'dim')}\n`)
      reasoningTail = ''
    }
    flushStreamedText = () => {
      flushReasoning()
      releaseHeld()
      flushMd()
    }
    // Liveness while the agent works (relabelled per event; erased on any output).
    deps.io.setStatus?.(renderRunStatus({ model, branch, contextTokens }, paint))
    deps.io.startSpinner?.('Working')
    // The tab says it is working, and the terminal hears it too (OSC 9;4 / 7501).
    deps.io.signal?.({ title: workingTitle('working', workspaceName, tabChatTitle) })
    deps.io.progress?.('working', progressLabel())
    // The user's message is saved: a model-written title can start alongside the turn.
    requestGeneratedTitle()
    // Set once a text delta has relabelled the spinner, so the rest of the reply
    // doesn't relabel it on every delta; any other event clears it.
    let saysResponding = false
    const turnStartedAt = nowFn()
    let turnFailed = false

    const send = (e: AgentEvent): void => {
      // Attention signals ride the event stream itself, so anything that blocks the
      // run (approval, question, plan) or ends it can pull the user back. Done once,
      // here, rather than at each case: a signal added to the policy then reaches the
      // terminal without touching the renderer below.
      const sig = signalFor(e, workspaceName, tabChatTitle)
      // Progress follows the run: blocked on a question or approval, then working again.
      const progress = progressForEvent(e)
      if (progress && progress !== progressState) {
        progressState = progress
        deps.io.progress?.(progress, progressLabel())
      }
      if (e.type === 'error') turnFailed = true
      // The title is ambient (it just describes the tab) so it is always set; the
      // bell and notification follow /notify (which defaults to the "notify me" setting).
      if (sig) deps.io.signal?.(notifyMode !== 'off' ? { ...sig, mode: notifyMode } : sig.title ? { title: sig.title } : {})
      // A finished turn nobody has come back to gets one more nudge later.
      if (e.type === 'done' && sig?.alert && notifyMode !== 'off') {
        deps.io.remindIfIdle?.(idleReminderSpec(workspaceName), notifyMode)
      }
      // The live output-token count beside the spinner's clock.
      const nextMeter = meterOnEvent(meter, e, e.type === 'usage' ? e.outputTokens : 0)
      if (nextMeter !== meter) {
        meter = nextMeter
        deps.io.setSpinnerTokens?.(meterTokens(meter))
      }
      // Whatever prints for this event goes after the tool rows waiting for results.
      if (printsBetweenCalls(e, { focus: focusView, panel: panelOn(), verbose })) releaseHeld()
      // A background subagent's line (or a rolled-up usage with no transcript place)
      // can land while the main agent is mid-reply or mid-thought. It prints between
      // the reply's finished blocks without ending the round: flushing the half-received
      // block there split words across paragraphs and turned the rest of a code fence
      // into prose (and the prose after it into code).
      const side = isSideEvent(e)
      if (side) {
        flushReasoning()
        const nl = freshLine()
        if (nl) deps.io.out(nl)
      }
      // Anything but more reasoning ends the thought in progress: the rest of its
      // last line first (shown in full), then its summary line (summary mode).
      if (!side && e.type !== 'reasoning') {
        flushReasoning()
        endThought(e.type === 'turn_discarded')
        thoughtLineOpen = false
      }
      if (e.type === 'text') {
        retryStreak = 0 // the request got through
        // The reply is streaming: whatever the spinner said before (a tool that has
        // finished, Thinking) is over. Same word the desktop app's status bar uses. A
        // screen reader already hears the "houston:" speaker line instead.
        if (!saysResponding) {
          if (!screenReader) deps.io.setSpinnerLabel?.('Responding')
          saysResponding = true
        }
        const s = md.push(e.delta)
        if (focusView) {
          focusReply += s
          return
        }
        if (s) {
          releaseHeld()
          roundShown = true
        }
        // Who is speaking, once per stretch of reply, for a screen reader.
        if (s && screenReader && speaking !== 'reply') {
          speaking = 'reply'
          deps.io.out('\nhouston:\n')
        }
        deps.io.out(s)
        return
      }
      const roundWasShown = roundShown
      if (!side) {
        saysResponding = false
        if (e.type !== 'reasoning' && e.type !== 'usage') speaking = null
        // A discarded round's unfinished block is dropped unrendered, never flushed:
        // its redo will print the whole reply again.
        if (e.type === 'turn_discarded') {
          md.discard()
          focusReply = ''
        } else flushMd()
        // Any event but reasoning means the streaming round is over (or gone).
        if (e.type !== 'reasoning') roundShown = false
        // Usage and a discarded partial round belong to the retry they surround.
        if (e.type !== 'retry' && e.type !== 'error' && e.type !== 'usage' && e.type !== 'turn_discarded') {
          retryStreak = 0
        }
      }
      switch (e.type) {
        case 'reasoning': {
          // A new round of thinking: the folded tool line before it is complete.
          flushGroup()
          // A screen reader hears the "houston, thinking:" label instead of a spinner.
          if (!screenReader) deps.io.setSpinnerLabel?.('Thinking')
          thought ??= { start: nowFn(), text: '' }
          thought.text += e.delta
          if (reasoningDisplay !== 'show' || focusView) break
          // Model text, so it can't carry a terminal control of its own.
          const safe = terminalText(e.delta)
          if (!safe) break
          releaseHeld()
          if (screenReader && speaking !== 'thinking') {
            deps.io.out(`${freshLine()}\nhouston, thinking:\n`)
            speaking = 'thinking'
          }
          if (screenReader) {
            // Appended as it comes: there is no spinner line to protect, and a screen
            // reader wants the words, not rows wrapped to the window.
            deps.io.out(paint(safe, 'dim'))
            thoughtLineOpen = !safe.endsWith('\n')
            break
          }
          // Then held to whole rows, so the line under the spinner is never half written.
          const { rows, rest } = takeStreamedRows(reasoningTail + safe, columns())
          reasoningTail = rest
          if (rows) deps.io.out(paint(rows, 'dim'))
          roundShown = true
          break
        }
        case 'turn_discarded':
          // What already reached the terminal can't be erased in line mode, so strike
          // it out in words; the retry or fallback line that follows says why.
          if (roundWasShown) {
            deps.io.out(paint('\n· ✗ the reply above was cut off and is discarded; starting it over\n', 'yellow'))
          }
          break
        case 'tool_start': {
          // A screen reader hears the tool line below; the label would say it twice.
          if (!screenReader) deps.io.setSpinnerLabel?.(describeToolCall(e.name, e.args).verb)
          toolArgs.set(e.callId, e.args)
          if (liveCalls.size > 0) {
            for (const id of liveCalls.keys()) parallelCalls.add(id)
            parallelCalls.add(e.callId)
          }
          liveCalls.set(e.callId, e.name)
          // The round calls a tool, so what it said so far was working, not the reply.
          focusReply = ''
          // A todo update IS its list; showing "· todo_write" and then a count of
          // what changed tells you nothing about the plan. (The focus view gives it
          // one line, like any call.)
          const todos = e.name === 'todo_write' ? parseTodosSafe(e.args.todos) : []
          if (e.name === 'todo_write' && !focusView) {
            releaseHeld()
            deps.io.out(`\n${renderTodoList(todos, paint)}\n`)
            todoCalls.add(e.callId)
            break
          }
          // A question or a plan prints itself as the prompt that follows; a "· ask_user"
          // line in front of it is only the wire name.
          if (e.name === ASK_USER_TOOL || e.name === PRESENT_PLAN_TOOL) break
          // Navigation noise gets no line, as it gets no row in the desktop app (the
          // focus view hides it even under /verbose).
          if (isHiddenTool(e.name, verbose && !focusView)) break
          if (e.kind === 'write' && e.preview?.length) writePreviews.set(e.callId, e.preview)
          if (foldCalls(e.name)) {
            // A call of another kind: the folded line waiting is complete.
            if (foldedGroup && foldedGroup.verb !== describeToolCall(e.name, e.args).verb) flushGroup()
            heldCalls.set(e.callId, { name: e.name, args: e.args, at: nowFn() })
            break
          }
          deps.io.out(`\n${renderToolStart(e.name, e.args, paint, { sentence: screenReader })}\n`)
          break
        }
        case 'tool_result': {
          const tag = callTag(e.callId)
          liveCalls.delete(e.callId)
          parallelCalls.delete(e.callId)
          // With no tool left running the model is writing again, so the spinner stops
          // naming the last tool ("Run 45s"). In screen-reader mode it never named one.
          if (liveCalls.size === 0 && !screenReader) deps.io.setSpinnerLabel?.('Working')
          // The list was just drawn from the call's args; its result is only the
          // model-facing summary of what we already showed.
          if (todoCalls.delete(e.callId) && e.ok) {
            toolArgs.delete(e.callId)
            break
          }
          if (isHiddenTool(e.name, verbose && !focusView)) {
            toolArgs.delete(e.callId)
            break
          }
          const held = heldCalls.get(e.callId)
          heldCalls.delete(e.callId)
          // A result with more to show under it (images a tool returned, a review's
          // tally) keeps its row, except in the focus view, which shows one line a call.
          const extra = (e.images?.length ?? 0) > 0 || e.name === 'review_changes'
          if (held && (focusView || (foldsToOneLine(e.name, e.ok, e.output) && !extra))) {
            if (e.name === 'review_changes') reviewTally.take(e.callId, paint)
            const preview = writePreviews.get(e.callId)
            writePreviews.delete(e.callId)
            toolArgs.delete(e.callId)
            const prompted = promptedWrites.delete(e.callId)
            if (preview && e.ok) recentEdits = [...recentEdits, preview].slice(-RECENT_EDITS)
            // A call the user denied at its prompt: that prompt already said so.
            if (!e.ok && deniedPromptText(e.output) !== null) break
            // An edit that landed without a prompt gets its summary line (the file and
            // its +/- counts), so no edit lands unseen; one approved at a prompt already
            // showed its diff there and folds like any call.
            if (!focusView && preview && e.ok && !prompted) {
              flushGroup()
              deps.io.out(`${toolLineLast ? '' : '\n'}${renderEditSummary(preview, paint)}\n`)
              toolLineLast = true
              break
            }
            const item: FoldedCall = {
              ...foldedCall(held.name, held.args, e.ok, e.output, { preview, durationMs: nowFn() - held.at }),
              // A read on its own prints as it always did: its row and the start of
              // what it read (see flushGroup); several fold into one "Read N files" line.
              ...(held.name === 'read_file' && !focusView
                ? {
                    alone: `${renderToolStart('read_file', held.args, paint, { sentence: screenReader })}\n${renderToolResult('read_file', true, e.output, paint, { width: columns() })}`.trimEnd()
                  }
                : {})
            }
            const verb = describeToolCall(held.name, held.args).verb
            if (focusView) {
              // One line per call: nothing is grouped, so each reads on its own.
              foldedGroup = { verb, items: [item] }
              flushGroup()
              break
            }
            if (foldedGroup && foldedGroup.verb !== verb) flushGroup()
            // The line stays open for the next call of this kind; anything else (another
            // kind of call, the model thinking or writing, a prompt) completes it.
            if (foldedGroup) foldedGroup.items.push(item)
            else foldedGroup = { verb, items: [item] }
            break
          }
          // A result that needs more than one line: its row goes above it, as it did.
          if (held) {
            flushGroup()
            toolLineLast = false
            deps.io.out(`\n${renderToolStart(held.name, held.args, paint, { sentence: screenReader })}\n`)
          } else {
            // A result for a call nothing is holding (its row already printed, or never
            // came): whatever is held prints first, so the transcript keeps its order.
            releaseHeld()
          }
          // A proposal is a card in the desktop app; here it's a line pointing at
          // the command that starts it.
          if (e.name === PROPOSE_SESSION_TOOL && e.ok && e.output.startsWith('Proposed "')) {
            const title = toolArgs.get(e.callId)?.title
            deps.io.out(
              paint(
                `  · proposed a session${typeof title === 'string' ? `: ${terminalText(title, { lines: false })}` : ''}. /proposals to start it, ask for it here, or dismiss it\n`,
                'cyan'
              )
            )
            toolArgs.delete(e.callId)
            break
          }
          // A gallery is a desktop view; here each image is a clickable link to its file.
          if (e.name === SHOW_IMAGES_NAME && e.ok) {
            const links = renderImageLinks(toolArgs.get(e.callId), opts.cwd, paint)
            if (links) {
              deps.io.out(`${links}\n`)
              toolArgs.delete(e.callId)
              break
            }
          }
          // Output already shown line by line as it ran isn't printed again in full.
          const rendered = renderToolResult(e.name, e.ok, e.output, paint, {
            verbose: verbose && !liveTail.streamed(e.callId),
            width: columns()
          })
          liveTail.forget(e.callId)
          const line = tag ? tagResultLines(rendered, tag, paint) : rendered
          if (line) deps.io.out(`${line}\n`)
          // Images the desktop shows under the row (a screenshot): at least say so.
          const images = toolImagesLine(e.images?.length ?? 0, paint)
          if (images) deps.io.out(`${images}\n`)
          // A finished review ends with its severity tally.
          const tally = e.name === 'review_changes' ? reviewTally.take(e.callId, paint) : null
          if (tally) deps.io.out(`${tally}\n`)
          toolArgs.delete(e.callId)
          const preview = writePreviews.get(e.callId)
          writePreviews.delete(e.callId)
          if (preview && e.ok) {
            recentEdits = [...recentEdits, preview].slice(-RECENT_EDITS)
            // An approved write showed its diff in the prompt; one that ran without
            // asking gets the summary, so no edit lands unseen.
            if (!promptedWrites.has(e.callId)) deps.io.out(`${renderEditSummary(preview, paint)}\n`)
          }
          promptedWrites.delete(e.callId)
          break
        }
        case 'tool_progress': {
          if (focusView) break
          const tag = callTag(e.callId)
          if (e.output !== undefined && verbose) {
            const room = Math.max(20, columns() - 8)
            for (const l of liveTail.next(e.callId, e.output)) {
              const shown = truncate(terminalText(l, { lines: false }).trimEnd(), room)
              deps.io.out(paint(`    ${tag ? `${tag}: ` : ''}│ ${shown}\n`, 'dim'))
            }
          }
          if (!e.message.trim()) break
          deps.io.out(paint(`  … ${tag ? `${tag}: ` : ''}${truncate(terminalText(e.message, { lines: false }).trim(), 80)}\n`, 'dim'))
          break
        }
        case 'subagent_start':
        case 'subagent_step':
        case 'subagent_end': {
          subagentTracker.apply(e, conversationId)
          if (e.type === 'subagent_start') sessionAgents.set(e.record.id, e.record)
          else if (e.type === 'subagent_end') {
            const r = sessionAgents.get(e.recordId)
            if (r) sessionAgents.set(e.recordId, { ...r, ...e.update })
          }
          refreshPanel()
          const line = subagentLines.line(e)
          // The focus view leaves the agents' working out; the panel shows their steps
          // while they run (screen-reader mode, and /verbose, print each one).
          if (focusView || (e.type === 'subagent_step' && panelOn() && !verbose)) break
          if (line) {
            const text = `  ${'  '.repeat(line.depth)}${truncate(terminalText(line.text, { lines: false }), Math.max(40, columns() - 6))}\n`
            deps.io.out(line.tone === 'plain' ? text : paint(text, line.tone))
          }
          break
        }
        case 'subagent':
          if (focusView) break
          // Line mode can't update a row in place, so print discrete markers: a
          // start line, then a done/error line, indented under the parent tool.
          deps.io.out(paint(`    ${subagentGlyph(e.status)} ${terminalText(e.label, { lines: false })}\n`, 'dim'))
          break
        case 'review_finding': {
          reviewTally.add(e.parentCallId, e.finding)
          const line = printFinding(e.parentCallId, e.finding)
          if (line && !focusView) {
            const s = e.finding.status
            const tone = s === 'confirmed' ? 'yellow' : s === 'candidate' ? undefined : 'dim'
            const text = `      ${truncate(terminalText(line, { lines: false }), 120)}\n`
            deps.io.out(tone ? paint(text, tone) : text)
          }
          break
        }
        case 'retry':
          if (e.throttle?.resetAt !== undefined) {
            // A usage limit the loop waits out: the turn carries on by itself at reset.
            const at = resetClock(e.throttle.resetAt)
            deps.io.setSpinnerLabel?.(`Waiting for the limit to reset at ${at}`)
            deps.io.out(paint(`\n· limit resets at ${at}; continuing then (Esc to cancel)\n`, 'yellow'))
            retryStreak = 0
            break
          }
          deps.io.setSpinnerLabel?.(`Retrying ${retryProgress(e)}`)
          if (retryStreak === 0) {
            const line = retryNoticeText(e)
            // Kept past the notice: the status line and /usage show it until a newer report.
            if (e.throttle) noteThrottle(providerId ?? undefined, e.throttle, nowFn())
            deps.io.out(paint(`\n· ${terminalText(line)}\n`, 'yellow'))
          }
          retryStreak = e.attempt
          break
        case 'model_fallback':
          deps.io.setSpinnerLabel?.('Switching model')
          deps.io.out(paint(`\n· ${terminalText(modelFallbackText(e))}\n`, 'yellow'))
          break
        case 'tool_approval':
          if (e.kind === 'write') promptedWrites.add(e.callId)
          approvalCount.arrived(e.callId)
          enqueue(async () => {
            const position = approvalCount.position()
            if (screenReader) {
              deps.io.out(`\nwaiting for approval${position ? `, ${approvalPositionText(position)}` : ''}\n`)
            }
            // Context (name, kind, unsandboxed warning) + the diff for a write.
            deps.io.out(
              `${renderApprovalPrompt(e, paint, {
                picker: !!deps.io.select,
                width: columns(),
                ...(position ? { position } : {})
              })}\n`
            )
            if (e.kind === 'write') {
              // Prefer the main process's preview: it is diffed against the files'
              // actual contents, so an overwrite shows what changed rather than the
              // whole file, and a multi_edit has a diff at all. Fall back to deriving
              // one from the args (`tool_start` is emitted only AFTER approval
              // resolves, so `toolArgs` is still empty here for a write).
              // The preview is diffed against the files' real contents and already
              // folded to the change; render it with numbers + word marks. Only fall
              // back to deriving a diff from the args when there is no preview.
              // A screen reader gets the unified diff: a +/- sign on every line, no
              // gutter or color to depend on.
              const plainPreview = screenReader && e.preview ? renderPreviewDiff(e.preview) : null
              const view =
                (plainPreview ? colorizeDiff(plainPreview, paint, SCREEN_READER_DIFF_LINES) : null) ??
                (e.preview ? renderPreviewView(e.preview, paint, deps.highlightHtml ? highlight : undefined) : null) ??
                (() => {
                  const raw = extractDiff(e.args ?? toolArgs.get(e.callId) ?? {})
                  return raw ? colorizeDiff(raw, paint) : null
                })()
              if (view) deps.io.out(`${view}\n`)
            }
            let decision: ToolApprovalDecision | null = null
            let note: string | undefined
            // An answer the picker already took as typed text (the numbered list).
            let typed: string | undefined
            // "Allow with a note": the note is asked for next, then how long the allow lasts.
            let askNote = false
            const askNoteScope = async (): Promise<ToolApprovalDecision> => {
              if (deps.io.select) {
                const r = await deps.io.select({
                  title: 'Allow:',
                  escLabel: 'deny',
                  options: [
                    { label: 'Allow once', value: 'allow', description: 'run this call only', key: 'y' },
                    { label: 'Allow for this chat', value: 'always', description: APPROVAL_OPTIONS[1].description, key: 'a' }
                  ]
                })
                if (r.kind === 'commit') return r.value as ToolApprovalDecision
                // Esc or Ctrl-C backs out of the allow.
                if (r.kind === 'cancel' || r.kind === 'interrupt') return 'deny'
                return parseNoteScope(r.text ?? (await deps.io.readLine('Allow once or for this chat? [y/a] ', { discardPending: true })))
              }
              return parseNoteScope(await deps.io.readLine('Allow once or for this chat? [y/a] ', { discardPending: true }))
            }
            if (deps.io.select) {
              // The shell-network consent is a yes/no question about egress, not a
              // permission rule about a command — offering "always allow"/"deny with a
              // reason" there would be nonsense, so keep that prompt to three options.
              const network = !!(e.egressHost || e.shellNetwork)
              const r = await deps.io.select({
                title: 'Choose:',
                // Esc is a refusal here (the safe default), so the footer says so.
                escLabel: e.egressHost ? 'keep blocked' : e.shellNetwork ? 'keep offline' : 'deny',
                // Typed text is a reason to deny; the network questions take none.
                typeLabel: network ? null : 'type a reason to deny',
                options: e.egressHost
                  ? [
                      { label: `Allow ${stripControlChars(e.egressHost)} for this chat`, value: 'always', key: 'y' },
                      { label: 'Keep blocked', value: 'deny', key: 'n' }
                    ]
                  : e.shellNetwork
                  ? [
                      { label: 'Allow network for this chat', value: 'always', key: 'y' },
                      { label: 'Keep offline', value: 'deny', key: 'n' }
                    ]
                  : approvalOptionsFor(e).map((o) => ({
                      label: o.label,
                      value: o.value,
                      description: o.description,
                      ...(o.key ? { key: o.key } : {})
                    }))
              })
              if (r.kind === 'interrupt') {
                // Ctrl-C stops the run, as the typed prompt's does; stopping records the
                // call as interrupted, and the deny only settles it if nothing else has.
                interrupt()
                deps.resolveApproval(e.runId, e.callId, 'deny')
                return
              }
              if (r.kind === 'type' && r.seed !== undefined) {
                // Every answer has its key, so a typed character starts a reason to
                // deny: open that prompt with it rather than dropping it. The user is
                // typing at a prompt they can see, so what follows is kept.
                const reason = await deps.io.readLine('Why not? (what should it do instead) ', { initial: r.seed })
                decision = 'deny'
                note = reason?.trim() || undefined
              } else if (r.kind === 'type' && r.text === undefined) {
                // The picker handed over without an answer: the typed prompt says its keys.
                deps.io.out(`${renderApprovalKeys(e, paint)}\n`)
              }
              if (r.kind === 'commit') {
                if (r.value === 'deny-note') {
                  // Collect the guidance in the same interaction as the refusal.
                  const reason = await deps.io.readLine('Why not? (what should it do instead) ', {
                    discardPending: true
                  })
                  decision = 'deny'
                  note = reason?.trim() || undefined
                } else if (r.value === 'allow-note') {
                  askNote = true
                } else {
                  decision = r.value as ToolApprovalDecision
                }
              } else if (r.kind === 'cancel') decision = 'deny' // safe default
              else typed = r.text
              // 'type' → fall through to the typed prompt below
            }
            if (decision === null && !askNote) {
              const ans = typed ?? (await deps.io.readLine('> ', { discardPending: true }))
              const parsed = parseApprovalAnswer(ans ?? '')
              decision = parsed.decision
              note = parsed.note
              if (parsed.askNote) {
                // The network questions take no note: "c" there is no answer, so no grant.
                if (e.shellNetwork || e.egressHost) decision = 'deny'
                else {
                  askNote = true
                  decision = null
                }
              }
            }
            if (askNote) {
              // The note rides with the result ("go ahead, but keep the old file").
              const typedNote = await deps.io.readLine('Note for the agent: ', { discardPending: true })
              if (typedNote === null) decision = 'deny' // Ctrl-C or end of input: no allow
              else {
                note = typedNote.trim() || undefined
                decision = e.discardsWork ? 'allow' : await askNoteScope()
                // Backing out of the allow drops the note: it was written for an approval.
                if (decision === 'deny') note = undefined
              }
            }
            if (decision === null) decision = 'deny'
            // Nothing covers a work-discarding command for the chat, so a chat grant
            // typed at it runs it once, as the loop does.
            if (e.discardsWork && decision === 'always') decision = 'allow'
            let unconfirmed = false
            if (e.discardsWork && decision !== 'deny' && decision !== 'rule-deny') {
              const confirm = await deps.io.readLine(
                `Type ${DISCARD_CONFIRM_WORD} to run it (anything else denies): `,
                { discardPending: true }
              )
              if (!confirmsDiscard(confirm)) {
                decision = 'deny'
                note = undefined
                unconfirmed = true
              }
            }
            const outcome = unconfirmed
              ? 'Denied: not confirmed'
              : approvalOutcome(decision, {
                  shellNetwork: e.shellNetwork,
                  ...(e.egressHost ? { egressHost: e.egressHost } : {}),
                  note
                })
            deps.io.out(paint(`  ↳ ${stripControlChars(outcome)}\n`, decision === 'deny' || decision === 'rule-deny' ? 'yellow' : 'dim'))
            const ruleSince = Date.now()
            approvalCount.done(e.callId)
            deps.resolveApproval(e.runId, e.callId, decision, note)
            // After "Always allow / deny", name the rule(s) the run actually saved and
            // how to take them back, as the desktop's toast does.
            const ruleAction = ruleActionOf(decision)
            if (ruleAction) {
              const { saved, settings: fresh } = await waitForSavedRules(
                async () => deps.getSettings(),
                ruleAction,
                ruleSince
              )
              deps.io.out(`${renderSavedRules(saved, fresh?.permissionRules ?? [], ruleAction, paint)}\n`)
            }
          })
          break
        case 'tool_question':
          enqueue(async () => {
            if (screenReader) deps.io.out('\nwaiting for your answer\n')
            const multi = e.multiSelect ?? false
            // Only offer the arrow-key picker when there's something to pick: an
            // options-less question is a free-text prompt, so go straight to typing.
            const usePicker = !!deps.io.select && e.options.length > 0
            // With the picker, the picker is the one list of options. Printing the
            // numbered list as well showed the question and every option twice; it
            // is printed only if the answer falls back to typing (which takes numbers).
            deps.io.out(
              `${usePicker ? renderQuestionHeader(e.question, paint) : renderQuestion(e.question, e.options, multi, paint)}\n`
            )
            let answer: string | null = null
            let typedAnswer: string | undefined
            let seed: string | undefined
            if (usePicker && deps.io.select) {
              const r = await deps.io.select({
                title: '',
                multiSelect: multi,
                // Shown cleaned; the answer is still the label as the agent wrote it.
                options: e.options.map((o) => ({
                  label: terminalText(o.label, { lines: false }),
                  value: o.label,
                  ...(o.description ? { description: terminalText(o.description, { lines: false }) } : {})
                }))
              })
              if (r.kind === 'interrupt') {
                interrupt()
                deps.resolveQuestion(e.runId, e.callId, '')
                return
              }
              if (r.kind === 'commit') answer = r.value
              else if (r.kind === 'type' && r.text !== undefined) typedAnswer = r.text
              // cancel/type → fall through so the user can still type a custom answer
              else deps.io.out(`${renderQuestionChoices(e.options, multi, paint)}\n`)
              // The key that left the picker is the answer's first character.
              if (r.kind === 'type' && r.seed !== undefined) seed = r.seed
            }
            // An empty answer is not sent: ask again. Ctrl-D (no input at all) dismisses
            // the question, said to the agent in words rather than as ''.
            while (answer === null || !answer.trim()) {
              // A seeded prompt is one the user is already typing at, so nothing is dropped.
              const ans =
                typedAnswer ??
                (await deps.io.readLine('> ', seed === undefined ? { discardPending: true } : { initial: seed }))
              typedAnswer = undefined
              seed = undefined
              if (ans === null) {
                answer = QUESTION_DISMISSED_ANSWER
                break
              }
              answer = resolveQuestionAnswer(ans, e.options, e.multiSelect ?? false)
              if (!answer) deps.io.out(paint('· type an answer (or an option number)\n', 'dim'))
            }
            // The same cap the desktop applies at its IPC boundary.
            deps.resolveQuestion(e.runId, e.callId, capAnswer(answer))
          })
          break
        case 'elicitation':
          // An MCP server asked for input mid-tool-call. Show who is asking (the
          // values go to that external server), offer a decline, then collect one
          // line per field, re-prompting on invalid values.
          enqueue(async () => {
            // Everything here but the field values is the remote server's text.
            if (screenReader) deps.io.out('\nwaiting for your input\n')
            deps.io.out(
              `\n${paint(`MCP server "${terminalText(e.serverId, { lines: false })}" requests input:`, 'cyan')} ${terminalText(e.message)}\n`
            )
            const proceed = await deps.io.readLine('Provide it? [y/N] ', { discardPending: true })
            if (proceed === null || !/^y(es)?$/i.test(proceed.trim())) {
              deps.resolveElicitation(e.runId, e.elicitId, {
                action: proceed === null ? 'cancel' : 'decline'
              })
              deps.io.out(paint('· declined\n', 'dim'))
              return
            }
            const raw: Record<string, string> = {}
            for (const f of e.fields) {
              if (f.description) {
                deps.io.out(paint(`  ${terminalText(f.name, { lines: false })}: ${terminalText(f.description)}\n`, 'dim'))
              }
              for (;;) {
                const hints = [
                  f.kind === 'enum' ? (f.options ?? []).join(' | ') : f.kind !== 'string' ? f.kind : '',
                  // The shape the server expects (email, uri, date, date-time), as the
                  // desktop shows it in the field's placeholder.
                  f.format ?? '',
                  f.required ? 'required' : 'optional'
                ]
                  .filter(Boolean)
                  .join('; ')
                const label = terminalText(`${f.title ?? f.name}${hints ? ` (${hints})` : ''}`, { lines: false })
                const ans = await deps.io.readLine(`${label}: `, {
                  discardPending: true
                })
                if (ans === null) {
                  deps.resolveElicitation(e.runId, e.elicitId, { action: 'cancel' })
                  deps.io.out(paint('· cancelled\n', 'dim'))
                  return
                }
                const check = buildElicitationContent([f], { [f.name]: ans })
                if ('content' in check) {
                  raw[f.name] = ans
                  break
                }
                deps.io.out(paint(`· ${terminalText(check.error, { lines: false })}\n`, 'yellow'))
              }
            }
            const built = buildElicitationContent(e.fields, raw)
            if ('error' in built) {
              // Per-field checks passed, so this is unreachable in practice; keep
              // the safe fallback anyway.
              deps.resolveElicitation(e.runId, e.elicitId, { action: 'decline' })
              return
            }
            deps.resolveElicitation(e.runId, e.elicitId, { action: 'accept', content: built.content })
          })
          break
        case 'usage':
          if (e.model) turnModels.push(e.model)
          modelCosts = addModelUsage(modelCosts, e)
          sessionCost.inputTokens += e.inputTokens
          sessionCost.outputTokens += e.outputTokens
          sessionCost.cost += e.cost
          turnInputTokens += e.inputTokens
          turnOutputTokens += e.outputTokens
          turnCost += e.cost
          if (e.costUnknown) {
            sessionCost.costUnknown = true
            turnCostUnknown = true
          }
          // Current context size ≈ the last MAIN round's input tokens; feeds the
          // status line. Subagent usage events carry inputTokens: 0, so guard
          // against them resetting the meter to zero mid-turn.
          if (e.inputTokens) {
            contextTokens = e.inputTokens
            deps.io.setStatus?.(renderRunStatus({ model: model ?? '', branch, contextTokens }, paint))
          }
          if (e.context) contextParts = e.context
          break
        case 'error':
          turnErrored = true
          turnFinished = false
          // The run gave up mid-streak: say the retries are over, so the line above
          // doesn't read as still in progress.
          if (retryStreak > 0) {
            deps.io.out(
              paint(`\n· tried ${retryStreak} more time${retryStreak === 1 ? '' : 's'}, then stopped\n`, 'yellow')
            )
          }
          releaseFocusReply()
          deps.io.out(`\n${renderTurnError(e.message, e.cause, paint)}\n`)
          break
        case 'limit':
          deps.io.out(paint(`\n· ${limitNoticeText(e.reason)}\n`, 'yellow'))
          break
        case 'compaction':
          if (focusView) break
          deps.io.out(paint(`\n· ${compactionNoticeText(e.summarized)}\n`, 'dim'))
          break
        case 'notice':
          // A user-addressed note (a hook's systemMessage, a budget extension) — display-only, never
          // part of the model's context.
          if (focusView) break
          deps.io.out(paint(`\n· ${terminalText(e.message)}\n`, 'dim'))
          break
        case 'runtime_missing':
          // Display-only: the model already got the hint in the run_shell result.
          deps.io.out(paint(`\n${runtimeMissingLine(e)}\n`, 'yellow'))
          break
        case 'done':
          // Stopped from somewhere other than this keyboard (a hook, another client):
          // Ctrl-C already printed "interrupted", anything else would end in silence.
          if (e.stopReason === 'aborted' && interruptedQueued === null && !stopSaid) {
            stopSaid = true
            deps.io.out(paint(`\n· ${runEndNoticeText({ reason: 'aborted', at: new Date(nowFn()).toISOString() })}\n`, 'yellow'))
          }
          // The focus view's final reply, held until now.
          releaseFocusReply()
          turnFinished = e.stopReason !== 'aborted' && !turnErrored
          // One compact cost summary for the whole turn (this turn + running
          // session), instead of a line per model round. Only when the turn
          // actually spent tokens; otherwise just a blank separator. It names the
          // model(s) the turn ran on, as the desktop's turn footer does.
          if (turnInputTokens || turnOutputTokens) {
            const turnModelsShown = turnModelsLabel(turnModels.length ? turnModels : [req.model ?? ''])
            const turnTally: SessionCost = {
              inputTokens: turnInputTokens,
              outputTokens: turnOutputTokens,
              cost: turnCost,
              ...(turnCostUnknown ? { costUnknown: true } : {})
            }
            deps.io.out(
              paint(
                `\n· turn ${turnModelsShown ? `${turnModelsShown} · ` : ''}${formatSessionCost(turnTally)}  (session ${formatSessionCost(sessionCost)})\n`,
                'dim'
              )
            )
          } else {
            deps.io.out('\n')
          }
          break
        case 'plan_ready':
          // The agent presented a finished plan and is blocked awaiting a verdict.
          // Render it and collect the same accept / suggest / reject decision the
          // GUI's plan panel does, then unblock present_plan via resolvePlan.
          enqueue(async () => {
            // The picker lists the actions itself; the typed [key] menu is printed
            // only when answering falls back to typing, so it isn't shown twice.
            deps.io.out(
              `${renderPlan(e.plan, paint, { actions: !deps.io.select, width: columns(), highlight })}\n`
            )
            if (screenReader) deps.io.out('waiting for your decision on the plan\n')
            // Asked until something is decided: an edit with no editor, one that didn't
            // happen or emptied the plan, or an empty suggestion, comes back here instead
            // of accepting or rejecting on the user's behalf. Typed EOF rejects, so this ends.
            let decision: PlanDecision | null = null
            for (let asked = 0; decision === null; asked++) {
              let action: PlanAction | null = null
              let typedAction: string | undefined
              if (deps.io.select) {
                const r = await deps.io.select({
                  title: 'Your decision:',
                  // Each action answers to its key; there is no typed answer to start.
                  typeLabel: null,
                  options: PLAN_ACTIONS.map((a) => ({ label: a.label, value: a.action, description: a.description, key: a.key }))
                })
                if (r.kind === 'interrupt') {
                  interrupt()
                  deps.resolvePlan(e.runId, e.callId, { kind: 'reject' })
                  return
                }
                if (r.kind === 'commit') action = r.value as PlanAction
                else if (r.kind === 'type' && r.text !== undefined) typedAction = r.text
                // cancel/type → fall through to the typed prompt, with its keys shown
                else deps.io.out(`${renderPlanActions(paint)}\n`)
              } else if (asked > 0) deps.io.out(`${renderPlanActions(paint)}\n`)
              if (action === null) {
                const ans = typedAction ?? (await deps.io.readLine('> ', { discardPending: true }))
                if (ans === null) {
                  decision = { kind: 'reject' }
                  break
                }
                action = parsePlanAction(ans)
              }
              decision = await planDecisionFor(action, e.plan, deps, paint)
            }
            // The same caps the desktop applies at its IPC boundary.
            decision = capPlanDecision(decision)
            // Accepting flips the local policy so the composer + status line reflect
            // that Plan mode is off for the rest of the session (the loop flips the
            // run's own policy independently when the tool result is applied).
            if (decision.kind === 'accept') {
              policy = decision.mode
              deps.io.setMode?.(policy)
            }
            deps.resolvePlan(e.runId, e.callId, decision)
          })
          break
        case 'verification':
          deps.io.out(
            paint(`\n· ${verificationNoticeText(e.passed)}\n`, e.passed ? 'dim' : 'yellow')
          )
          break
        case 'run_info':
          // Sent only to a run that asks for it (the headless --json init line); never here.
          break
        case 'reply_sent_back':
          // The reply above is closed (flushed above); the next one starts apart from it.
          deps.io.out('\n')
          break
        case 'turn_start':
          // Emitted only when the main process auto-starts a queued follow-up turn;
          // the TUI drives its own composer and never uses that buffer, so ignore it.
          break
        case 'receipt': {
          // What Houston recorded running this turn, under the model's own account of
          // the work: dim like the cost line, unless a check failed. The ledger already
          // drops control characters; stripped again because it goes to a terminal.
          const [summary, ...rest] = formatReceiptLines(e.receipt).map(stripControlChars)
          deps.io.out(paint(`\n· ${summary}\n`, receiptHasFailure(e.receipt) ? 'yellow' : 'dim'))
          if (rest.length) deps.io.out(paint(`${rest.map((l) => `· ${l}`).join('\n')}\n`, 'dim'))
          break
        }
        case 'steered':
          // Say it when it lands, not when it was typed: until the model reaches an
          // iteration boundary the message has changed nothing, and echoing it early
          // would claim otherwise.
          //
          // Stripped on the way out for the same reason every other echoed string is:
          // this one comes from the keyboard today (where the decoder has already
          // turned escapes into keys, not text), but it is echoed straight to a
          // terminal, and the next caller of steerRun may not be a keyboard.
          deps.io.out(paint(`\n· steering: ${stripControlChars(e.text)}\n`, 'cyan'))
          if (e.id) deps.io.steerLanded?.(e.id)
          break
        case 'steers_returned':
          returnedSteers.push(...e.texts)
          break
        default:
          assertNever(e, 'tui:unhandled agent event')
      }
    }

    await deps.startRun(req, send, (m: ChatMessage[]) => {
      messages = m
      // Mirror the GUI: persist the running message log so the session is durable
      // and resumable even if it's interrupted mid-turn. Guarded so a store failure
      // can't crash the run (a throw here has no catch on the startRun side).
      persistMessages(m)
    })
    // A run that ended mid-thought (no event after it) still gets the rest of its
    // last line and its summary line, and reads still held back get theirs.
    flushReasoning()
    endThought(false)
    // Whatever is still held (a run cut off before it said it was done) prints now.
    flushMd()
    releaseFocusReply()
    releaseHeld()
    flushHeldCalls = () => {}
    deps.io.setLivePanel?.(null)
    flushStreamedText = () => {}
    deps.io.stopSpinner?.()
    // Drain any approval/question prompts still in flight before the next composer read.
    await prompts
    activeRunId = null
    // The turn may have added or changed the project's elevating config (an allow rule,
    // a hook, an MCP server): ask about it now, as the desktop's trust banner does after
    // each run, rather than only at the next launch.
    await promptFolderTrust(opts.cwd, deps, paint, { asked: trustAsked })
    // The terminal's progress: done, failed, or (stopped by the user) idle.
    deps.io.progress?.(interruptedQueued !== null ? 'idle' : turnFailed ? 'error' : 'done', progressLabel())
    // A second chance at a generated title, now with the reply to go on.
    if (interruptedQueued === null && !turnFailed) requestGeneratedTitle()
    // How long the turn took, said once (an interrupt already said "interrupted"). In
    // screen-reader mode it is the spinner's end as a plain line; otherwise one dim note.
    if (interruptedQueued === null) {
      const took = turnDoneText(nowFn() - turnStartedAt, deps.getSettings().tuiTurnClock === true ? nowFn() : undefined)
      deps.io.out(screenReader ? `${took}\n` : paint(`· ${took}\n`, 'dim'))
    }
    // However the run ended (a Stop sends no "done" signal), the tab is idle again.
    deps.io.signal?.({ title: idleTitle(workspaceName, tabChatTitle) })
    // Anything typed while that turn ran (steers it never read included) becomes the
    // next one, or after an interrupt, the next prompt's draft.
    const unsent = [...returnedSteers, ...(interruptedQueued ?? []), ...(deps.io.takeQueued?.() ?? [])]
    const interrupted = interruptedQueued !== null
    returnedSteers = []
    interruptedQueued = null
    // A line still being typed when the turn ended was never sent: it stays a draft.
    const typing = deps.io.takeDraft?.() ?? ''
    if (interrupted) restoreDraft = [...unsent, typing].filter(Boolean).join('\n\n')
    else {
      // Appended: entries still queued from before (one command per pass) go first.
      pendingQueued = [...pendingQueued, ...unsent]
      if (typing) halfDraft = [halfDraft, typing].filter(Boolean).join('\n\n')
    }
    saveHeldDraft()
    if (turnFinished && !interrupted && conversationId && providerId && model && deps.chatAssist) {
      const forChat = conversationId
      try {
        // Nothing queued or half-typed to send next: offer a suggested next message.
        if (!pendingQueued.length && !halfDraft) {
          deps.chatAssist.suggest(forChat, providerId, model, (text) => {
            if (conversationId !== forChat) return
            suggestion = stripControlChars(text).trim() || null
            redrawSuggestion?.()
          })
        }
      } catch {
        // best-effort
      }
    }

    // A plan-mode turn hands off to execution through the present_plan flow: the agent
    // calls present_plan, the plan_ready case above renders it and collects an
    // accept / suggest / reject verdict, and accepting flips the policy to auto-edit
    // (or ask) and carries the plan out. There is deliberately no text-only fallback:
    // treating any plain assistant answer as a "plan" spuriously offered to leave plan
    // mode after ordinary questions.
  }

  // A draft still waiting on its pause in typing is written before we go.
  draftSaver?.flush()
  // Hand the tab back with no title of ours; the shell sets its own at the next
  // prompt, and a lingering "Houston · proj" would be a lie once we're gone.
  deps.io.signal?.({ title: '' })
  stopStatusTimer()
  // The session is over: nothing it reported to the terminal still stands.
  deps.io.progress?.('clear')
  // The way back to this chat, which nothing else on screen names.
  if (conversationId && deps.persist) {
    deps.io.out(paint(comeBackHint(conversationId, opts.cwd, opts.launchCwd), 'dim'))
  }
  // Anything the host still has to finish (background sessions) prints its wait first.
  await deps.beforeExit?.()
  deps.io.out(paint('\nBye.\n', 'dim'))
  return 0
}

/**
 * The models /model offers to switch to: every model of a provider that is ready
 * (no key needed, or one saved), by its display name as the desktop's picker shows
 * it, with the current one first. Models the provider no longer serves are left out.
 */
export function modelChoices(
  settings: AppSettings,
  currentProvider: string | null,
  currentModel: string | null
): Array<{ providerId: string; model: string; label: string; description: string }> {
  const out: Array<{ providerId: string; model: string; label: string; description: string }> = []
  for (const p of settings.providers) {
    if (p.requiresKey && !p.hasKey) continue
    for (const m of p.models) {
      if (m.unavailableAt) continue
      const current = p.id === currentProvider && m.id === currentModel
      const label = m.label ?? modelDisplayName(p.kind, m.id)
      const entry = {
        providerId: p.id,
        model: m.id,
        label,
        // The id only when the name differs from it, so it is what you'd type for /model <id>.
        description: [p.label, label === m.id ? '' : m.id, current ? 'current' : ''].filter(Boolean).join(' · ')
      }
      if (current) out.unshift(entry)
      else out.push(entry)
    }
  }
  return out
}

function handleInfoCommand(
  line: string,
  state: {
    providerId: string | null
    model: string | null
    policy: ApprovalPolicy
    cwd: string
    sessionCost: SessionCost
    modelCosts: ModelCost[]
    /** What filled the context on the last main round; absent or null before one ran. */
    contextParts?: ContextParts | null
    /** The provider's measured context size for that round (0 when unknown). */
    contextTokens?: number
    /** What each subagent in the chat spent, for /cost. */
    agents?: SubagentSpend[]
  },
  deps: TuiDeps,
  paint: Painter,
  customCommands: Command[] = []
): void {
  const parts = line.slice(1).trim().split(/\s+/)
  const name = nameOf(parts[0]).toLowerCase()
  const arg = parts.slice(1).join(' ') // present only when the user passed an (invalid) arg
  if (name === 'help') {
    const width = deps.columns?.() ?? 80
    deps.io.out(`${wrapHelp(HELP_TEXT, width)}\n`)
    if (customCommands.length) {
      const rows = customCommands.map((c) => `  ${`/${c.name}`.padEnd(20)}${c.description}`).join('\n')
      deps.io.out(paint(`\nCustom commands (.houston/commands):\n${wrapHelp(rows, width, 22)}\n`, 'dim'))
    }
    return
  }
  if (name === 'cwd') {
    deps.io.out(`${state.cwd}\n`)
    return
  }
  if (name === 'share') {
    // OSC 52 asks the terminal to put the invite on the clipboard; it works over SSH,
    // and a terminal that blocks it ignores the sequence, so the link is printed too.
    deps.io.out(osc52Copy(SHARE_MESSAGE))
    deps.io.out(paint('✓ Invite copied (if your terminal allows clipboard access)\n', 'green'))
    deps.io.out(`${SHARE_MESSAGE}\n`)
    return
  }
  if (name === 'cost') {
    const agents = state.modelCosts.length ? renderSubagentSpend(state.agents ?? [], paint) : ''
    deps.io.out(`${renderCostReport(state.modelCosts, paint)}\n${agents ? `${agents}\n` : ''}`)
    return
  }
  if (name === 'context') {
    const window = state.model ? contextWindowFor(state.model) : null
    const tier = state.model ? longContextTierAbove(state.model) : null
    const compaction = compactionThresholdNote(compactionLimitFrom(deps.getSettings()), window, tier)
    deps.io.out(`${renderContextReport(state.contextParts ?? null, state.contextTokens ?? 0, window, tier, compaction)}\n`)
    return
  }
  if (name === 'theme') {
    // A present-but-unrecognized arg reached here (a valid one would have set the
    // theme); say so instead of silently just re-listing.
    if (arg) deps.io.out(paint(`· unknown theme: ${arg}\n`, 'yellow'))
    deps.io.out(paint(`themes: ${themeNames().join(', ')}  (usage: /theme <name>)\n`, 'dim'))
    for (const err of deps.themeErrors ?? []) deps.io.out(paint(`· ${terminalText(err, { lines: false })}\n`, 'yellow'))
    deps.io.out(paint('  your own: ~/.houston/themes/<name>.json, a base theme plus color overrides\n', 'dim'))
    return
  }
  if (name === 'image') {
    // Bare /image (no path) used to be a silent no-op; show how to use it.
    deps.io.out(paint('usage: /image <path>  (attach an image to your next message)\n', 'dim'))
    return
  }
  if (name === 'approval') {
    if (arg) deps.io.out(paint(`· unknown policy: ${arg}\n`, 'yellow'))
    deps.io.out(
      paint(
        `approval: ${APPROVAL_POLICY_LABEL[state.policy]}  (switch with /plan, /ask, /auto, /full)\n`,
        'dim'
      )
    )
    return
  }
  if (name === 'model' || name === 'model?') {
    const settings = deps.getSettings()
    // A present arg reached here only because it didn't resolve to a known model.
    if (arg && name === 'model') deps.io.out(paint(`· unknown model: ${arg}\n`, 'yellow'))
    const current =
      state.providerId && state.model ? `${state.providerId} / ${state.model}` : '(none, run /login)'
    deps.io.out(paint(`current: ${current}\n`, 'dim'))
    for (const p of settings.providers) {
      const ready = !p.requiresKey || p.hasKey
      const flag = ready ? '' : paint(' (no key)', 'yellow')
      const models =
        p.models.map((m) => (m.unavailableAt ? `${m.id} ${paint('(not found)', 'yellow')}` : m.id)).join(', ') ||
        paint('none', 'dim')
      deps.io.out(`  ${paint(p.id, 'cyan')}${flag}: ${models}\n`)
    }
    if (settings.providers.some((p) => p.requiresKey && !p.hasKey)) {
      deps.io.out(paint('  → run /login to add a key for a provider marked (no key)\n', 'dim'))
    }
  }
}

/**
 * The /settings hub: where the file lives, that the desktop app has the full panel,
 * and the safe subset editable from the terminal. Read-only — the editing verbs live
 * on /hooks and /mcp.
 */
/** How many lines of the highlighted row's text the /copy picker previews. */
const COPY_PREVIEW_LINES = 6

/** The /copy picker's preview: the first lines of the text, dimmed and control-stripped. */
export function copyPreviewLines(text: string, paint: Painter): string[] {
  const lines = stripControlCharsKeepLines(text).replace(/\n+$/, '').split('\n')
  const shown = lines.slice(0, COPY_PREVIEW_LINES).map((l) => paint(`  ${l}`, 'dim'))
  const rest = lines.length - COPY_PREVIEW_LINES
  if (rest > 0) shown.push(paint(`  … ${rest} more line${rest === 1 ? '' : 's'}`, 'dim'))
  return shown
}

/**
 * /copy [n]: copy the n-th latest reply to the clipboard. A reply with fenced code
 * blocks offers the whole reply or one block. OSC 52 goes out every time (it works
 * over SSH, where the terminal allows it); the platform's own clipboard helper is
 * used too when this is a local session.
 */
/**
 * Put `text` on the clipboard both ways /copy does: OSC 52 (which reaches the user's own
 * clipboard over SSH) and the platform's helper when this is a local session. True when
 * the helper took it. OSC 52 carries the text base64'd, so nothing in it reaches the
 * terminal as an escape sequence.
 */
function putOnClipboard(text: string, deps: TuiDeps): boolean {
  deps.io.out(osc52Copy(text))
  return deps.copyText?.(text) === true
}

async function runCopyCommand(
  cmd: { index: number; bad?: boolean },
  messages: readonly ChatMessage[],
  deps: TuiDeps,
  paint: Painter
): Promise<void> {
  if (cmd.bad) {
    deps.io.out(paint('· usage: /copy, or /copy <n> for the n-th latest reply\n', 'yellow'))
    return
  }
  const total = copyableReplies(messages).length
  const reply = nthLatestReply(messages, cmd.index)
  if (reply === null) {
    deps.io.out(
      paint(
        total === 0
          ? '· no reply to copy yet\n'
          : `· no reply ${cmd.index} back (there ${total === 1 ? 'is 1' : `are ${total}`})\n`,
        'yellow'
      )
    )
    return
  }
  const which = cmd.index === 1 ? 'the last reply' : `reply ${cmd.index} back`
  const blocks = extractCodeBlocks(reply)
  let text = reply
  let what = which
  if (blocks.length) {
    const options = [
      { label: 'Whole reply', value: '0', description: describeCopied(reply) },
      ...blocks.map((b, i) => ({
        label: stripControlChars(codeBlockLabel(b)),
        value: String(i + 1),
        description: `${b.lang ? `${stripControlChars(b.lang)}, ` : ''}${describeCopied(b.code)}`
      }))
    ]
    let picked: string | null = null
    if (deps.io.select) {
      const r = await deps.io.select({
        title: `Copy from ${which}:`,
        options,
        maxRows: 9,
        // The first lines of what the highlighted row would copy.
        preview: (o) => copyPreviewLines(o.value === '0' ? reply : (blocks[Number(o.value) - 1]?.code ?? ''), paint)
      })
      if (r.kind === 'cancel' || r.kind === 'interrupt') return void deps.io.out(paint('· nothing copied\n', 'dim'))
      if (r.kind === 'commit') picked = r.value
    }
    if (picked === null) {
      const list = options.map((o) => `  ${paint(`${o.value})`, 'dim')} ${o.label}  ${paint(o.description, 'dim')}`)
      deps.io.out(`Copy from ${which}:\n${list.join('\n')}\n`)
      const ans = await deps.io.readLine(`copy which? [0-${blocks.length}, Enter for the whole reply] `, {
        discardPending: true
      })
      if (ans === null) return void deps.io.out(paint('· nothing copied\n', 'dim'))
      const a = ans.trim() || '0'
      if (!options.some((o) => o.value === a)) return void deps.io.out(paint('· nothing copied\n', 'dim'))
      picked = a
    }
    const n = Number(picked)
    if (n >= 1) {
      text = blocks[n - 1].code
      what = `code block ${n}${blocks.length > 1 ? ` of ${blocks.length}` : ''} from ${which}`
    }
  }
  const native = putOnClipboard(text, deps)
  const size = describeCopied(text)
  deps.io.out(
    paint(
      native
        ? `✓ copied ${what} (${size})\n`
        : `✓ copied ${what} (${size}), if your terminal allows clipboard access\n`,
      'green'
    )
  )
}

/**
 * A project's own hooks (its `.houston/settings.json`), read-only, with whether the
 * folder's trust lets them run. Empty when the project defines none.
 */
export function renderProjectHooks(hooks: Hook[], trust: FolderTrustState, paint: Painter): string {
  if (!hooks.length) return ''
  const state =
    trust === 'trusted'
      ? paint('they run: this folder is trusted', 'green')
      : trust === 'untrusted'
        ? paint('they never run: you chose not to trust this folder', 'yellow')
        : paint('they are off until you trust this folder (/trust)', 'yellow')
  const lines = hooks.map(
    (h) =>
      `   ${paint('·', 'dim')} ${paint(stripControlChars(h.event), 'cyan')}  ${stripControlChars(h.matcher)}  ${paint('→', 'dim')} ${stripControlChars(h.command)}` +
      (h.timeout !== undefined ? paint(`  (timeout ${h.timeout}s)`, 'dim') : '')
  )
  return [`${paint("This project's hooks", 'bold')} (.houston/settings.json, read-only; ${state}):`, ...lines].join('\n')
}

/** /hooks: list (yours, then the project's), add or edit (guided), or remove a lifecycle hook. */
async function runHooksCommand(action: SettingsAction, deps: TuiDeps, paint: Painter, cwd?: string): Promise<void> {
  const hooks = deps.getSettings().hooks ?? []
  const path = deps.settingsPath?.() ?? '(unknown)'

  if (
    action.op === 'usage' ||
    action.op === 'login' ||
    action.op === 'logout' ||
    action.op === 'tools' ||
    action.op === 'search' ||
    action.op === 'registry-add' ||
    action.op === 'catalog' ||
    action.op === 'catalog-add' ||
    action.op === 'enable' ||
    action.op === 'disable' ||
    action.op === 'reconnect' ||
    (action.op === 'add' && action.url !== undefined)
  ) {
    // These are /mcp verbs; on /hooks they just fall to usage.
    deps.io.out(paint('usage: /hooks   ·   /hooks add   ·   /hooks edit <n>   ·   /hooks remove <n>\n', 'yellow'))
    return
  }
  if (action.op === 'list') {
    deps.io.out(`${renderHookList(hooks, paint)}\n${renderSettingsFooter(path, paint)}\n`)
    if (cwd) {
      const cfg = await loadProjectConfig(cwd).catch(() => null)
      const projectHooks = cfg?.elevated.hooks ?? []
      if (cfg && projectHooks.length) {
        let real = cwd
        try {
          real = realpathSync(cwd)
        } catch {
          // keep the path as given; trust records normalize the same way
        }
        const trust = folderTrustState(deps.getSettings().trustedFolders, real, cfg.elevatedHash)
        deps.io.out(`${renderProjectHooks(projectHooks, trust, paint)}\n`)
      }
    }
    return
  }
  if (!deps.updateSettings) {
    deps.io.out(paint('· editing settings is unavailable here\n', 'dim'))
    return
  }
  if (action.op === 'remove') {
    if (action.index > hooks.length) {
      deps.io.out(paint(`· no hook #${action.index} (there ${hooks.length === 1 ? 'is 1' : `are ${hooks.length}`})\n`, 'yellow'))
      return
    }
    const removed = hooks[action.index - 1]
    // Rebuild without the removed entry (never mutate the settings array in place).
    deps.updateSettings({ hooks: hooks.filter((_, i) => i !== action.index - 1) })
    deps.io.out(paint(`· removed hook ${action.index} (${removed.event} ${removed.matcher}). Applies on your next message.\n`, 'dim'))
    return
  }

  if (action.op === 'edit') {
    const cur = hooks[action.index - 1]
    if (!cur) {
      deps.io.out(paint(`· no hook #${action.index} (there ${hooks.length === 1 ? 'is 1' : `are ${hooks.length}`})\n`, 'yellow'))
      return
    }
    // The add prompts, with each field's current value as the Enter answer.
    deps.io.out(
      `Edit hook ${action.index}. Enter keeps a value.\n  ${paint('events:', 'dim')} ${HOOK_EVENTS.map((e, i) => `${i + 1}) ${e}`).join('   ')}\n`
    )
    const evAns = await deps.io.readLine(`event (Enter for ${cur.event}): `)
    if (evAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
    const matcherAns = await deps.io.readLine(`matcher (Enter for ${cur.matcher}): `)
    if (matcherAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
    const cmdAns = await deps.io.readLine(`command (Enter for ${cur.command}): `)
    if (cmdAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
    const curTimeout = cur.timeout !== undefined ? String(cur.timeout) : ''
    const timeoutAns = await deps.io.readLine(
      `timeout in seconds (Enter for ${curTimeout ? `${curTimeout}; - for the default, ${HOOK_TIMEOUT_MS / 1000}` : `the default, ${HOOK_TIMEOUT_MS / 1000}`}): `
    )
    if (timeoutAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
    const keep = (ans: string, was: string): string => (ans.trim() ? ans : was)
    const timeout = timeoutAns.trim() === '-' ? '' : keep(timeoutAns, curTimeout)
    const built = buildHook(resolveHookEventInput(keep(evAns, cur.event)), keep(matcherAns, cur.matcher), keep(cmdAns, cur.command), timeout)
    if ('error' in built) return void deps.io.out(paint(`· ${built.error}\n`, 'yellow'))
    const same =
      built.event === cur.event && built.matcher === cur.matcher && built.command === cur.command && built.timeout === cur.timeout
    if (same) return void deps.io.out(paint('· nothing changed\n', 'dim'))
    const shownTimeout = built.timeout !== undefined ? `  (timeout ${built.timeout}s)` : ''
    deps.io.out(`\n${paint('hook:', 'dim')} ${built.event}  ${built.matcher}  → ${built.command}${shownTimeout}\n`)
    const ok = await deps.io.readLine('Save this hook? [y/N] ', { discardPending: true })
    if (parseApprovalAnswer(ok ?? '').decision !== 'allow') return void deps.io.out(paint('· not changed\n', 'dim'))
    // Re-read so an edit in the app since the prompts began isn't thrown away; the
    // hook keeps its place (hooks run in list order).
    const latest = deps.getSettings().hooks ?? []
    if (JSON.stringify(latest[action.index - 1]) !== JSON.stringify(cur)) {
      return void deps.io.out(paint('· that hook changed elsewhere meanwhile; nothing saved. /hooks lists them again.\n', 'yellow'))
    }
    deps.updateSettings({ hooks: latest.map((h, i) => (i === action.index - 1 ? built : h)) })
    deps.io.out(paint(`· hook ${action.index} saved. Applies on your next message.\n`, 'dim'))
    return
  }

  // op === 'add' — guided, one field per prompt.
  deps.io.out(`Add a hook.\n  ${paint('events:', 'dim')} ${HOOK_EVENTS.map((e, i) => `${i + 1}) ${e}`).join('   ')}\n`)
  const evAns = await deps.io.readLine('event (number or name): ')
  if (evAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
  const matcherAns = await deps.io.readLine(
    'matcher (tool name or glob, e.g. edit_file or *; for Notification a wait type such as tool_approval; blank = any): '
  )
  if (matcherAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
  const cmdAns = await deps.io.readLine('command (shell to run): ')
  if (cmdAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
  const timeoutAns = await deps.io.readLine(`timeout in seconds (blank = ${HOOK_TIMEOUT_MS / 1000}): `)
  if (timeoutAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))

  const built = buildHook(resolveHookEventInput(evAns), matcherAns, cmdAns, timeoutAns)
  if ('error' in built) return void deps.io.out(paint(`· ${built.error}\n`, 'yellow'))

  const shownTimeout = built.timeout !== undefined ? `  (timeout ${built.timeout}s)` : ''
  deps.io.out(`\n${paint('hook:', 'dim')} ${built.event}  ${built.matcher}  → ${built.command}${shownTimeout}\n`)
  const ok = await deps.io.readLine('Add this hook? [y/N] ', { discardPending: true })
  if (parseApprovalAnswer(ok ?? '').decision !== 'allow')
    return void deps.io.out(paint('· not added\n', 'dim'))
  deps.updateSettings({ hooks: [...hooks, built] })
  deps.io.out(paint('· hook added. Applies on your next message.\n', 'dim'))
}

/**
 * `/mcp search` results. Registry text is the publisher's, already stripped of
 * control characters by the normalizer; it is printed as data and never sent anywhere.
 */
export function renderRegistryResults(servers: RegistryServer[], query: string, paint: Painter): string {
  if (!servers.length) return paint(query ? `· no MCP Registry servers match "${query}"` : '· the MCP Registry listed no servers', 'dim')
  const lines = [paint(`MCP Registry${query ? `: "${query}"` : ''}`, 'bold')]
  servers.forEach((s, i) => {
    lines.push(`  ${i + 1}) ${paint(s.name, 'cyan')}${s.version ? `  v${s.version}` : ''}${s.status && s.status !== 'active' ? paint(`  (${s.status})`, 'yellow') : ''}`)
    if (s.description) lines.push(`     ${s.description}`)
    lines.push(paint(`     ${registryDelivery(s)}`, 'dim'))
    if (s.repositoryUrl) lines.push(paint(`     ${s.repositoryUrl}`, 'dim'))
  })
  lines.push(paint('Add one with /mcp add-from-registry <name>. It is saved switched off.', 'dim'))
  return lines.join('\n')
}

/**
 * /mcp add-from-registry <name>: convert the entry's first installable local package
 * (pinned npx, uvx or docker) into a stdio server, ask for its variables, show it,
 * and add it switched off on a yes. Remote entries need headers, which the terminal
 * can't store, so they are pointed at the desktop app.
 */
async function addFromRegistry(name: string, servers: McpServerConfig[], deps: TuiDeps, paint: Painter): Promise<void> {
  if (!deps.mcpRegistry) return void deps.io.out(paint('· the MCP Registry is unavailable in this client\n', 'dim'))
  const res = await deps.mcpRegistry.get(name)
  if (!res.ok) return void deps.io.out(paint(`· ${res.error}\n`, 'yellow'))
  const options = registryInstallOptions(res.server)
  const local = options.find((o) => o.kind === 'stdio' && 'draft' in o)
  if (!local || !('draft' in local)) {
    const why = options.find((o) => o.kind === 'stdio' && 'unsupported' in o)
    if (why && 'unsupported' in why) deps.io.out(paint(`· ${why.label}: ${why.unsupported}\n`, 'yellow'))
    deps.io.out(
      paint(
        options.some((o) => o.kind === 'remote' && 'draft' in o)
          ? '· this server is remote: add it in the desktop app (Settings > MCP Servers > Browse registry)\n'
          : '· no package here that Houston can install\n',
        'yellow'
      )
    )
    return
  }
  return reviewStdioDraft(local.draft, servers, deps, paint)
}

/**
 * Review a local (stdio) server draft, from the registry or the shipped catalog, and
 * add it switched off: its arguments can be changed, each input it declares is asked
 * for (a secret one hidden), and nothing is saved without a final yes.
 */
async function reviewStdioDraft(draft: McpDraft, servers: McpServerConfig[], deps: TuiDeps, paint: Painter): Promise<void> {
  const id = freeServerId(draft.server.id, servers.map((s) => s.id))
  deps.io.out(`${paint(draft.name, 'bold')}  ${paint(`from ${draft.publisher}`, 'dim')}\n`)
  if (draft.note) deps.io.out(paint(`${draft.note}\n`, 'dim'))
  if (draft.needs) deps.io.out(paint(`Needs ${draft.needs} installed.\n`, 'dim'))
  deps.io.out(`${paint('command:', 'dim')} ${draft.server.command} ${(draft.server.args ?? []).join(' ')}\n`)
  const argsAns = await deps.io.readLine('arguments (space-separated; Enter keeps them as shown): ')
  if (argsAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
  const args = argsAns.trim() ? argsAns.trim().split(/\s+/) : (draft.server.args ?? [])
  const readSecret = deps.io.readSecret ?? deps.io.readLine
  const values: Record<string, string> = {}
  for (const input of draft.inputs ?? []) {
    const what = [input.description, input.default && !input.required ? `empty uses ${input.default}` : ''].filter(Boolean).join('; ')
    if (what) deps.io.out(paint(`  ${input.name}: ${what}\n`, 'dim'))
    const label = `${input.name}${input.required ? '' : ' (optional, Enter to skip)'}${input.secret ? ' (hidden)' : ''}: `
    const v = await (input.secret ? readSecret(label) : deps.io.readLine(label))
    if (v === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
    values[draftInputKey(input)] = v
  }
  const built = { ...applyDraftInputs({ ...draft.server, id, args }, draft.inputs ?? [], values), name: id, enabled: false }
  const problem = serverProblem(built, servers.map((s) => s.id))
  if (problem) return void deps.io.out(paint(`· not added: ${problem}\n`, 'yellow'))
  const envNote = built.env ? `  env: ${Object.keys(built.env).join(', ')}` : ''
  deps.io.out(`\n${paint('server:', 'dim')} ${id}  [stdio, switched off]  ${built.command} ${(built.args ?? []).join(' ')}${envNote}\n`)
  const ok = await deps.io.readLine('Add this server? [y/N] ', { discardPending: true })
  if (parseApprovalAnswer(ok ?? '').decision !== 'allow') return void deps.io.out(paint('· not added\n', 'dim'))
  deps.updateSettings?.({ mcpServers: [...servers, built] })
  deps.io.out(paint(`· added ${id} as #${servers.length + 1}, switched off. Switch it on with /mcp enable ${servers.length + 1}.\n`, 'dim'))
  if (built.env && deps.canStoreHeaderSecrets === false) {
    deps.io.out(
      paint(`· this terminal cannot store env values; put them in cli-headers.json under the scope "mcp-env:${id}"\n`, 'yellow')
    )
  }
}

/**
 * /mcp: list (with live connection status and each server's last error), add
 * (guided stdio, or `--url` for a remote server), enable/disable, reconnect,
 * remove, or OAuth sign-in/out for a remote server. Persists via
 * deps.updateSettings. It never collects auth headers: a server that needs a token
 * header is set up in the desktop app, one that uses OAuth signs in with `/mcp login`.
 */
/** The recommended servers shipped with the app, numbered for `/mcp add-from-catalog <n>`. */
export function renderMcpCatalog(configured: McpServerConfig[], paint: Painter): string {
  const have = new Set(configured.map((s) => s.id))
  const lines = [paint('Recommended MCP servers (shipped with Houston, pinned versions):', 'bold')]
  MCP_CATALOG.forEach((e, i) => {
    const tag = have.has(e.id) ? paint('  (added)', 'dim') : e.transport !== 'stdio' ? paint('  (remote)', 'dim') : ''
    lines.push(`  ${paint(`${String(i + 1).padStart(2)})`, 'cyan')} ${e.name}${tag}  ${paint(`from ${e.publisher}`, 'dim')}`)
    lines.push(`      ${e.description}`)
  })
  lines.push(paint('Review and add one with /mcp add-from-catalog <n>. It is saved switched off.', 'dim'))
  return lines.join('\n')
}

/**
 * /mcp edit <n>: change what a server runs (stdio: command, arguments, working folder)
 * or where it is (remote: the URL), with today's values as the Enter answers. Env and
 * header values are secrets and are never shown or asked for here; they are kept as
 * they are.
 */
async function editMcpServer(target: McpServerConfig, index: number, deps: TuiDeps, paint: Painter): Promise<void> {
  if (!deps.updateSettings) return void deps.io.out(paint('· editing settings is unavailable here\n', 'dim'))
  const label = stripControlChars(target.name ?? target.id)
  const transport = target.transport ?? (target.url && !target.command ? 'http' : 'stdio')
  deps.io.out(`Edit MCP server ${index} (${label}). Enter keeps a value, Ctrl-D cancels.\n`)
  let next: McpServerConfig
  if (transport === 'stdio') {
    const cmd = await deps.io.readLine(`command (Enter for ${stripControlChars(target.command)}): `)
    if (cmd === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
    const curArgs = (target.args ?? []).join(' ')
    const args = await deps.io.readLine(`arguments, space-separated (Enter for ${curArgs ? stripControlChars(curArgs) : 'none'}; - for none): `)
    if (args === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
    const cwdAns = await deps.io.readLine(`working folder (Enter for ${target.cwd ? stripControlChars(target.cwd) : 'none'}; - for none): `)
    if (cwdAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
    const command = cmd.trim() || target.command
    if (!command.trim()) return void deps.io.out(paint('· a command to run is required; nothing changed\n', 'yellow'))
    const newArgs = args.trim() === '-' ? [] : args.trim() ? args.trim().split(/\s+/) : (target.args ?? [])
    const newCwd = cwdAns.trim() === '-' ? '' : cwdAns.trim() || (target.cwd ?? '')
    const { args: _a, cwd: _c, ...rest } = target
    next = { ...rest, command, ...(newArgs.length ? { args: newArgs } : {}), ...(newCwd ? { cwd: newCwd } : {}) }
    if (target.env && Object.keys(target.env).length) {
      deps.io.out(paint(`· env ${Object.keys(target.env).join(', ')} kept as is (values are changed in the desktop app)\n`, 'dim'))
    }
  } else {
    const urlAns = await deps.io.readLine(`URL (Enter for ${stripControlChars(target.url ?? '')}): `)
    if (urlAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
    const url = urlAns.trim() || target.url || ''
    // The same checks /mcp add --url applies (http(s), no credentials, no control characters).
    const checked = buildRemoteMcpServer([], url, target.id, transport === 'sse')
    if ('error' in checked) return void deps.io.out(paint(`· ${checked.error}; nothing changed\n`, 'yellow'))
    next = { ...target, url: checked.url }
  }
  if (JSON.stringify(next) === JSON.stringify(target)) return void deps.io.out(paint('· nothing changed\n', 'dim'))
  const shown =
    transport === 'stdio' ? `${next.command} ${(next.args ?? []).join(' ')}${next.cwd ? `  (in ${next.cwd})` : ''}` : (next.url ?? '')
  deps.io.out(`\n${paint('server:', 'dim')} ${label}  [${transport}]  ${stripControlChars(shown)}\n`)
  const ok = await deps.io.readLine('Save these changes? [y/N] ', { discardPending: true })
  if (parseApprovalAnswer(ok ?? '').decision !== 'allow') return void deps.io.out(paint('· not changed\n', 'dim'))
  const latest = deps.getSettings().mcpServers ?? []
  if (latest[index - 1]?.id !== target.id) {
    return void deps.io.out(paint('· the server list changed elsewhere meanwhile; nothing saved. /mcp lists them again.\n', 'yellow'))
  }
  // Header and env values come back masked from settings and the save keeps the stored ones.
  // `next` replaces the entry whole, so a cleared argument list or folder stays cleared;
  // the switch and the secrets' keys come from the latest copy.
  deps.updateSettings({
    mcpServers: latest.map((s, i) =>
      i === index - 1
        ? { ...next, enabled: s.enabled, ...(s.env ? { env: s.env } : {}), ...(s.headers ? { headers: s.headers } : {}) }
        : s
    )
  })
  deps.io.out(paint(`· saved. It reconnects on your next message (or now with /mcp reconnect ${index}).\n`, 'dim'))
}

async function runMcpCommand(action: SettingsAction, deps: TuiDeps, paint: Painter, cwd?: string): Promise<void> {
  const servers = deps.getSettings().mcpServers ?? []
  const path = deps.settingsPath?.() ?? '(unknown)'

  const noServer = (n: number): void =>
    deps.io.out(
      paint(`· no MCP server #${n} (there ${servers.length === 1 ? 'is 1' : `are ${servers.length}`})\n`, 'yellow')
    )

  if (action.op === 'usage') {
    deps.io.out(
      paint(
        'usage: /mcp   ·   /mcp add   ·   /mcp add --url <url> [name] [--sse]   ·   /mcp tools <n>   ·   /mcp enable|disable <n>\n' +
          '       /mcp reconnect <n|all>   ·   /mcp remove <n>   ·   /mcp login <n>   ·   /mcp logout <n>\n' +
          '       /mcp search <query>   ·   /mcp add-from-registry <name>   ·   /mcp catalog   ·   /mcp add-from-catalog <n>\n' +
          '       /mcp edit <n>\n',
        'yellow'
      )
    )
    return
  }
  if (action.op === 'catalog') return void deps.io.out(`${renderMcpCatalog(servers, paint)}\n`)
  if (action.op === 'list') {
    deps.io.out(`${renderMcpList(servers, paint, deps.mcpStatuses?.() ?? [])}\n${renderSettingsFooter(path, paint)}\n`)
    deps.io.out(
      paint(
        'Remote servers: /mcp add --url <url>, then /mcp login <n> if it asks you to sign in. One that needs a token header is set up in the desktop app.\n',
        'dim'
      )
    )
    return
  }

  if (action.op === 'search') {
    if (!deps.mcpRegistry) return void deps.io.out(paint('· the MCP Registry is unavailable in this client\n', 'dim'))
    const res = await deps.mcpRegistry.search(action.query)
    if (!res.ok) return void deps.io.out(paint(`· ${res.error}\n`, 'yellow'))
    deps.io.out(`${renderRegistryResults(res.page.servers, action.query.trim(), paint)}\n`)
    return
  }

  if (action.op === 'reconnect') {
    if (action.index !== 'all' && !servers[action.index - 1]) return noServer(action.index)
    if (!deps.mcpReconnect) {
      deps.io.out(paint('· reconnecting is unavailable here; the next message reconnects a changed server\n', 'dim'))
      return
    }
    const targets = action.index === 'all' ? servers.filter((s) => s.enabled) : [servers[action.index - 1]]
    if (!targets.length) {
      deps.io.out(paint('· no enabled MCP servers to reconnect\n', 'dim'))
      return
    }
    const off = targets.find((s) => !s.enabled)
    if (off) {
      deps.io.out(paint(`· "${off.name ?? off.id}" is disabled; /mcp enable ${action.index} first\n`, 'yellow'))
      return
    }
    deps.io.startSpinner?.('Reconnecting')
    let statuses: McpServerStatus[]
    try {
      statuses = await deps.mcpReconnect(targets.map((s) => s.id))
    } catch (e) {
      deps.io.out(paint(`· reconnect failed: ${stripControlChars((e as Error).message)}\n`, 'yellow'))
      return
    } finally {
      deps.io.stopSpinner?.()
    }
    for (const s of targets) {
      const st = statuses.find((x) => x.id === s.id)
      const label = s.name ?? s.id
      if (st?.state === 'connected') {
        deps.io.out(paint(`· "${label}" reconnected, ${st.tools ?? 0} tool${st.tools === 1 ? '' : 's'}\n`, 'green'))
      } else if (st?.state === 'needs-auth') {
        deps.io.out(paint(`· "${label}" needs sign-in (/mcp login ${servers.indexOf(s) + 1})\n`, 'yellow'))
      } else {
        const why = truncate(stripControlChars(st?.error ?? 'did not connect').replace(/\s+/g, ' ').trim(), 160)
        deps.io.out(paint(`· "${label}" failed to connect: ${why}\n`, 'red'))
      }
    }
    return
  }

  if (action.op === 'tools') {
    const server = servers[action.index - 1]
    if (!server) {
      deps.io.out(
        paint(
          `· no MCP server #${action.index} (there ${servers.length === 1 ? 'is 1' : `are ${servers.length}`})\n`,
          'yellow'
        )
      )
      return
    }
    const st = (deps.mcpStatuses?.() ?? []).find((x) => x.id === server.id)
    deps.io.out(`${renderMcpTools(server.name ?? server.id, st, paint)}\n`)
    return
  }

  if (action.op === 'login' || action.op === 'logout') {
    const server = servers[action.index - 1]
    if (!server) {
      deps.io.out(paint(`· no MCP server #${action.index} (there ${servers.length === 1 ? 'is 1' : `are ${servers.length}`})\n`, 'yellow'))
      return
    }
    const transport = server.transport ?? (server.url && !server.command ? 'http' : 'stdio')
    if (transport === 'stdio' || !server.url) {
      deps.io.out(paint(`· "${server.name ?? server.id}" is a local stdio server; OAuth sign-in applies to remote (http/sse) servers\n`, 'yellow'))
      return
    }
    if (!deps.mcpOAuth) {
      deps.io.out(paint('· OAuth sign-in is unavailable in this client\n', 'dim'))
      return
    }
    if (action.op === 'logout') {
      if (!server.hasOAuth) {
        deps.io.out(paint(`· "${server.name ?? server.id}" has no stored sign-in\n`, 'dim'))
        return
      }
      deps.mcpOAuth.logout(server.id)
      deps.io.out(paint(`· signed out of "${server.name ?? server.id}". Applies on your next message.\n`, 'dim'))
      return
    }
    try {
      await deps.mcpOAuth.login(server, (message) => deps.io.out(paint(`· ${message}\n`, 'dim')))
      deps.io.out(paint(`· signed in to "${server.name ?? server.id}". Applies on your next message.\n`, 'green'))
    } catch (e) {
      deps.io.out(paint(`· sign-in failed: ${(e as Error).message}\n`, 'yellow'))
    }
    return
  }

  if (!deps.updateSettings) {
    deps.io.out(paint('· editing settings is unavailable here\n', 'dim'))
    return
  }
  if (action.op === 'remove') {
    if (action.index > servers.length) {
      deps.io.out(paint(`· no MCP server #${action.index} (there ${servers.length === 1 ? 'is 1' : `are ${servers.length}`})\n`, 'yellow'))
      return
    }
    const removed = servers[action.index - 1]
    deps.updateSettings({ mcpServers: servers.filter((_, i) => i !== action.index - 1) })
    deps.io.out(paint(`· removed MCP server ${action.index} (${removed.name ?? removed.id}). Applies on your next message.\n`, 'dim'))
    return
  }
  if (action.op === 'enable' || action.op === 'disable') {
    const target = servers[action.index - 1]
    if (!target) return noServer(action.index)
    const on = action.op === 'enable'
    const label = target.name ?? target.id
    if (target.enabled === on) {
      deps.io.out(paint(`· "${label}" is already ${on ? 'enabled' : 'disabled'}\n`, 'dim'))
      return
    }
    // The same `enabled` switch as the desktop's Settings > MCP servers checkbox; the
    // run start connects only enabled servers and closes a disabled one's connection.
    deps.updateSettings({ mcpServers: servers.map((s, i) => (i === action.index - 1 ? { ...s, enabled: on } : s)) })
    deps.io.out(
      paint(
        on
          ? `· enabled "${label}". It connects on your next message.\n`
          : `· disabled "${label}". Its tools are off from your next message.\n`,
        'dim'
      )
    )
    return
  }

  if (action.op === 'registry-add') return addFromRegistry(action.name, servers, deps, paint)

  if (action.op === 'catalog-add') {
    const n = Number(action.entry)
    const entry = /^\d+$/.test(action.entry) ? MCP_CATALOG[n - 1] : MCP_CATALOG.find((e) => e.id === action.entry)
    if (!entry) return void deps.io.out(paint(`· no recommended server "${stripControlChars(action.entry)}"; /mcp catalog lists them\n`, 'yellow'))
    if (entry.transport !== 'stdio') {
      // A remote entry needs header values the terminal doesn't collect for MCP servers.
      const how = entry.headers
        ? 'it needs a token header, so add it in the desktop app (Settings > MCP Servers > Recommended)'
        : `add it with /mcp add --url ${entry.url ?? '<url>'} ${entry.id}`
      return void deps.io.out(paint(`· ${entry.name} is a remote server: ${how}\n`, 'yellow'))
    }
    return reviewStdioDraft(catalogDraft(entry, cwd ?? null), servers, deps, paint)
  }

  if (action.op === 'edit') {
    const target = servers[action.index - 1]
    if (!target) return noServer(action.index)
    return editMcpServer(target, action.index, deps, paint)
  }

  if (action.url !== undefined) {
    const built = buildRemoteMcpServer(servers.map((s) => s.id), action.url, action.name, action.sse)
    if ('error' in built) return void deps.io.out(paint(`· ${built.error}\n`, 'yellow'))
    deps.io.out(`\n${paint('server:', 'dim')} ${built.name}  [${built.transport}]  ${built.url}\n`)
    const ok = await deps.io.readLine('Add this server? [y/N] ', { discardPending: true })
    if (parseApprovalAnswer(ok ?? '').decision !== 'allow') return void deps.io.out(paint('· not added\n', 'dim'))
    deps.updateSettings({ mcpServers: [...servers, built] })
    deps.io.out(
      paint(
        `· MCP server added as #${servers.length + 1}. It connects on your next message; if it asks you to sign in, run /mcp login ${servers.length + 1}.\n`,
        'dim'
      )
    )
    return
  }

  // op === 'add' — local stdio servers only.
  deps.io.out(paint('Add a local (stdio) MCP server. For a remote one, use /mcp add --url <url> [name].\n', 'dim'))
  const nameAns = await deps.io.readLine('name (letters, numbers, - or _): ')
  if (nameAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
  const cmdAns = await deps.io.readLine('command to spawn (e.g. npx): ')
  if (cmdAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
  const argsAns = await deps.io.readLine('args (space-separated, optional): ')
  if (argsAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
  const cwdAns = await deps.io.readLine('working directory (optional): ')
  if (cwdAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
  const envAns = await deps.io.readLine('env (KEY=value pairs, space-separated, optional): ')
  if (envAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))

  const built = buildStdioMcpServer(servers.map((s) => s.id), nameAns, cmdAns, argsAns, cwdAns, envAns)
  if ('error' in built) return void deps.io.out(paint(`· ${built.error}\n`, 'yellow'))

  const envNote = built.env ? `  env: ${Object.keys(built.env).join(', ')}` : ''
  deps.io.out(
    `\n${paint('server:', 'dim')} ${built.name}  [stdio]  ${built.command}${built.args?.length ? ` ${built.args.join(' ')}` : ''}${built.cwd ? `  (cwd: ${built.cwd})` : ''}${envNote}\n`
  )
  const ok = await deps.io.readLine('Add this server? [y/N] ', { discardPending: true })
  if (parseApprovalAnswer(ok ?? '').decision !== 'allow')
    return void deps.io.out(paint('· not added\n', 'dim'))
  deps.updateSettings({ mcpServers: [...servers, built] })
  deps.io.out(paint('· MCP server added. Applies on your next message.\n', 'dim'))
  if (built.env && deps.canStoreHeaderSecrets === false) {
    deps.io.out(
      paint(
        `· this terminal cannot store env values; put them in cli-headers.json under the scope "mcp-env:${built.id}"\n`,
        'yellow'
      )
    )
  }
}
