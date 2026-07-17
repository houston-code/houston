import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from 'react'
import { APPROVAL_POLICIES } from '@shared/types'
import type { AppSettings, ApprovalPolicy, ChatGroup, SelectedModel } from '@shared/types'
import type { ConversationMeta, PlanDecision, ReasoningEffort, RepoInfo } from '@shared/agent'
import {
  mergeCommands,
  builtinCommands,
  parseAgentInvocation,
  agentInvocationPrompt,
  type Command
} from '@shared/commands'
import type { ImageAttachment } from '@shared/images'
import { resolveCapabilities } from '@shared/usage'
import { pickDefaultModel } from '@shared/models'
import { branchNameError, planNewChatWorkspace, suggestBranch } from './lib/worktree'
import { useApplyTheme } from './hooks/useApplyTheme'
import { useRunningConversations } from './hooks/useRunningConversations'
import { useBackgroundTasks, type BackgroundTask } from './hooks/useBackgroundTasks'
import { useBackgroundShells } from './hooks/useBackgroundShells'
import { useTerminals } from './hooks/useTerminals'
import {
  matchShortcut,
  isEditableTarget,
  isMacPlatform,
  shortcutHint,
  terminalKeepsKey
} from './lib/shortcuts'
import { chatAtIndex, cycleChatId } from './lib/sessionNav'
import { nextApprovalPolicy } from './lib/policyCycle'
import { resolveShortcuts } from './lib/keybindingOverrides'
import type { PaletteItem } from './lib/palette'
import { statusText } from './lib/statusLine'
import { newGroupId } from './lib/chatGroups'
import {
  clampSidebarWidth,
  SIDEBAR_COLLAPSE_AT,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_NUDGE_STEP,
  SIDEBAR_RAIL_WIDTH
} from './lib/sidebar'
import { clampTerminalHeight, TERMINAL_DEFAULT_HEIGHT } from './lib/terminalPanel'
import { clampPreviewWidth, PREVIEW_DEFAULT_WIDTH } from './lib/previewPanel'
import { clampPlanWidth, PLAN_DEFAULT_WIDTH } from './lib/planPanel'
import { usePreviewServers } from './hooks/usePreviewServers'
import { useChat } from './hooks/useChat'
import { useInputQueue } from './hooks/useInputQueue'
import { useWorkingTreeStats } from './hooks/useWorkingTreeStats'
import { saveComposerDraft } from './lib/composerDraft'
import { itemsFromMessages, lastUserText } from './lib/items'
import { Sidebar, type ConversationStatusFilter } from './components/Sidebar'
import { Titlebar } from './components/Titlebar'
import { ControlBar, POLICY_LABEL } from './components/ControlBar'
import { Transcript } from './components/Transcript'
import { PlanPanel } from './components/PlanPanel'
import { Composer } from './components/Composer'
import { GitInitBanner } from './components/GitInitBanner'
import { TrustFolderBanner } from './components/TrustFolderBanner'
import { UpdateBanner } from './components/UpdateBanner'
import { LegalGate } from './components/LegalGate'
import { isAnyPopoverOpen } from './components/Popover'
import { LEGAL_VERSION, needsLegalAcceptance } from '@shared/legal'
import type {
  UpdateCheckResult,
  UpdateDownloaded,
  UpdateDownloadProgress,
  WhatsNew
} from '@shared/update'

// These overlays aren't on the initial render path, so load them as separate
// chunks fetched on first open instead of bloating the main bundle. SettingsModal
// alone is the largest component in the renderer.
const DoctorModal = lazy(() =>
  import('./components/DoctorModal').then((m) => ({ default: m.DoctorModal }))
)
const SettingsModal = lazy(() =>
  import('./components/SettingsModal').then((m) => ({ default: m.SettingsModal }))
)
const DiffPanel = lazy(() => import('./components/DiffPanel').then((m) => ({ default: m.DiffPanel })))
const FilesPanel = lazy(() =>
  import('./components/FilesPanel').then((m) => ({ default: m.FilesPanel }))
)
const Scorecard = lazy(() =>
  import('./components/Scorecard').then((m) => ({ default: m.Scorecard }))
)
const TerminalDock = lazy(() =>
  import('./components/TerminalDock').then((m) => ({ default: m.TerminalDock }))
)
const PreviewDock = lazy(() =>
  import('./components/PreviewDock').then((m) => ({ default: m.PreviewDock }))
)
const WhatsNewModal = lazy(() =>
  import('./components/WhatsNewModal').then((m) => ({ default: m.WhatsNewModal }))
)
const ShortcutsHelp = lazy(() =>
  import('./components/ShortcutsHelp').then((m) => ({ default: m.ShortcutsHelp }))
)
const CommandPalette = lazy(() =>
  import('./components/CommandPalette').then((m) => ({ default: m.CommandPalette }))
)
const FindBar = lazy(() => import('./components/FindBar').then((m) => ({ default: m.FindBar })))

/** Built-in slash commands, derived from the shared catalog (custom ones are
 * loaded from the workspace). Same source the TUI and the agent's product
 * knowledge draw from, so the three never drift apart. */
const BUILTIN_COMMANDS: Command[] = builtinCommands('gui')

/** Map a policy-preset command name to its ApprovalPolicy. */
const POLICY_COMMANDS: Record<string, ApprovalPolicy> = {
  plan: 'plan',
  ask: 'ask',
  auto: 'auto-edit',
  full: 'full-auto'
}

/**
 * The message the Changes panel's "Create PR" button hands to the agent. The
 * renderer never drives git/gh itself — it asks the agent to do the commit →
 * push → open-PR flow with its existing tools, under the normal approval gate.
 *
 * The branch logic is the crux: a fresh change opens an independent PR against
 * the default branch, but when the current branch already has an open PR the new
 * change is stacked on top — head branched off the current tip, base pointed at
 * that PR's branch — so the new PR's diff shows only the increment, never the
 * earlier PR's commits.
 */
const CREATE_PR_PROMPT = `Create a GitHub pull request for my current changes, using git and the gh_pr_create tool. Never check out or commit to the default branch directly — it may be checked out in another worktree.

1. Run \`git fetch origin\` and identify the repository's default branch (e.g. main).
2. Choose the PR's head branch:
   - If I'm currently on the default branch, OR the current branch already has an open PR (check with \`gh pr list --head <current-branch>\`): create a new branch off the current tip and use that as the head.
   - Otherwise: use the current branch as the head.
3. Stage and commit the changes on that head branch with a clear, conventional commit message, then push it to origin.
4. Open the PR with gh_pr_create, choosing the base branch:
   - If the current branch already had an open PR, this change is stacked on it — set base to that PR's branch, so the new PR's diff shows only these changes and not the earlier PR's.
   - Otherwise set base to the default branch.
5. Reply with the PR link and a short summary, and say whether you opened an independent PR or stacked it on top of which PR/branch.`

/** Pick a sensible default model: first provider that has a key and a model. */
function defaultSelection(settings: AppSettings): SelectedModel | null {
  if (settings.selected) return settings.selected
  const ready = settings.providers.find((p) => (!p.requiresKey || p.hasKey) && p.models.length > 0)
  if (ready) return { providerId: ready.id, model: pickDefaultModel(ready) ?? ready.models[0].id }
  return null
}

export default function App(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [conversations, setConversations] = useState<ConversationMeta[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [lastWorkspace, setLastWorkspace] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [doctorOpen, setDoctorOpen] = useState(false)
  const [changesOpen, setChangesOpen] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  const [scorecardOpen, setScorecardOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteSeed, setPaletteSeed] = useState('')
  const [findOpen, setFindOpen] = useState(false)
  // Worktree setup for a not-yet-started chat (shown inline in the control bar).
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null)
  const [worktreeMode, setWorktreeMode] = useState(true)
  const [branchName, setBranchName] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [commands, setCommands] = useState<Command[]>(BUILTIN_COMMANDS)
  // Workspaces the user chose "Not now" for on the first-write git-init banner — an
  // in-memory, per-session dismissal (persisted "don't ask again" lives in settings).
  const [gitInitNotNow, setGitInitNotNow] = useState<ReadonlySet<string>>(() => new Set())
  const [search, setSearch] = useState('')
  const [matchIds, setMatchIds] = useState<Set<string> | null>(null)
  // Sidebar status filter: "active" hides archived chats; "archived" shows only them.
  const [statusFilter, setStatusFilter] = useState<ConversationStatusFilter>('active')
  const [update, setUpdate] = useState<Extract<UpdateCheckResult, { status: 'available' }> | null>(
    null
  )
  const [updateProgress, setUpdateProgress] = useState<UpdateDownloadProgress | null>(null)
  const [updateDownloaded, setUpdateDownloaded] = useState<UpdateDownloaded | null>(null)
  const [whatsNew, setWhatsNew] = useState<WhatsNew | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  // Latches true on first open and stays mounted thereafter (hidden via CSS when
  // closed) so terminal sessions and scrollback survive hide/show.
  const [terminalMounted, setTerminalMounted] = useState(false)
  const [terminalHeight, setTerminalHeight] = useState(TERMINAL_DEFAULT_HEIGHT)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewWidth, setPreviewWidth] = useState(PREVIEW_DEFAULT_WIDTH)
  const [planWidth, setPlanWidth] = useState(PLAN_DEFAULT_WIDTH)
  // The plan-review panel opens automatically when a plan is presented; this latches
  // true only when the user dismisses it (×), hiding it without discarding the plan.
  const [planClosed, setPlanClosed] = useState(false)
  const appRef = useRef<HTMLDivElement>(null)
  // True while the first message of a new chat is creating its conversation/worktree,
  // to reject a concurrent second send (see sendNow).
  const creatingConvRef = useRef(false)
  // Stable so the find bar's match-collection effect doesn't re-run (and reset to
  // match #1) on every streaming delta that re-renders App.
  // Find (⌘F) searches the transcript AND the open plan-review panel, so a query
  // matches (and scrolls to) the plan's steps the same way it does the transcript.
  const getFindRoots = useCallback((): HTMLElement[] => {
    const roots: HTMLElement[] = []
    const transcript = document.querySelector<HTMLElement>('.transcript')
    if (transcript) roots.push(transcript)
    const plan = document.querySelector<HTMLElement>('.plan-panel')
    if (plan) roots.push(plan)
    return roots
  }, [])
  const chat = useChat(currentId)

  // Dev servers the agent started (auto-detected loopback URLs) — drives the Preview dock.
  const previewServers = usePreviewServers()
  const previewableCount = useMemo(
    () => previewServers.filter((s) => s.running && s.url).length,
    [previewServers]
  )

  const refreshConversations = useCallback(async () => {
    setConversations(await window.api.listConversations())
  }, [])

  useEffect(() => {
    void (async () => {
      const s = await window.api.getSettings()
      const sel = defaultSelection(s)
      const withSel = sel && !s.selected ? { ...s, selected: sel } : s
      setSettings(withSel)
      if (sel && !s.selected) void window.api.saveSettings(withSel)
      if (s.recentWorkspaces[0]) setLastWorkspace(s.recentWorkspaces[0])
      if (typeof s.sidebarWidth === 'number') setSidebarWidth(clampSidebarWidth(s.sidebarWidth))
      if (s.sidebarCollapsed) setSidebarCollapsed(true)
      if (typeof s.terminalHeight === 'number')
        setTerminalHeight(clampTerminalHeight(s.terminalHeight))
      if (s.terminalOpen) {
        setTerminalOpen(true)
        setTerminalMounted(true)
      }
      if (typeof s.previewWidth === 'number') setPreviewWidth(clampPreviewWidth(s.previewWidth))
      if (s.previewOpen) setPreviewOpen(true)
      if (typeof s.planWidth === 'number') setPlanWidth(clampPlanWidth(s.planWidth))
      await refreshConversations()
    })()
  }, [refreshConversations])

  // Reload the conversation list when a run finishes (titles/updatedAt change).
  useEffect(() => {
    if (!chat.running) void refreshConversations()
  }, [chat.running, refreshConversations])

  // A model-generated title lands a beat after the run ends — patch it straight into
  // the list (and the header, which derives from it) rather than waiting for a refetch.
  useEffect(() => {
    return window.api.onConversationTitleChanged(({ id, title }) => {
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)))
    })
  }, [])

  // Updates: subscribe to the on-launch auto-check, and pull any one-shot
  // "What's new" staged after an upgrade-and-relaunch.
  useEffect(() => {
    const unsubAvailable = window.api.onUpdateAvailable(setUpdate)
    const unsubProgress = window.api.onUpdateDownloadProgress(setUpdateProgress)
    const unsubDownloaded = window.api.onUpdateDownloaded((d) => {
      setUpdateDownloaded(d)
      setUpdateProgress(null)
    })
    void window.api.getWhatsNew().then((wn) => {
      if (wn) setWhatsNew(wn)
    })
    return () => {
      unsubAvailable()
      unsubProgress()
      unsubDownloaded()
    }
  }, [])

  // Open the Settings modal when chosen from the native app menu (macOS ⌘,).
  useEffect(() => window.api.onOpenSettings(() => setSettingsOpen(true)), [])

  // Apply the saved color theme, following the OS while on "system".
  useApplyTheme(settings?.theme ?? 'system')

  // Conversations with a live run, used to mark them "running" in the sidebar
  // (including chats running in the background, not just the open one).
  const runningIds = useRunningConversations()

  // Refresh the conversation list whenever the running set changes so a background
  // run finishing updates its title/usage — and its `errored` flag, which the
  // tasks indicator reads to mark a finished run done vs. failed. The open chat is
  // already covered by the `chat.running` effect above; this catches the rest.
  useEffect(() => {
    void refreshConversations()
  }, [runningIds, refreshConversations])

  // Debounced full-text search across conversations (title + message content).
  useEffect(() => {
    const q = search.trim()
    if (!q) {
      setMatchIds(null)
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      void window.api.searchConversations(q).then((results) => {
        if (!cancelled) setMatchIds(new Set(results.map((r) => r.id)))
      })
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [search])

  const visibleConversations = useMemo(() => {
    // Search spans both active and archived chats, so an explicit query bypasses
    // the status filter entirely; archived hits are tagged in the sidebar.
    if (matchIds) return conversations.filter((c) => matchIds.has(c.id))
    return conversations.filter((c) => (statusFilter === 'archived' ? !!c.archived : !c.archived))
  }, [conversations, matchIds, statusFilter])

  // Counts for the sidebar's status filter, taken from the full (unfiltered) list.
  const statusCounts = useMemo(
    () => ({
      active: conversations.filter((c) => !c.archived).length,
      archived: conversations.filter((c) => !!c.archived).length
    }),
    [conversations]
  )

  const currentConv = useMemo(
    () => conversations.find((c) => c.id === currentId) ?? null,
    [conversations, currentId]
  )
  const workspace = currentConv?.workspace ?? lastWorkspace

  // Has this chat produced at least one file write that actually landed? A boolean
  // (any write), not a count, so rapid multi-file writes don't stack. `status: 'done'`
  // excludes a write that was proposed-then-denied or errored (nothing hit disk) and
  // one still in flight. Drives the first-write git-init banner.
  const writeHappened = useMemo(
    () =>
      chat.items.some(
        (it) => it.kind === 'tool' && it.toolKind === 'write' && it.status === 'done'
      ),
    [chat.items]
  )
  const onGitInitNotNow = useCallback(() => {
    if (workspace) setGitInitNotNow((s) => new Set(s).add(workspace))
  }, [workspace])
  // Session-only "Not now" for the trusted-folders consent banner (per workspace).
  const [trustNotNow, setTrustNotNow] = useState<ReadonlySet<string>>(() => new Set())
  const onTrustNotNow = useCallback(() => {
    if (workspace) setTrustNotNow((s) => new Set(s).add(workspace))
  }, [workspace])
  // Nudge the git-init banner to re-check repo state when the Changes panel closes —
  // the user may have initialized the repo from there, which no window-focus event
  // would signal.
  const [gitInitRecheck, setGitInitRecheck] = useState(0)
  const prevChangesOpen = useRef(changesOpen)
  useEffect(() => {
    if (prevChangesOpen.current && !changesOpen) setGitInitRecheck((n) => n + 1)
    prevChangesOpen.current = changesOpen
  }, [changesOpen])

  // Integrated-terminal tab state, lifted here (out of the lazy TerminalDock) so
  // the background-tasks indicator can list terminals even while the panel is
  // hidden, and clicking a terminal task can reopen + focus its tab.
  const terminals = useTerminals(workspace)

  // Background shells the agent spawned via run_shell (dev servers, watchers),
  // tracked by the main process.
  const backgroundShells = useBackgroundShells()

  // The background-tasks list shown in the title bar: running/recently-finished
  // integrated terminals + agent-backgrounded shells, so a backgrounded completion
  // is noticeable from anywhere. Chat runs are intentionally excluded — each is
  // already represented by its own Stop button and its sidebar dot (see
  // useBackgroundTasks).
  const { tasks: backgroundTasks, clearFinished: clearFinishedTasks } = useBackgroundTasks(
    terminals.tabs,
    backgroundShells
  )

  // For a not-yet-started chat, load the repo's git info and seed fresh worktree
  // defaults: a new worktree (on for a repo root, off for a picked subdirectory),
  // a suggested branch name, and the current branch as the base. Re-runs when the
  // folder changes.
  useEffect(() => {
    if (currentId !== null || !workspace) {
      setRepoInfo(null)
      return
    }
    let cancelled = false
    void window.api.getRepoInfo(workspace).then((info) => {
      if (cancelled) return
      const plan = planNewChatWorkspace(info, workspace)
      // The default workspace points at a folder that no longer exists (e.g. a
      // torn-down worktree left in the recents). Drop it rather than anchoring a new
      // chat to a phantom repo — clearing it falls back to the folder picker.
      if (plan.action === 'drop') {
        setRepoInfo(null)
        setLastWorkspace(null)
        return
      }
      // A workspace that IS a linked worktree's root (a "New chat" opened from a
      // worktree-backed chat inherits that chat's checkout) re-anchors to the
      // repo's MAIN worktree — otherwise the base picker would default to (and
      // offer to fork from) that chat's branch instead of the repo's mainline.
      // Re-point at the canonical root and let this effect re-run. A picked
      // subdirectory of the repo is honored as-is (with the worktree toggle
      // defaulting off, so sending doesn't re-root the chat either).
      if (plan.action === 'reanchor') {
        setLastWorkspace(plan.root)
        return
      }
      setRepoInfo(info)
      setWorktreeMode(plan.worktreeDefault)
      setBranchName(suggestBranch())
      setBaseBranch(info.currentBranch ?? '')
    })
    return () => {
      cancelled = true
    }
  }, [currentId, workspace])

  // Whether the first message of this new chat will spin up a worktree.
  const creatingWorktree = currentId === null && worktreeMode && repoInfo?.isRepo === true

  // Start a turn immediately with the given text/images, creating a conversation
  // first if this is the very first message — in a fresh worktree when set up.
  const sendNow = useCallback(
    async (text: string, images?: ImageAttachment[]) => {
      if (!settings?.selected || !workspace) return
      let convId = currentId
      if (!convId) {
        // Creating the conversation (and, in worktree mode, `git worktree add`) can
        // take a beat, during which the composer is still enabled and `currentId`
        // is still null. Guard re-entry so a second Enter can't spawn a duplicate
        // conversation / branch instead of appending to the first.
        if (creatingConvRef.current) return
        creatingConvRef.current = true
        let conv: Awaited<ReturnType<typeof window.api.createConversation>>
        try {
          conv = await window.api.createConversation({
            workspace,
            providerId: settings.selected.providerId,
            model: settings.selected.model,
            ...(creatingWorktree
              ? { worktree: { branch: branchName.trim(), ...(baseBranch ? { base: baseBranch } : {}) } }
              : {})
          })
        } catch (e) {
          // Worktree/branch creation failed (e.g. a branch appeared since we last
          // checked) — surface it and keep the user on the new-chat screen.
          chat.notify(`Couldn't start the chat: ${(e as Error).message}`, 'error')
          return
        } finally {
          creatingConvRef.current = false
        }
        convId = conv.id
        setCurrentId(conv.id)
      }
      await chat.send({
        conversationId: convId,
        userText: text,
        images,
        providerId: settings.selected.providerId,
        model: settings.selected.model,
        approvalPolicy: settings.approvalPolicy
      })
      void refreshConversations()
    },
    [settings, workspace, currentId, creatingWorktree, branchName, baseBranch, chat, refreshConversations]
  )

  // Messages typed while a run is active are buffered (in the main process, keyed
  // by conversation) and sent combined as the next turn when the run finishes —
  // surviving navigation to other chats. This is the open conversation's view.
  const queue = useInputQueue(currentId)

  // Uncommitted-change counts for the titlebar Changes badge (refreshes on run
  // completion / window focus).
  const workingTreeStats = useWorkingTreeStats(workspace, chat.running)

  // Load the workspace's custom slash commands (alongside the built-ins).
  useEffect(() => {
    if (!workspace) {
      setCommands(BUILTIN_COMMANDS)
      return
    }
    let cancelled = false
    void window.api.listCommands(workspace).then((custom) => {
      if (!cancelled) setCommands(mergeCommands(BUILTIN_COMMANDS, custom))
    })
    return () => {
      cancelled = true
    }
  }, [workspace])

  const selectConversation = useCallback(
    async (id: string) => {
      // Fetch the persisted conversation and any live run for it together, so the
      // reset + adopt below happen back-to-back in one render (no flicker where the
      // composer shows Send for a conversation whose run is still going).
      const [conv, activeRunId, pendingPrompts, liveTranscript, checkpoint] = await Promise.all([
        window.api.getConversation(id),
        window.api.getActiveRun(id),
        window.api.getPendingPrompts(id),
        window.api.getLiveTranscript(id),
        window.api.getCheckpoint(id)
      ])
      if (!conv) return
      setCurrentId(id)
      setLastWorkspace(conv.workspace)
      // Restore a persisted failure: re-show the error notice in the transcript and
      // flag `errored` so the "last turn failed / Retry" banner returns after reload.
      const items = itemsFromMessages(conv.messages)
      // A spawned chat opens with a "handoff from …" banner above its seeded first
      // message, so it reads as handed off rather than typed by the user.
      if (conv.spawnedFrom) {
        items.unshift({
          kind: 'notice',
          id: `handoff-${id}`,
          text: `Handoff from “${conv.spawnedFrom.title}”`,
          tone: 'handoff'
        })
      }
      if (conv.lastError) {
        items.push({ kind: 'notice', id: `lasterror-${id}`, text: conv.lastError.message, tone: 'error' })
      }
      chat.reset(
        items,
        conv.usage
          ? {
              context: conv.usage.inputTokens,
              output: conv.usage.outputTokens,
              cost: conv.usage.cost ?? 0
            }
          : null,
        Boolean(conv.lastError)
      )
      // A run for this conversation is still in flight in the main process —
      // re-adopt it so the composer shows Stop and events/approvals reconnect.
      // Replaying liveTranscript restores the in-flight turn's streamed output that
      // isn't on disk yet (otherwise it vanishes on switch-back, most visibly on a
      // freshly spawned session); pendingPrompts re-renders any approval/question
      // still awaiting the user, so a run parked on a prompt isn't left wedged.
      if (activeRunId) chat.adopt(activeRunId, pendingPrompts, liveTranscript)
      // Restore the revert/redo affordance for the conversation's latest turn — the
      // checkpoint state is built only from live events and lost on a reset/rebuild.
      chat.seedCheckpoint(checkpoint)
    },
    [chat]
  )

  // Enter the "new chat" screen for a workspace WITHOUT creating a conversation
  // yet. The chat — and its worktree, when the control-bar toggle is on — is
  // created lazily on the first message (see sendNow), so the worktree controls
  // are picked first. New worktree is the default for git repos.
  const enterNewChat = useCallback(
    (ws: string) => {
      setLastWorkspace(ws)
      setCurrentId(null)
      chat.reset([])
    },
    [chat]
  )

  const onNewChat = useCallback(async () => {
    const ws = workspace ?? (await window.api.pickWorkspace())
    if (ws) enterNewChat(ws)
  }, [workspace, enterNewChat])

  const onChangeWorkspace = useCallback(async () => {
    const ws = await window.api.pickWorkspace()
    if (ws) enterNewChat(ws)
  }, [enterNewChat])

  const onDeleteConversation = useCallback(
    async (id: string) => {
      // The native confirmation (and the worktree choice) lives in the main process;
      // it returns deleted:false when the user cancels, so we touch nothing then.
      const res = await window.api.deleteConversation(id)
      if (!res.deleted) return
      saveComposerDraft(id, '') // drop the deleted conversation's lingering draft
      if (res.worktree?.message) alert(res.worktree.message)
      if (id === currentId) {
        setCurrentId(null)
        chat.reset([])
      }
      await refreshConversations()
    },
    [currentId, chat, refreshConversations]
  )

  const onForkConversation = useCallback(
    async (id: string) => {
      const fork = await window.api.forkConversation(id)
      if (!fork) return
      await refreshConversations()
      await selectConversation(fork.id)
    },
    [refreshConversations, selectConversation]
  )

  const onExportConversation = useCallback(async (id: string) => {
    try {
      await window.api.exportConversation(id)
    } catch (e) {
      alert(`Could not export conversation: ${(e as Error).message}`)
    }
  }, [])

  const onExportConversationHtml = useCallback(async (id: string) => {
    try {
      await window.api.exportConversationHtml(id)
    } catch (e) {
      alert(`Could not export conversation: ${(e as Error).message}`)
    }
  }, [])

  const onImportConversation = useCallback(async () => {
    try {
      const meta = await window.api.importConversation()
      if (!meta) return
      await refreshConversations()
      await selectConversation(meta.id)
    } catch (e) {
      alert(`Could not import conversation: ${(e as Error).message}`)
    }
  }, [refreshConversations, selectConversation])

  // ---- Chat organization (rename / pin / move) ----

  const onRenameConversation = useCallback(
    async (id: string, title: string) => {
      await window.api.organizeConversation(id, { title })
      await refreshConversations()
    },
    [refreshConversations]
  )

  const onSetPinned = useCallback(
    async (id: string, pinned: boolean) => {
      await window.api.organizeConversation(id, { pinned })
      await refreshConversations()
    },
    [refreshConversations]
  )

  const onSetArchived = useCallback(
    async (id: string, archived: boolean) => {
      await window.api.organizeConversation(id, { archived })
      await refreshConversations()
    },
    [refreshConversations]
  )

  const onMoveConversation = useCallback(
    async (id: string, groupId: string | null) => {
      await window.api.organizeConversation(id, { groupId })
      await refreshConversations()
    },
    [refreshConversations]
  )

  const onReorderConversations = useCallback(
    async (orderedIds: string[], move?: { id: string; groupId: string | null }) => {
      await window.api.reorderConversations(orderedIds, move)
      await refreshConversations()
    },
    [refreshConversations]
  )

  // Record acceptance of the current legal terms, dismissing the first-run gate.
  const onAcceptLegal = useCallback(async () => {
    const fresh = await window.api.saveSettings({
      ...(await window.api.getSettings()),
      legalAcceptedVersion: LEGAL_VERSION
    })
    setSettings(fresh)
  }, [])

  // ---- Custom groups (persisted in settings) ----

  const saveGroups = useCallback(async (next: ChatGroup[]) => {
    const fresh = await window.api.saveSettings({
      ...(await window.api.getSettings()),
      chatGroups: next
    })
    setSettings(fresh)
  }, [])

  const onCreateGroup = useCallback(async (): Promise<string> => {
    const id = newGroupId()
    const current = await window.api.getSettings()
    await saveGroups([...(current.chatGroups ?? []), { id, name: 'New group' }])
    return id
  }, [saveGroups])

  const onRenameGroup = useCallback(
    async (groupId: string, name: string) => {
      const current = await window.api.getSettings()
      await saveGroups((current.chatGroups ?? []).map((g) => (g.id === groupId ? { ...g, name } : g)))
    },
    [saveGroups]
  )

  const onToggleGroupCollapsed = useCallback(
    async (groupId: string) => {
      const current = await window.api.getSettings()
      await saveGroups(
        (current.chatGroups ?? []).map((g) =>
          g.id === groupId ? { ...g, collapsed: !g.collapsed } : g
        )
      )
    },
    [saveGroups]
  )

  // Collapse a built-in section (Pinned / Ungrouped) — not a custom group, so its
  // state lives in settings.collapsedSections keyed by section id.
  const onToggleSectionCollapsed = useCallback(async (sectionId: string) => {
    const current = await window.api.getSettings()
    const prev = current.collapsedSections ?? {}
    const fresh = await window.api.saveSettings({
      ...current,
      collapsedSections: { ...prev, [sectionId]: !prev[sectionId] }
    })
    setSettings(fresh)
  }, [])

  const onDeleteGroup = useCallback(
    async (groupId: string) => {
      // Return member chats to "Ungrouped" before dropping the group.
      const members = conversations.filter((c) => c.groupId === groupId)
      await Promise.all(members.map((c) => window.api.organizeConversation(c.id, { groupId: null })))
      const current = await window.api.getSettings()
      await saveGroups((current.chatGroups ?? []).filter((g) => g.id !== groupId))
      await refreshConversations()
    },
    [conversations, saveGroups, refreshConversations]
  )

  const onSelectModel = useCallback(async (sel: SelectedModel) => {
    setSettings((s) => (s ? { ...s, selected: sel } : s))
    const fresh = await window.api.saveSettings({
      ...(await window.api.getSettings()),
      selected: sel
    })
    setSettings(fresh)
  }, [])

  const onChangePolicy = useCallback(
    async (policy: ApprovalPolicy) => {
      // Push the change into an in-flight run so it takes effect on the agent's
      // next tool call, not just the next turn. Persisting it (below) makes it the
      // default for future runs. No-op if nothing is running.
      chat.setPolicy(policy)
      const fresh = await window.api.saveSettings({
        ...(await window.api.getSettings()),
        approvalPolicy: policy
      })
      setSettings(fresh)
    },
    [chat]
  )

  const onChangeReasoning = useCallback(async (reasoningEffort: ReasoningEffort) => {
    const fresh = await window.api.saveSettings({
      ...(await window.api.getSettings()),
      reasoningEffort
    })
    setSettings(fresh)
  }, [])

  // ---- Sidebar sizing (resizable + collapsible, persisted) ----

  const persistSidebar = useCallback(
    async (patch: Pick<Partial<AppSettings>, 'sidebarWidth' | 'sidebarCollapsed'>) => {
      const fresh = await window.api.saveSettings({ ...(await window.api.getSettings()), ...patch })
      setSettings(fresh)
    },
    []
  )

  // Commit a (clamped) width to state + settings — used at drag end, on a keyboard
  // nudge, and for double-click-to-reset.
  const commitSidebarWidth = useCallback(
    (px: number) => {
      const w = clampSidebarWidth(px)
      setSidebarWidth(w)
      void persistSidebar({ sidebarWidth: w })
    },
    [persistSidebar]
  )

  const setSidebarCollapsedPersisted = useCallback(
    (collapsed: boolean) => {
      setSidebarCollapsed(collapsed)
      void persistSidebar({ sidebarCollapsed: collapsed })
    },
    [persistSidebar]
  )

  const toggleSidebar = useCallback(
    () => setSidebarCollapsedPersisted(!sidebarCollapsed),
    [sidebarCollapsed, setSidebarCollapsedPersisted]
  )

  // Drag the divider: update the grid column live by writing the CSS variable
  // straight to the DOM (so the long chat list doesn't re-render each mousemove),
  // then commit to state/settings on release. Releasing past the collapse
  // threshold hides the sidebar instead of pinning it at the minimum width.
  const onResizerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const left = appRef.current?.getBoundingClientRect().left ?? 0
      document.body.classList.add('is-resizing')
      const onMove = (ev: MouseEvent): void => {
        appRef.current?.style.setProperty('--sidebar-w', `${clampSidebarWidth(ev.clientX - left)}px`)
      }
      const onUp = (ev: MouseEvent): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.classList.remove('is-resizing')
        const raw = ev.clientX - left
        if (raw < SIDEBAR_COLLAPSE_AT) setSidebarCollapsedPersisted(true)
        else commitSidebarWidth(raw)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [commitSidebarWidth, setSidebarCollapsedPersisted]
  )

  const onResizerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        commitSidebarWidth(sidebarWidth - SIDEBAR_NUDGE_STEP)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        commitSidebarWidth(sidebarWidth + SIDEBAR_NUDGE_STEP)
      }
    },
    [commitSidebarWidth, sidebarWidth]
  )

  // ---- Integrated terminal (toggle + resizable height, persisted) ----

  const persistTerminal = useCallback(
    async (patch: Pick<Partial<AppSettings>, 'terminalHeight' | 'terminalOpen'>) => {
      const fresh = await window.api.saveSettings({ ...(await window.api.getSettings()), ...patch })
      setSettings(fresh)
    },
    []
  )

  const toggleTerminal = useCallback(() => {
    setTerminalOpen((open) => {
      const next = !open
      if (next) setTerminalMounted(true)
      void persistTerminal({ terminalOpen: next })
      return next
    })
  }, [persistTerminal])

  // Open a background task from the title-bar indicator: surface + focus its
  // terminal tab (mounting/showing the dock), or switch to the conversation it
  // belongs to — its own for a chat, the spawning run for a background shell.
  const openBackgroundTask = useCallback(
    (task: BackgroundTask) => {
      if (task.kind === 'terminal') {
        setTerminalMounted(true)
        setTerminalOpen(true)
        void persistTerminal({ terminalOpen: true })
        terminals.setActive(task.id)
        return
      }
      // A backgrounded shell: reopen the conversation that spawned it.
      if (task.conversationId) void selectConversation(task.conversationId)
    },
    [terminals, persistTerminal, selectConversation]
  )

  // Drag the panel's top edge: update the height CSS variable live (no re-render of
  // the transcript while dragging), then commit to state/settings on release.
  // Dragging up grows the panel, so height increases as the cursor's Y decreases.
  const onTerminalResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startY = e.clientY
      const startH = terminalHeight
      document.body.classList.add('is-resizing')
      const onMove = (ev: MouseEvent): void => {
        const h = clampTerminalHeight(startH + (startY - ev.clientY))
        appRef.current?.style.setProperty('--terminal-h', `${h}px`)
      }
      const onUp = (ev: MouseEvent): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.classList.remove('is-resizing')
        const h = clampTerminalHeight(startH + (startY - ev.clientY))
        setTerminalHeight(h)
        void persistTerminal({ terminalHeight: h })
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [terminalHeight, persistTerminal]
  )

  // ---- Preview dock (toggle + resizable width, persisted) ----

  const persistPreview = useCallback(
    async (patch: Pick<Partial<AppSettings>, 'previewWidth' | 'previewOpen'>) => {
      const fresh = await window.api.saveSettings({ ...(await window.api.getSettings()), ...patch })
      setSettings(fresh)
    },
    []
  )

  const togglePreview = useCallback(() => {
    setPreviewOpen((open) => {
      const next = !open
      void persistPreview({ previewOpen: next })
      return next
    })
  }, [persistPreview])

  // Drag the panel's left edge: update the width CSS variable live (no re-render of
  // the transcript while dragging), then commit on release. Dragging left grows the
  // panel, so width increases as the cursor's X decreases.
  const onPreviewResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = previewWidth
      document.body.classList.add('is-resizing')
      const onMove = (ev: MouseEvent): void => {
        const w = clampPreviewWidth(startW + (startX - ev.clientX))
        appRef.current?.style.setProperty('--preview-w', `${w}px`)
      }
      const onUp = (ev: MouseEvent): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.classList.remove('is-resizing')
        const w = clampPreviewWidth(startW + (startX - ev.clientX))
        setPreviewWidth(w)
        void persistPreview({ previewWidth: w })
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [previewWidth, persistPreview]
  )

  // ---- Plan-review panel (Plan mode: docked, resizable width, persisted) ----

  const pendingPlan = chat.pendingPlan
  // The panel shows whenever a plan is pending unless the user has dismissed it.
  const planPanelOpen = pendingPlan !== null && !planClosed

  // A newly presented plan (or a revision) re-opens the panel even if the previous
  // one was dismissed. Keyed on the callId so re-opening is per-plan.
  const pendingPlanCallId = pendingPlan?.callId
  useEffect(() => {
    if (pendingPlanCallId) setPlanClosed(false)
  }, [pendingPlanCallId])

  const persistPlan = useCallback(
    async (patch: Pick<Partial<AppSettings>, 'planWidth'>) => {
      const fresh = await window.api.saveSettings({ ...(await window.api.getSettings()), ...patch })
      setSettings(fresh)
    },
    []
  )

  // Drag the panel's left edge (mirrors the preview dock): update the width CSS
  // variable live, then commit on release. Dragging left grows the panel.
  const onPlanResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = planWidth
      document.body.classList.add('is-resizing')
      const onMove = (ev: MouseEvent): void => {
        const w = clampPlanWidth(startW + (startX - ev.clientX))
        appRef.current?.style.setProperty('--plan-w', `${w}px`)
      }
      const onUp = (ev: MouseEvent): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.classList.remove('is-resizing')
        const w = clampPlanWidth(startW + (startX - ev.clientX))
        setPlanWidth(w)
        void persistPlan({ planWidth: w })
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [planWidth, persistPlan]
  )

  // Re-open a dismissed plan panel from its transcript marker (pending plans only).
  const onOpenPlan = useCallback(
    (callId: string) => {
      if (pendingPlan && pendingPlan.callId === callId) setPlanClosed(false)
    },
    [pendingPlan]
  )

  const onResolvePlan = useCallback(
    (callId: string, decision: PlanDecision) => {
      // Accepting leaves Plan mode: switch the (persisted, displayed) policy to the
      // chosen edit mode so the dropdown agrees and later turns aren't read-only. The
      // loop also flips the live run's policy as it resolves the decision.
      if (decision.kind === 'accept') void onChangePolicy(decision.mode)
      chat.resolvePlan(callId, decision)
    },
    [chat, onChangePolicy]
  )

  const onRevert = useCallback(async () => {
    const n = await chat.revertCheckpoint()
    if (n > 0) alert(`Reverted ${n} file change${n === 1 ? '' : 's'} from the last turn.`)
  }, [chat])

  const onRetry = useCallback(() => {
    if (!settings?.selected || !currentId) return
    void chat.retry({
      conversationId: currentId,
      providerId: settings.selected.providerId,
      model: settings.selected.model,
      approvalPolicy: settings.approvalPolicy
    })
  }, [chat, settings, currentId])

  const onReapply = useCallback(async () => {
    const n = await chat.reapplyCheckpoint()
    if (n > 0) alert(`Re-applied ${n} file change${n === 1 ? '' : 's'} from the last turn.`)
  }, [chat])

  const onSend = useCallback(
    (text: string, images?: ImageAttachment[]) => {
      // Defer messages typed mid-run; main combines and sends them when it ends.
      if (chat.running && settings?.selected) {
        queue.enqueue({
          text,
          images,
          providerId: settings.selected.providerId,
          model: settings.selected.model,
          approvalPolicy: settings.approvalPolicy
        })
      } else void sendNow(text, images)
    },
    [chat.running, settings, queue, sendNow]
  )

  // Steer the running turn: inject the text into the live run before its next step,
  // rather than queuing it for after. If the run finished between typing and the
  // click, fall back to queuing so nothing the user typed is dropped.
  const onSteer = useCallback(
    (text: string) => {
      void chat.steer(text).then((accepted) => {
        if (!accepted && settings?.selected) {
          queue.enqueue({
            text,
            providerId: settings.selected.providerId,
            model: settings.selected.model,
            approvalPolicy: settings.approvalPolicy
          })
        }
      })
    },
    [chat, settings, queue]
  )

  // Hand off PR creation to the agent: close the panel and send the standing
  // prompt as a normal turn, so the commit/push/open-PR flow runs through the
  // agent's tools and approval gate rather than the renderer touching git.
  const onCreatePr = useCallback(() => {
    setChangesOpen(false)
    void onSend(CREATE_PR_PROMPT)
  }, [onSend])

  const onCompact = useCallback(async () => {
    if (!currentId || !settings?.selected) return
    chat.notify('Compacting conversation…')
    const res = await window.api.compactConversation(
      currentId,
      settings.selected.providerId,
      settings.selected.model
    )
    if (res.ok && res.messages) {
      chat.reset(itemsFromMessages(res.messages))
      chat.notify(`Compacted ${res.summarized} earlier messages.`)
    } else if (res.ok) {
      chat.notify(
        res.reason === 'single-turn'
          ? "This conversation is a single turn — there are no earlier turns to summarize. Start a new chat to free up context."
          : 'Nothing to compact yet.'
      )
    } else {
      chat.notify(`Couldn't compact: ${res.error ?? 'unknown error'}`)
    }
  }, [currentId, settings, chat])

  // Read-only listing for /skills and /agents: fetch the workspace's capabilities
  // and surface their names in a notice (mirrors how /help lists command names).
  const onListCapability = useCallback(
    async (kind: 'skills' | 'agents') => {
      if (!workspace) {
        chat.notify(`Open a folder first to list ${kind}.`)
        return
      }
      const list =
        kind === 'skills'
          ? await window.api.listSkills(workspace)
          : await window.api.listAgents(workspace)
      const label = kind === 'skills' ? 'Skills' : 'Agents'
      if (!list.length) {
        chat.notify(`No ${kind} found in .houston/${kind}.`)
        return
      }
      chat.notify(`${label} (${list.length}): ${list.map((c) => c.name).join(', ')}`)
    },
    [workspace, chat]
  )

  const onCommand = useCallback(
    (cmd: Command, args: string) => {
      // Only built-in action commands reach here; custom (template) commands are
      // expanded into the composer by the Composer itself.
      if (cmd.name === 'new' || cmd.name === 'clear') void onNewChat()
      else if (cmd.name === 'compact') void onCompact()
      else if (cmd.name === 'skills') void onListCapability('skills')
      else if (cmd.name === 'agents') void onListCapability('agents')
      else if (cmd.name === 'agent') {
        // Dispatch one of the workspace's own agents. Phrased as an instruction to
        // dispatch (not a second path into subagents), so the agent's prompt, tools,
        // model and approval tier stay identical to when the model picks it itself.
        const inv = parseAgentInvocation(args)
        if (inv) void onSend(agentInvocationPrompt(inv.name, inv.task))
        else chat.notify('Usage: /agent <name> <task> — the name matches a file in .houston/agents', 'error')
      } else if (cmd.name === 'doctor') setDoctorOpen(true)
      else if (cmd.name === 'help') {
        chat.notify(
          'Commands: ' + BUILTIN_COMMANDS.map((c) => `/${c.name}`).join('  ') +
            (commands.length > BUILTIN_COMMANDS.length ? '  (+ custom from .houston/commands)' : '')
        )
      } else if (POLICY_COMMANDS[cmd.name]) {
        const policy = POLICY_COMMANDS[cmd.name]
        void onChangePolicy(policy)
        chat.notify(`Approval mode: ${policy}`)
      }
    },
    [onNewChat, onCompact, onListCapability, onChangePolicy, onSend, chat, commands]
  )

  // ---- Keyboard shortcuts, command palette, mode cycling ----

  const mac = useMemo(() => isMacPlatform(), [])

  // The effective shortcut registry: built-in defaults with the user's overrides
  // applied. Drives global matching, the help overlay, and palette key hints.
  const shortcuts = useMemo(() => resolveShortcuts(settings?.keybindings), [settings?.keybindings])

  // Keyboard chat-switching (⌘1–9, ⌃Tab / ⌃⇧Tab) over the currently visible list.
  const jumpToChat = useCallback(
    (index: number) => {
      const id = chatAtIndex(visibleConversations, index)
      if (id && id !== currentId) void selectConversation(id)
    },
    [visibleConversations, currentId, selectConversation]
  )

  const cycleChat = useCallback(
    (dir: 1 | -1) => {
      const id = cycleChatId(visibleConversations, currentId, dir)
      if (id && id !== currentId) void selectConversation(id)
    },
    [visibleConversations, currentId, selectConversation]
  )

  // Shift+Tab steps to the next approval mode and confirms it in the transcript
  // (the ControlBar's mode selector also reflects the change).
  const cyclePolicy = useCallback(() => {
    if (!settings) return
    const next = nextApprovalPolicy(settings.approvalPolicy)
    void onChangePolicy(next)
    chat.notify(`Approval mode: ${POLICY_LABEL[next]}`)
    // chat.notify is stable (useCallback in useChat); depend on it explicitly rather
    // than the whole `chat`, which changes identity every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, onChangePolicy, chat.notify])

  // The command palette's flat, searchable item list: app actions, approval modes,
  // the available models, and every chat as a switch target.
  const paletteItems = useMemo<PaletteItem[]>(() => {
    const base = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p
    const items: PaletteItem[] = []
    items.push(
      {
        id: 'act-new-chat',
        title: 'New chat',
        section: 'Actions',
        hint: shortcutHint('new-chat', mac, shortcuts),
        keywords: 'create start',
        run: () => void onNewChat()
      },
      {
        id: 'act-toggle-sidebar',
        title: sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar',
        section: 'Actions',
        hint: shortcutHint('toggle-sidebar', mac, shortcuts),
        run: toggleSidebar
      },
      {
        id: 'act-toggle-terminal',
        title: 'Toggle the integrated terminal',
        section: 'Actions',
        hint: shortcutHint('toggle-terminal', mac, shortcuts),
        keywords: 'shell console',
        run: toggleTerminal
      },
      {
        id: 'act-toggle-preview',
        title: previewOpen ? 'Hide preview panel' : 'Show preview panel',
        section: 'Actions',
        keywords: 'browser localhost dev server web',
        run: togglePreview
      },
      {
        id: 'act-change-folder',
        title: 'Open a different project folder',
        section: 'Actions',
        keywords: 'workspace directory cwd',
        run: () => void onChangeWorkspace()
      },
      {
        id: 'act-import',
        title: 'Import chat from file',
        section: 'Actions',
        run: () => void onImportConversation()
      },
      {
        id: 'act-find',
        title: 'Find in conversation',
        section: 'Actions',
        hint: shortcutHint('find-in-chat', mac, shortcuts),
        keywords: 'search',
        run: () => setFindOpen(true)
      },
      {
        id: 'act-scorecard',
        title: 'Show loop scorecard',
        section: 'Actions',
        // No "model(s)" keyword: ⇧⌘M seeds the palette with "model", and this
        // action shouldn't outrank the actual model list for that query.
        keywords: 'stats cost tokens usage metrics loop tools',
        run: () => setScorecardOpen(true)
      },
      {
        id: 'act-help',
        title: 'Keyboard shortcuts',
        section: 'Actions',
        hint: shortcutHint('show-help', mac, shortcuts),
        run: () => setHelpOpen(true)
      },
      {
        id: 'act-settings',
        title: 'Open settings',
        section: 'Actions',
        hint: shortcutHint('open-settings', mac, shortcuts),
        run: () => setSettingsOpen(true)
      }
    )
    if (workspace) {
      items.push({
        id: 'act-files',
        title: 'Browse project files',
        section: 'Actions',
        keywords: 'finder explorer tree folder directory',
        run: () => setFilesOpen(true)
      })
      items.push({
        id: 'act-changes',
        title: 'Show working-tree changes',
        section: 'Actions',
        keywords: 'diff git pr',
        run: () => setChangesOpen(true)
      })
    }
    if (currentId) {
      items.push({
        id: 'act-compact',
        title: 'Compact conversation',
        section: 'Actions',
        keywords: 'summarize context',
        run: () => void onCompact()
      })
    }
    for (const p of APPROVAL_POLICIES) {
      items.push({
        id: `mode-${p}`,
        title: POLICY_LABEL[p],
        section: 'Approval mode',
        keywords: `policy ${p}`,
        hint: settings?.approvalPolicy === p ? '✓ current' : undefined,
        run: () => void onChangePolicy(p)
      })
    }
    for (const prov of settings?.providers ?? []) {
      for (const m of prov.models) {
        const current =
          settings?.selected?.providerId === prov.id && settings?.selected?.model === m.id
        items.push({
          id: `model-${prov.id}-${m.id}`,
          title: `Use ${m.label ?? m.id}`,
          subtitle: prov.label,
          section: 'Model',
          keywords: `${m.id} ${prov.id}`,
          hint: current ? '✓ current' : undefined,
          run: () => void onSelectModel({ providerId: prov.id, model: m.id })
        })
      }
    }
    for (const c of conversations) {
      if (c.id === currentId) continue
      items.push({
        id: `chat-${c.id}`,
        title: c.title || 'Untitled chat',
        subtitle: base(c.workspace),
        section: 'Switch chat',
        run: () => void selectConversation(c.id)
      })
    }
    return items
  }, [
    mac,
    shortcuts,
    workspace,
    currentId,
    sidebarCollapsed,
    previewOpen,
    settings?.approvalPolicy,
    settings?.providers,
    settings?.selected,
    conversations,
    onNewChat,
    toggleSidebar,
    toggleTerminal,
    togglePreview,
    onChangeWorkspace,
    onImportConversation,
    onCompact,
    onChangePolicy,
    onSelectModel,
    selectConversation
  ])

  // Global keyboard shortcuts (see lib/shortcuts.ts for the registry): ⌘N new chat,
  // ⌘K palette, ⌘1–9 / ⌃Tab switch chats, Shift+Tab cycle mode, ⌘F find, ⌘⇧M model,
  // ⌘/ or ? help, ⌃` terminal, Esc to stop a run / close a dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // A handler nearer the event's target already consumed this key (e.g. a menu
      // or dialog closed on its own Escape) — don't also read it as a global
      // shortcut, or the same Escape would additionally cancel the running turn.
      if (e.defaultPrevented) return
      // Plain-character shortcuts (e.g. `?`) must not fire while typing in a field;
      // mod-bearing chords (⌘…) still work everywhere, and Esc is always allowed.
      const inEditable = isEditableTarget(e.target)
      if (inEditable && !(e.metaKey || e.ctrlKey) && e.key !== 'Escape') return
      const action = matchShortcut(e, shortcuts)
      // Keys typed inside the terminal mostly belong to the shell (Esc → vim, Ctrl+C
      // → SIGINT, etc.). The terminal toggle and ⌘-chords (macOS app shortcuts the
      // shell never sees) still reach the app; everything else passes through.
      const inTerminal =
        e.target instanceof HTMLElement && e.target.closest('.terminal-dock') !== null
      if (inTerminal && terminalKeepsKey(action, e.metaKey)) return
      if (action === 'new-chat') {
        e.preventDefault()
        void onNewChat()
      } else if (action === 'command-palette') {
        e.preventDefault()
        setPaletteSeed('')
        setPaletteOpen((v) => !v)
      } else if (action === 'switch-model') {
        e.preventDefault()
        setPaletteSeed('model')
        setPaletteOpen(true)
      } else if (action === 'find-in-chat') {
        e.preventDefault()
        setFindOpen(true)
      } else if (action === 'open-settings') {
        e.preventDefault()
        setSettingsOpen(true)
      } else if (action === 'toggle-sidebar') {
        e.preventDefault()
        toggleSidebar()
      } else if (action === 'toggle-terminal') {
        e.preventDefault()
        toggleTerminal()
      } else if (action === 'show-help') {
        e.preventDefault()
        setHelpOpen((v) => !v)
      } else if (action === 'select-chat-n') {
        e.preventDefault()
        jumpToChat(Number(e.key) - 1)
      } else if (action === 'next-chat') {
        e.preventDefault()
        cycleChat(1)
      } else if (action === 'prev-chat') {
        e.preventDefault()
        cycleChat(-1)
      } else if (action === 'cycle-mode') {
        // Shift+Tab is reverse-focus in dialogs — let their focus trap (or the find
        // bar) have it; only hijack it for mode-cycling in the main chat view. An
        // open popover menu (model picker, ⋯ menu) is portaled to <body>, invisible
        // to these flags, so consult its registry too.
        if (
          paletteOpen ||
          helpOpen ||
          settingsOpen ||
          changesOpen ||
          filesOpen ||
          scorecardOpen ||
          findOpen ||
          isAnyPopoverOpen()
        )
          return
        e.preventDefault()
        cyclePolicy()
      } else if (action === 'escape') {
        // The open overlays own their own Esc (focus trap), so this mainly handles
        // Esc with nothing focused — still ordered most-recent-first defensively.
        if (paletteOpen) setPaletteOpen(false)
        else if (helpOpen) setHelpOpen(false)
        else if (findOpen) setFindOpen(false)
        else if (settingsOpen) setSettingsOpen(false)
        else if (changesOpen) setChangesOpen(false)
        else if (filesOpen) setFilesOpen(false)
        else if (scorecardOpen) setScorecardOpen(false)
        else if (chat.running) chat.cancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // chat.cancel is stable (useCallback); depending on the whole `chat` object
    // would re-subscribe every render. The fields we read are listed explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    onNewChat,
    toggleSidebar,
    toggleTerminal,
    jumpToChat,
    cycleChat,
    cyclePolicy,
    shortcuts,
    paletteOpen,
    helpOpen,
    findOpen,
    settingsOpen,
    changesOpen,
    filesOpen,
    scorecardOpen,
    chat.running,
    chat.cancel
  ])

  if (!settings) {
    return <div className="loading">Loading…</div>
  }

  // First-run / updated-terms gate: block all use of the app until the user
  // accepts the current legal terms. Renders alone (nothing else mounts) so the
  // disclaimers can't be bypassed. A non-zero stored version means they accepted
  // earlier terms and are being re-prompted after a bump (vs. a fresh first run).
  if (needsLegalAcceptance(settings.legalAcceptedVersion)) {
    return (
      <LegalGate onAccept={onAcceptLegal} isUpdate={(settings.legalAcceptedVersion ?? 0) > 0} />
    )
  }

  // The composer is usable only when the *selected* provider is actually ready —
  // it doesn't require a key, or it has a usable one. Otherwise sending would fail
  // in the agent loop with "No API key set"; instead we disable input and the
  // ControlBar shows its "⚠︎ Set API key" prompt.
  const selectedProvider = settings.providers.find((p) => p.id === settings.selected?.providerId)
  const selectionReady = Boolean(
    selectedProvider && (!selectedProvider.requiresKey || selectedProvider.hasKey)
  )
  // Block sending while a worktree is being set up with an invalid/taken branch,
  // so the failure is caught before the message is consumed.
  const worktreeBlocked =
    creatingWorktree && branchNameError(branchName, repoInfo?.branches ?? []) !== null
  const canChat = Boolean(settings.selected && workspace && selectionReady && !worktreeBlocked)
  // The specific reason the composer is disabled, so its placeholder names the real
  // blocker instead of always saying "pick a model and folder".
  const disabledReason = !workspace
    ? 'Choose a project folder to start…'
    : !settings.selected
      ? 'Pick a model to start…'
      : !selectionReady
        ? 'Set an API key for this model in Settings…'
        : worktreeBlocked
          ? 'Enter a valid worktree branch name to start…'
          : undefined
  // Only offer the image-attachment affordance when the selected model can see
  // images. Resolve host-reported capabilities first (same source the model picker
  // uses) so a host-listed vision model isn't denied the attach buttons by the
  // name-only heuristic — and vice-versa.
  const selectedModelOption = selectedProvider?.models.find((m) => m.id === settings.selected?.model)
  const visionSupported = settings.selected
    ? resolveCapabilities(settings.selected.model, selectedModelOption?.caps).vision
    : true

  return (
    <div
      className="app"
      ref={appRef}
      style={
        {
          '--sidebar-w': `${sidebarCollapsed ? SIDEBAR_RAIL_WIDTH : sidebarWidth}px`,
          '--terminal-h': `${terminalHeight}px`,
          '--preview-w': `${previewOpen ? previewWidth : 0}px`,
          '--plan-w': `${planPanelOpen ? planWidth : 0}px`
        } as CSSProperties
      }
    >
      <Sidebar
        conversations={visibleConversations}
        groups={search ? [] : settings.chatGroups ?? []}
        search={search}
        onSearch={setSearch}
        currentId={currentId}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebar}
        runningIds={runningIds}
        onSelect={selectConversation}
        onNew={onNewChat}
        onDelete={onDeleteConversation}
        onFork={onForkConversation}
        onExport={onExportConversation}
        onExportHtml={onExportConversationHtml}
        onImport={onImportConversation}
        onOpenSettings={() => setSettingsOpen(true)}
        onRename={onRenameConversation}
        onSetPinned={onSetPinned}
        onSetArchived={onSetArchived}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        statusCounts={statusCounts}
        onMove={onMoveConversation}
        onReorder={onReorderConversations}
        onCreateGroup={onCreateGroup}
        onRenameGroup={onRenameGroup}
        onDeleteGroup={onDeleteGroup}
        onToggleGroupCollapsed={onToggleGroupCollapsed}
        collapsedSections={settings.collapsedSections ?? {}}
        onToggleSectionCollapsed={onToggleSectionCollapsed}
      />

      {!sidebarCollapsed && (
        <div
          className="sidebar__resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={sidebarWidth}
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          tabIndex={0}
          onMouseDown={onResizerMouseDown}
          onKeyDown={onResizerKeyDown}
          onDoubleClick={() => commitSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
        />
      )}

      <div className="main">
        <Titlebar
          title={currentConv?.title ?? 'Houston'}
          tasks={backgroundTasks}
          onSelectTask={openBackgroundTask}
          onClearFinishedTasks={clearFinishedTasks}
          changes={workspace ? workingTreeStats : undefined}
          onShowFiles={workspace ? () => setFilesOpen(true) : undefined}
          onShowChanges={workspace ? () => setChangesOpen(true) : undefined}
          onTogglePreview={togglePreview}
          previewOpen={previewOpen}
          previewCount={previewableCount}
          onToggleTerminal={toggleTerminal}
          terminalOpen={terminalOpen}
        />

        <UpdateBanner
          update={update}
          progress={updateProgress}
          downloaded={updateDownloaded}
          onInstall={() => void window.api.installUpdate()}
          onDismiss={() => {
            setUpdate(null)
            setUpdateProgress(null)
            setUpdateDownloaded(null)
          }}
        />

        {findOpen && (
          <Suspense fallback={null}>
            <FindBar getRoots={getFindRoots} onClose={() => setFindOpen(false)} />
          </Suspense>
        )}

        {chat.items.length === 0 ? (
          <div className="welcome">
            <h1>Houston</h1>
            <p>A coding agent. Bring your own model.</p>
            {!workspace && <p className="welcome__hint">Choose a project folder to begin.</p>}
            {workspace && !settings.selected && (
              <p className="welcome__hint">Pick a model (set an API key in Settings first).</p>
            )}
          </div>
        ) : (
          <Transcript
            items={chat.items}
            onApprove={chat.approve}
            onAnswer={chat.answerQuestion}
            onElicit={chat.answerElicitation}
            onOpenPlan={onOpenPlan}
          />
        )}

        <TrustFolderBanner
          // Re-evaluate cleanly per workspace: a new folder gets its own banner state.
          key={`trust-${workspace ?? 'none'}`}
          workspace={workspace}
          running={chat.running}
          sessionDismissed={workspace ? trustNotNow.has(workspace) : false}
          onNotNow={onTrustNotNow}
          onDecided={setSettings}
        />

        <GitInitBanner
          // Re-evaluate cleanly per workspace: a new folder gets its own banner state.
          key={workspace ?? 'none'}
          workspace={workspace}
          writeHappened={writeHappened}
          running={chat.running}
          sessionDismissed={workspace ? gitInitNotNow.has(workspace) : false}
          onNotNow={onGitInitNotNow}
          onDismissed={setSettings}
          recheckSignal={gitInitRecheck}
        />

        {chat.errored && !chat.running && currentId && (
          <div className="checkpoint-bar">
            <span className="checkpoint-bar__label">The last turn failed.</span>
            <button className="btn btn--sm" onClick={onRetry}>
              ⟳ Retry
            </button>
          </div>
        )}

        {chat.checkpoint && !chat.running && (
          <div className="checkpoint-bar">
            <span className="checkpoint-bar__label">
              {chat.checkpoint.reverted ? '↩︎ Reverted' : '✎'} {chat.checkpoint.files} file change
              {chat.checkpoint.files === 1 ? '' : 's'} this turn
            </span>
            {chat.checkpoint.reverted ? (
              <button className="btn btn--sm" onClick={onReapply}>
                ↷ Redo
              </button>
            ) : (
              <button className="btn btn--sm" onClick={onRevert}>
                ↶ Revert
              </button>
            )}
          </div>
        )}

        {queue.queued.length > 0 && (
          <div className="queue-bar">
            <span className="queue-bar__label">
              {queue.queued.length} queued ·{' '}
              {chat.running ? 'sent when this run finishes' : 'the run stopped — send them now or clear'}
            </span>
            <ul className="queue-bar__items">
              {queue.queued.map((q) => {
                const label =
                  q.text.trim() ||
                  (q.imageCount ? `🖼 ${q.imageCount} image${q.imageCount === 1 ? '' : 's'}` : '')
                return (
                  <li key={q.id} className="queue-chip" title={label}>
                    <span className="queue-chip__text">{label}</span>
                    <button
                      className="queue-chip__remove"
                      title="Remove from queue"
                      aria-label="Remove from queue"
                      onClick={() => queue.remove(q.id)}
                    >
                      ✕
                    </button>
                  </li>
                )
              })}
            </ul>
            {!chat.running && (
              <button className="btn btn--sm btn--accent" onClick={queue.flush}>
                Send now
              </button>
            )}
            <button className="btn btn--sm" onClick={queue.clear}>
              Clear
            </button>
          </div>
        )}

        {terminalMounted && (
          <Suspense fallback={null}>
            <TerminalDock
              controller={terminals}
              visible={terminalOpen}
              onResizeMouseDown={onTerminalResizeMouseDown}
              onClose={toggleTerminal}
            />
          </Suspense>
        )}

        <div className="dock">
          <ControlBar
            settings={settings}
            selected={settings.selected}
            workspace={workspace}
            usage={chat.usage}
            newChat={currentId === null}
            repoInfo={repoInfo}
            worktreeMode={worktreeMode}
            branchName={branchName}
            baseBranch={baseBranch}
            currentWorktree={currentConv?.worktree}
            onToggleWorktree={setWorktreeMode}
            onChangeBranchName={setBranchName}
            onChangeBaseBranch={setBaseBranch}
            onSelectModel={onSelectModel}
            onChangePolicy={onChangePolicy}
            onChangeReasoning={onChangeReasoning}
            onChangeWorkspace={onChangeWorkspace}
            onOpenSettings={() => setSettingsOpen(true)}
          />
          <Composer
            // Remount per conversation so each chat shows its own draft (and a
            // fresh attachment/menu state), in isolation from the others.
            key={currentId ?? 'new'}
            conversationId={currentId}
            disabled={!canChat}
            disabledReason={disabledReason}
            running={chat.running}
            workspace={workspace}
            commands={commands}
            vision={visionSupported}
            lastUserMessage={lastUserText(chat.items)}
            changes={workspace ? workingTreeStats : undefined}
            onShowChanges={() => setChangesOpen(true)}
            onCreatePr={canChat ? onCreatePr : undefined}
            onCommand={onCommand}
            onSend={onSend}
            onSteer={onSteer}
            onCancel={chat.cancel}
          />
        </div>

        <footer className="statusbar">
          <span className={`statusbar__dot${chat.running ? ' statusbar__dot--busy' : ''}`} />
          <span className="statusbar__state">{statusText(chat.items, chat.running)}</span>
          {settings.selected && <span className="statusbar__model">{settings.selected.model}</span>}
        </footer>
      </div>

      {previewOpen && (
        <Suspense fallback={null}>
          <PreviewDock
            servers={previewServers}
            // A full-screen overlay paints above the native preview views; hide them
            // (but keep them alive) while one is open so a preview can't cover it.
            occluded={settingsOpen || changesOpen || paletteOpen || helpOpen || !!whatsNew}
            onResizeMouseDown={onPreviewResizeMouseDown}
            onClose={togglePreview}
          />
        </Suspense>
      )}

      {planPanelOpen && pendingPlan && (
        <PlanPanel
          plan={pendingPlan.plan}
          revising={pendingPlan.revising === true}
          onResolve={(decision) => onResolvePlan(pendingPlan.callId, decision)}
          onClose={() => setPlanClosed(true)}
          onResizeMouseDown={onPlanResizeMouseDown}
        />
      )}

      <Suspense fallback={null}>
        {settingsOpen && (
          <SettingsModal
            initial={settings}
            onClose={() => setSettingsOpen(false)}
            onSaved={(s) => setSettings(s)}
            onShowScorecard={() => {
              setSettingsOpen(false)
              setScorecardOpen(true)
            }}
          />
        )}

        {doctorOpen && <DoctorModal workspace={workspace} onClose={() => setDoctorOpen(false)} />}

        {filesOpen && <FilesPanel workspace={workspace} onClose={() => setFilesOpen(false)} />}

        {scorecardOpen && <Scorecard onClose={() => setScorecardOpen(false)} />}

        {changesOpen && (
          <DiffPanel
            workspace={workspace}
            onClose={() => setChangesOpen(false)}
            onCreatePr={canChat ? onCreatePr : undefined}
            creating={chat.running}
          />
        )}

        {whatsNew && <WhatsNewModal info={whatsNew} onClose={() => setWhatsNew(null)} />}

        {helpOpen && <ShortcutsHelp shortcuts={shortcuts} onClose={() => setHelpOpen(false)} />}

        {paletteOpen && (
          <CommandPalette
            items={paletteItems}
            initialQuery={paletteSeed}
            onClose={() => setPaletteOpen(false)}
          />
        )}
      </Suspense>
    </div>
  )
}
