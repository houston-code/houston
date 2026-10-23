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
import { subagentSpend } from '@shared/subagents'
import { APPROVAL_POLICIES } from '@shared/types'
import type { AppSettings, ApprovalPolicy, ChatGroup, SelectedModel } from '@shared/types'
import type {
  ConversationMeta,
  PlanDecision,
  ProposalState,
  ReasoningEffort,
  RepoInfo
} from '@shared/agent'
import { mergeCommands, builtinCommands, type Command } from '@shared/commands'
import type { ImageAttachment } from '@shared/images'
import {
  agentTurn,
  proposalHereTurn,
  shipTurn,
  sideChatExchangeText,
  sideChatTurn,
  type InvokedTurn,
  type PromptInvocation
} from '@shared/promptInvocation'
import { formatTokens, formatUsd, resolveCapabilities, sessionUsageFromConversation } from '@shared/usage'
import { modelDisplayName, pickDefaultModel } from '@shared/models'
import { DEFAULT_REASONING_EFFORT } from '@shared/defaults'
import {
  branchNameError,
  canCreateWorktree,
  defaultBaseBranch,
  planNewChatWorkspace,
  suggestBranch
} from './lib/worktree'
import { useApplyTheme } from './hooks/useApplyTheme'
import { useChatStatus } from './hooks/useChatStatus'
import { useWindowFocused } from './hooks/useWindowFocused'
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
import { checkpointNotice } from './lib/checkpointNotice'
import { occludesPreview, ownsShiftTab, suppressesTips, type OverlayFlags } from './lib/overlays'
import { baseName } from './lib/paths'
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
import { ownedByChat } from './lib/chatScope'
import { useChat } from './hooks/useChat'
import { useInputQueue } from './hooks/useInputQueue'
import { queueBarLabel } from './lib/queueBar'
import { deliverMidRunMessage } from './lib/midRunMessage'
import { useWorkingTreeStats } from './hooks/useWorkingTreeStats'
import type { ShipAction } from '@shared/shipAction'
import { saveComposerDraft } from './lib/composerDraft'
import {
  endsWithRecordedError,
  itemsFromMessages,
  lastUserText,
  rewindTargets,
  showsHandoff,
  type RewindItemTarget
} from './lib/items'
import { Sidebar, type ConversationStatusFilter } from './components/Sidebar'
import { Titlebar } from './components/Titlebar'
import { activeTaskCount } from './components/BackgroundTasks'
import { TasksPanel } from './components/TasksPanel'
import type { DockTab } from './components/PreviewDock'
import { ControlBar, POLICY_LABEL } from './components/ControlBar'
import { chatSettingsFor, defaultChatSettings, differsFromDefaults, withChatSettings, type ChatSettings } from './lib/chatSettings'
import { Transcript, type RewindHandlers } from './components/Transcript'
import { RewindDialog } from './components/RewindDialog'
import { RewindPicker } from './components/RewindPicker'
import { rewindDoneText, rewindsConversation, type RewindMode, type RewindOutcome } from '@shared/rewind'
import { PlanPanel } from './components/PlanPanel'
import { SideChatPanel } from './components/SideChatPanel'
import type { ProposalHandlers } from './components/ProposalCard'
import { Composer } from './components/Composer'
import { GitInitBanner } from './components/GitInitBanner'
import { GlobalRulesNotice } from './components/GlobalRulesNotice'
import { saveMemoryAndNotify } from './lib/memorySave'
import { TrustFolderBanner } from './components/TrustFolderBanner'
import { UpdateBanner } from './components/UpdateBanner'
import { useUpdateBanner } from './hooks/useUpdateBanner'
import { GetStarted } from './components/GetStarted'
import { ConnectModel, providerShortName } from './components/ConnectModel'
import { TipHost } from './components/TipHost'
import { ImageViewer } from './components/ImageViewer'
import { ImageViewerContext, workspaceRelativePath, type ImageViewerApi, type ViewerImage } from './lib/imageViewer'
import { VisualsContext } from './lib/visuals'
import { useOnboarding } from './hooks/useOnboarding'
import {
  markTipsSeen,
  checklistVisible,
  firstTaskExample,
  folderKind,
  PRE_SEND_TIP_DELAY_MS,
  relevantTips,
  type FolderKind,
  type ChecklistFacts
} from '@shared/onboarding'
import { isAnyPopoverOpen } from './components/Popover'
import { Icon } from './components/Icon'
import { desktopCommandAction, type DesktopCommandAction, type SettingsSection } from './lib/desktopCommands'
import type { WhatsNew } from '@shared/update'

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

/** Pick a sensible default model: first provider that has a key and a model. */
function defaultSelection(settings: AppSettings): SelectedModel | null {
  if (settings.selected) return settings.selected
  const ready = settings.providers.find((p) => (!p.requiresKey || p.hasKey) && p.models.length > 0)
  if (ready) return { providerId: ready.id, model: pickDefaultModel(ready) ?? ready.models[0].id }
  return null
}

export default function App(): JSX.Element {
  // The saved settings. Their model, reasoning effort and approval policy are only the
  // defaults new chats start from: an open chat keeps its own (chatSettings), and
  // `settings` below is what the open chat sees. Save from savedSettings or a fresh
  // getSettings(), never from `settings`, or one chat's values become the defaults.
  const [savedSettings, setSettings] = useState<AppSettings | null>(null)
  const [conversations, setConversations] = useState<ConversationMeta[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [chatSettings, setChatSettings] = useState<ChatSettings | null>(null)
  const settings = useMemo(
    () => savedSettings && withChatSettings(savedSettings, currentId ? chatSettings : null),
    [savedSettings, chatSettings, currentId]
  )
  const savedSettingsRef = useRef(savedSettings)
  savedSettingsRef.current = savedSettings
  const [lastWorkspace, setLastWorkspace] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // The section Settings opens on: a command like /theme lands on its own section.
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('models')
  // A settings search to open on (`/settings <words>`).
  const [settingsQuery, setSettingsQuery] = useState('')
  const [doctorOpen, setDoctorOpen] = useState(false)
  const [changesOpen, setChangesOpen] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  // A file for the Files panel to reveal when it opens (the image viewer's "Show in Files").
  const [filesTarget, setFilesTarget] = useState<string | undefined>(undefined)
  const [sideChatOpen, setSideChatOpen] = useState(false)
  // The open chat's decisions on its propose_session cards (keyed by call id).
  const [proposalStates, setProposalStates] = useState<Record<string, ProposalState>>({})
  const [scorecardOpen, setScorecardOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  // Rewind (see components/RewindDialog): the Esc Esc picker, the confirmation for a
  // chosen message, an edit-and-resend in progress, the text to put in the composer,
  // and whether the open chat's last rewind can still be undone.
  const [rewindPickerOpen, setRewindPickerOpen] = useState(false)
  const [rewindConfirm, setRewindConfirm] = useState<{ target: RewindItemTarget; mode: RewindMode } | null>(
    null
  )
  const [editing, setEditing] = useState<{ target: RewindItemTarget; mode: 'both' | 'conversation' } | null>(
    null
  )
  // Tagged with its chat: the Composer remounts per chat and applies a prefill on
  // mount, so one meant for another chat must never reach it.
  const [composerPrefill, setComposerPrefill] = useState<
    { text: string; images?: ImageAttachment[]; seq: number; conversationId: string | null } | undefined
  >()
  const [canUndoRewind, setCanUndoRewind] = useState(false)
  // The full-size image viewer (a show_images gallery or a tool-card screenshot).
  const [viewer, setViewer] = useState<{ images: ViewerImage[]; index: number } | null>(null)
  // Inline visuals in replies: running interactive HTML is the user's opt-in.
  const visualsSettings = useMemo(() => ({ html: settings?.htmlVisuals === true }), [settings?.htmlVisuals])
  const imageViewerApi = useMemo<ImageViewerApi>(
    () => ({ open: (images, index) => setViewer(images.length ? { images, index } : null) }),
    []
  )
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteSeed, setPaletteSeed] = useState('')
  const [findOpen, setFindOpen] = useState(false)
  // Each ask for find (⌘F, the palette) while the bar is already open re-focuses it.
  const [findRequest, setFindRequest] = useState(0)
  const openFind = useCallback(() => {
    setFindOpen(true)
    setFindRequest((n) => n + 1)
  }, [])
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
  const updateBanner = useUpdateBanner()
  const [whatsNew, setWhatsNew] = useState<WhatsNew | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  // Latches true on first open and stays mounted thereafter (hidden via CSS when
  // closed) so terminal sessions and scrollback survive hide/show.
  const [terminalMounted, setTerminalMounted] = useState(false)
  const [terminalHeight, setTerminalHeight] = useState(TERMINAL_DEFAULT_HEIGHT)
  const [previewOpen, setPreviewOpen] = useState(false)
  // Which tab the right-hand dock shows: the live Preview or the Tasks list. Not
  // persisted: the dock reopens on Preview, as it always has.
  const [dockTab, setDockTab] = useState<DockTab>('preview')
  // The background shell whose page "Open preview" asked for, so the Preview tab
  // shows it even when more servers are running than it has panes for. Each request is a
  // fresh object so asking again for the same server reopens a pane the user closed.
  const [previewFocus, setPreviewFocus] = useState<{ id: string } | null>(null)
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
  // What each subagent in this chat spent, for the cost breakdown.
  const subagentSpendRows = useMemo(
    () => subagentSpend(chat.items.flatMap((it) => (it.kind === 'tool' && it.records ? it.records : []))),
    [chat.items]
  )

  // Dev servers the agent started (auto-detected loopback URLs) — drives the Preview dock.
  // Only the open chat's: another chat's servers stay out of its Preview and Tasks.
  const allPreviewServers = usePreviewServers()
  const previewServers = useMemo(
    () => ownedByChat(allPreviewServers, currentId),
    [allPreviewServers, currentId]
  )
  const previewableCount = useMemo(
    () => previewServers.filter((s) => s.running && s.url).length,
    [previewServers]
  )

  const [conversationsLoaded, setConversationsLoaded] = useState(false)
  const refreshConversations = useCallback(async () => {
    setConversations(await window.api.listConversations())
    setConversationsLoaded(true)
  }, [])
  // The get-started checklist's inline "Connect a model" panel.
  const [connectOpen, setConnectOpen] = useState(false)
  // Backing out of the Connect panel returns focus to step 1's button, which the
  // panel replaced; see GetStarted's focusModelStep.
  const [connectBackedOut, setConnectBackedOut] = useState(false)
  // One-shot: GetStarted reads it in its mount effect, which runs before this one,
  // so clear it after so a later remount of the checklist doesn't take focus.
  useEffect(() => {
    if (connectBackedOut) setConnectBackedOut(false)
  }, [connectBackedOut])
  const onboarding = useOnboarding({
    settings,
    setSettings,
    conversationsLoaded,
    hasConversation: conversations.length > 0
  })
  const { startTour } = onboarding

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

  // A run that failed because its provider doesn't serve the model has flagged that model
  // in settings; re-read just the provider lists so the picker shows the flag right away.
  useEffect(() => {
    return window.api.onAgentEvent((e) => {
      if (e.type !== 'error' || !e.modelUnavailable) return
      void window.api.getSettings().then((fresh) => {
        setSettings((s) => (s ? { ...s, providers: fresh.providers } : s))
      })
    })
  }, [])

  // A model-generated title lands a few seconds into the first run — patch it straight into
  // the list (and the header, which derives from it) rather than waiting for a refetch.
  useEffect(() => {
    return window.api.onConversationTitleChanged(({ id, title }) => {
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)))
    })
  }, [])

  // Pull any one-shot "What's new" staged after an upgrade-and-relaunch.
  useEffect(() => {
    void window.api.getWhatsNew().then((wn) => {
      if (wn) setWhatsNew(wn)
    })
  }, [])

  // Open the Settings modal when chosen from the native app menu (macOS ⌘,).
  useEffect(() => window.api.onOpenSettings(() => setSettingsOpen(true)), [])

  // Apply the saved color theme, following the OS while on "system".
  useApplyTheme(settings?.theme ?? 'system')

  // Live status of every conversation with a run (running, blocking prompts), used
  // to mark chats in the sidebar, including ones running in the background.
  const chatStatus = useChatStatus()
  // Read when a chat opens: its unread anchor must be taken before the open marks it read.
  const chatStatusRef = useRef(chatStatus)
  chatStatusRef.current = chatStatus
  // Where the open chat's unseen output starts (the "New" divider), set on open.
  const [newFrom, setNewFrom] = useState<{ conversationId: string; itemId: string } | null>(null)
  // A short confirmation with an Undo (marking a chat unread leaves it).
  const [undoToast, setUndoToast] = useState<{ text: string; undo: () => void } | null>(null)
  useEffect(() => {
    if (!undoToast) return
    const t = setTimeout(() => setUndoToast(null), 6000)
    return () => clearTimeout(t)
  }, [undoToast])
  // The running set only changes when a run starts or ends, not when a prompt comes
  // or goes, so key it by its members: the refresh below must not fire per prompt.
  const runningKey = Object.keys(chatStatus)
    .filter((id) => chatStatus[id].running)
    .sort()
    .join('\n')
  const runningIds = useMemo<ReadonlySet<string>>(
    () => new Set(runningKey ? runningKey.split('\n') : []),
    [runningKey]
  )

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
  // Whether the open folder is empty, so the setup checklist's step 3 can suggest a
  // first task that fits it (build something vs. explain the project).
  const [workspaceKind, setWorkspaceKind] = useState<FolderKind>('unknown')
  useEffect(() => {
    let alive = true
    if (!workspace) {
      setWorkspaceKind('unknown')
      return
    }
    window.api
      .listWorkspaceDir(workspace, '')
      .then((entries) => alive && setWorkspaceKind(folderKind(entries)))
      .catch(() => alive && setWorkspaceKind('unknown'))
    return () => {
      alive = false
    }
  }, [workspace])

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
  const allBackgroundShells = useBackgroundShells()
  const backgroundShells = useMemo(
    () => ownedByChat(allBackgroundShells, currentId),
    [allBackgroundShells, currentId]
  )

  // The background-tasks list shown in the title bar: running/recently-finished
  // integrated terminals + the open chat's agent-backgrounded shells (another chat's
  // shells show when that chat is open). Chat runs are intentionally excluded — each is
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
      setBaseBranch(defaultBaseBranch(info))
    })
    return () => {
      cancelled = true
    }
  }, [currentId, workspace])

  // Whether the first message of this new chat will spin up a worktree.
  const creatingWorktree =
    currentId === null && worktreeMode && repoInfo !== null && canCreateWorktree(repoInfo)

  // Start a turn immediately with the given text/images, creating a conversation
  // first if this is the very first message — in a fresh worktree when set up.
  const sendNow = useCallback(
    async (text: string, images?: ImageAttachment[], invokedAs?: PromptInvocation) => {
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
            reasoningEffort: settings.reasoningEffort,
            approvalPolicy: settings.approvalPolicy,
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
        // The new chat keeps the defaults it started with as its own settings.
        setChatSettings({
          selected: settings.selected,
          reasoningEffort: settings.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
          approvalPolicy: settings.approvalPolicy
        })
        setCurrentId(conv.id)
      }
      await chat.send({
        conversationId: convId,
        userText: text,
        images,
        ...(invokedAs ? { invokedAs } : {}),
        providerId: settings.selected.providerId,
        model: settings.selected.model,
        approvalPolicy: settings.approvalPolicy,
        reasoningEffort: settings.reasoningEffort
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
      const unreadAnchor = chatStatusRef.current[id]?.unread?.anchor
      const saved = savedSettingsRef.current
      const own = saved ? chatSettingsFor(conv, saved) : null
      setChatSettings(own?.settings ?? null)
      setCurrentId(id)
      setLastWorkspace(conv.workspace)
      setProposalStates(conv.proposals ?? {})
      // Restore a persisted failure: re-show the error notice in the transcript and
      // flag `errored` so the "last turn failed / Retry" banner returns after reload.
      // A spawned chat shows a "handoff from …" banner above its seeded hand-off
      // message, so it reads as handed off rather than typed by the user. A forked
      // child's log starts with the parent's copied history, so the banner goes
      // after that, right above the hand-off itself.
      const forked = conv.spawnedFrom?.historyLength ?? 0
      const items = conv.spawnedFrom && showsHandoff(forked, conv.messages.length)
        ? [
            ...itemsFromMessages(conv.messages.slice(0, forked)),
            {
              kind: 'notice' as const,
              id: `handoff-${id}`,
              text: `Handoff from “${conv.spawnedFrom.title}”`,
              tone: 'handoff' as const,
              openConversationId: conv.spawnedFrom.conversationId
            },
            ...itemsFromMessages(conv.messages.slice(forked), forked)
          ]
        : itemsFromMessages(conv.messages)
      // Land on what's new: the first reply at or after the unread anchor.
      const firstNew =
        unreadAnchor === undefined
          ? undefined
          : items.find(
              (it) => it.kind === 'assistant' && it.messageIndex !== undefined && it.messageIndex >= unreadAnchor
            )
      setNewFrom(firstNew ? { conversationId: id, itemId: firstNew.id } : null)
      if (conv.lastError && !endsWithRecordedError(conv.messages, conv.lastError.message)) {
        items.push({ kind: 'notice', id: `lasterror-${id}`, text: conv.lastError.message, tone: 'error' })
      }
      chat.reset(
        items,
        // Map through the shared helper so the persisted per-model breakdown and
        // cache split survive a reopen too — not just context/output/cost.
        conv.usage ? sessionUsageFromConversation(conv.usage) : null,
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
      // The chat's model is gone from settings: say which one it uses now.
      if (own?.modelChanged) {
        chat.notify(
          own.settings.selected
            ? `This chat's model (${conv.model}) is no longer set up, so it now uses ${own.settings.selected.model}.`
            : `This chat's model (${conv.model}) is no longer set up. Pick a model to continue.`,
          'info'
        )
      }
    },
    [chat]
  )

  // A chat opened before the saved settings had loaded has no settings of its own in
  // view yet; fill them in from its list entry once both are here, so it never runs
  // on the defaults by accident.
  useEffect(() => {
    if (!currentId || chatSettings || !savedSettings) return
    const meta = conversations.find((c) => c.id === currentId)
    if (meta) setChatSettings(chatSettingsFor(meta, savedSettings).settings)
  }, [currentId, chatSettings, savedSettings, conversations])

  // Enter the "new chat" screen for a workspace WITHOUT creating a conversation
  // yet. The chat — and its worktree, when the control-bar toggle is on — is
  // created lazily on the first message (see sendNow), so the worktree controls
  // are picked first. New worktree is the default for git repos.
  const enterNewChat = useCallback(
    (ws: string) => {
      setLastWorkspace(ws)
      setCurrentId(null)
      setChatSettings(null)
      setProposalStates({})
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
      const res = await window.api.importConversation()
      if (!res) return
      await refreshConversations()
      await selectConversation(res.meta.id)
      if (res.textOnly) {
        alert(
          'This HTML file came from an older version of Houston, so only the chat text was imported. Tool calls and their results were left out.'
        )
      }
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

  // Tell main which chat this window shows and whether it has focus: a focused view
  // marks the chat read, and a turn that finishes out of view leaves it unread.
  const windowFocused = useWindowFocused()
  useEffect(() => {
    window.api.setChatViewing?.(currentId, windowFocused)
  }, [currentId, windowFocused])

  // Mark a chat unread (or read), optionally from one of its replies. Marking the open
  // chat unread also leaves it, as a mail client moves on: staying would mark it read
  // again straight away. An Undo toast takes it back and reopens the chat.
  const onSetUnread = useCallback(
    (id: string, unread: boolean, fromReply?: number) => {
      void window.api.setChatUnread(id, unread, fromReply)
      if (unread && id === currentId) {
        const meta = conversations.find((c) => c.id === id)
        const ws = meta?.workspace ?? workspace
        if (ws) enterNewChat(ws)
        else setCurrentId(null)
        setUndoToast({
          text:
            fromReply === undefined
              ? `Marked “${meta?.title ?? 'chat'}” unread.`
              : `Marked “${meta?.title ?? 'chat'}” unread from that reply.`,
          undo: () => {
            void window.api.setChatUnread(id, false)
            void selectConversation(id)
          }
        })
      }
    },
    [currentId, conversations, workspace, enterNewChat, selectConversation]
  )
  const onMarkAllRead = useCallback(() => void window.api.markAllChatsRead(), [])

  // A clicked desktop notification opens the chat it was about.
  useEffect(
    () => window.api.onChatOpenRequest?.((id) => void selectConversation(id)),
    [selectConversation]
  )

  // Other chats waiting on the user, in sidebar recency order, for the titlebar's
  // "N need you" pill; each click opens the next one after the open chat.
  const waitingIds = useMemo(
    () =>
      conversations
        .filter((c) => c.id !== currentId && (chatStatus[c.id]?.pending.length ?? 0) > 0)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((c) => c.id),
    [conversations, chatStatus, currentId]
  )
  const openNextWaiting = useCallback(() => {
    const next = waitingIds[0]
    if (next) void selectConversation(next)
  }, [waitingIds, selectConversation])
  const onToggleUnreadFirst = useCallback(async () => {
    const current = await window.api.getSettings()
    const fresh = await window.api.saveSettings({
      ...current,
      sidebarUnreadFirst: !current.sidebarUnreadFirst
    })
    setSettings(fresh)
  }, [])

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

  // Fold a chat's spawned sessions in the sidebar. Saved in settings so it survives
  // a restart; ids of chats that no longer exist are pruned on each save.
  const onToggleParentCollapsed = useCallback(async (id: string) => {
    const current = await window.api.getSettings()
    const live = new Set((await window.api.listConversations()).map((c) => c.id))
    const prev = (current.collapsedSpawnParents ?? []).filter((p) => live.has(p))
    const next = prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    const fresh = await window.api.saveSettings({ ...current, collapsedSpawnParents: next })
    setSettings(fresh)
  }, [])
  const collapsedParents = useMemo(() => {
    // settings.json is user-editable: anything but a list of ids means "none folded".
    const raw: unknown = settings?.collapsedSpawnParents
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [])
  }, [settings?.collapsedSpawnParents])

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

  // Change the open chat's own settings: shown at once, saved to that chat only (the
  // defaults stay as they are). Without an open chat, the change goes to the defaults.
  const changeChatSettings = useCallback(
    (patch: Partial<ChatSettings>): boolean => {
      if (!currentId) return false
      setChatSettings((cs) => {
        const base = cs ?? (savedSettingsRef.current ? defaultChatSettings(savedSettingsRef.current) : null)
        return base ? { ...base, ...patch } : cs
      })
      void window.api.setConversationSettings(currentId, {
        ...(patch.selected ? { providerId: patch.selected.providerId, model: patch.selected.model } : {}),
        ...(patch.reasoningEffort ? { reasoningEffort: patch.reasoningEffort } : {}),
        ...(patch.approvalPolicy ? { approvalPolicy: patch.approvalPolicy } : {})
      })
      return true
    },
    [currentId]
  )

  const onSelectModel = useCallback(
    async (sel: SelectedModel) => {
      if (changeChatSettings({ selected: sel })) return
      setSettings((s) => (s ? { ...s, selected: sel } : s))
      const fresh = await window.api.saveSettings({
        ...(await window.api.getSettings()),
        selected: sel
      })
      setSettings(fresh)
    },
    [changeChatSettings]
  )

  // The get-started "Connect a model" step succeeded: select that provider's default
  // model, so the step ticks off and the composer is ready without a trip to the picker.
  const onModelConnected = useCallback(
    async (fresh: AppSettings, providerId: string, picked?: string) => {
      setConnectOpen(false)
      const prov = fresh.providers.find((p) => p.id === providerId)
      // A model the user picked (from a reopened step 1) wins; else the provider's default.
      const model = prov
        ? prov.models.some((m) => m.id === picked)
          ? picked
          : (pickDefaultModel(prov) ?? prov.models[0]?.id)
        : undefined
      if (!model) {
        setSettings(fresh)
        return
      }
      setSettings(await window.api.saveSettings({ ...fresh, selected: { providerId, model } }))
    },
    []
  )

  const onChangePolicy = useCallback(
    async (policy: ApprovalPolicy) => {
      // Push the change into the open chat's in-flight run so it takes effect on the
      // agent's next tool call, not just the next turn. No-op if nothing is running.
      chat.setPolicy(policy)
      if (changeChatSettings({ approvalPolicy: policy })) return
      const fresh = await window.api.saveSettings({
        ...(await window.api.getSettings()),
        approvalPolicy: policy
      })
      setSettings(fresh)
    },
    [chat, changeChatSettings]
  )

  const onChangeReasoning = useCallback(
    async (reasoningEffort: ReasoningEffort) => {
      // Like the policy: the open chat's live run picks it up on its next model turn.
      chat.setEffort(reasoningEffort)
      if (changeChatSettings({ reasoningEffort })) return
      const fresh = await window.api.saveSettings({
        ...(await window.api.getSettings()),
        reasoningEffort
      })
      setSettings(fresh)
    },
    [chat, changeChatSettings]
  )

  // Make the open chat's model, reasoning effort and approval policy the defaults
  // that new chats start from. The only way a chat's settings reach the defaults.
  const onMakeChatSettingsDefault = useCallback(async () => {
    if (!chatSettings) return
    const fresh = await window.api.saveSettings({
      ...(await window.api.getSettings()),
      ...(chatSettings.selected ? { selected: chatSettings.selected } : {}),
      reasoningEffort: chatSettings.reasoningEffort,
      approvalPolicy: chatSettings.approvalPolicy
    })
    setSettings(fresh)
    chat.notify('New chats will start with these settings.', 'info')
  }, [chatSettings, chat])

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

  // A missing runtime's one-click install: run the command in a fresh terminal tab,
  // then show the dock. The tab is created first so the dock's "open an empty
  // terminal when shown with none" effect doesn't spawn a second one.
  const runInTerminal = useCallback(
    async (command: string) => {
      await terminals.addTab({ run: command, title: 'Install' })
      setTerminalMounted(true)
      setTerminalOpen(true)
      void persistTerminal({ terminalOpen: true })
    },
    [terminals, persistTerminal]
  )

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

  // The titlebar's Preview and Tasks buttons each toggle the shared right-hand dock on
  // their own tab: a click opens the dock on that tab, switches to it if the dock is
  // showing the other one, and closes the dock if it is already showing.
  const toggleDockTab = useCallback(
    (tab: DockTab) => {
      if (previewOpen && dockTab === tab) {
        setPreviewOpen(false)
        void persistPreview({ previewOpen: false })
        return
      }
      setDockTab(tab)
      if (!previewOpen) {
        setPreviewOpen(true)
        void persistPreview({ previewOpen: true })
      }
    },
    [previewOpen, dockTab, persistPreview]
  )
  const togglePreview = useCallback(() => toggleDockTab('preview'), [toggleDockTab])
  const toggleTasks = useCallback(() => toggleDockTab('tasks'), [toggleDockTab])
  const closeDock = useCallback(() => {
    setPreviewOpen(false)
    void persistPreview({ previewOpen: false })
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
  // The side chat shares the plan panel's column; a plan awaiting review takes it.
  const sideChatVisible = sideChatOpen && currentId !== null && !planPanelOpen

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

  // The bar itself flips to "Reverted … / Redo"; see checkpointNotice for what is said.
  const onRevert = useCallback(async () => {
    const expected = chat.checkpoint?.files ?? 0
    const n = await chat.revertCheckpoint()
    const notice = checkpointNotice('revert', n, expected)
    if (notice) chat.notify(notice, 'error')
  }, [chat])

  const onRetry = useCallback(() => {
    if (!settings?.selected || !currentId) return
    void chat.retry({
      conversationId: currentId,
      providerId: settings.selected.providerId,
      model: settings.selected.model,
      approvalPolicy: settings.approvalPolicy,
      reasoningEffort: settings.reasoningEffort
    })
  }, [chat, settings, currentId])

  const onReapply = useCallback(async () => {
    const expected = chat.checkpoint?.files ?? 0
    const n = await chat.reapplyCheckpoint()
    const notice = checkpointNotice('redo', n, expected)
    if (notice) chat.notify(notice, 'error')
  }, [chat])

  const dispatch = useCallback(
    (text: string, images?: ImageAttachment[], invokedAs?: PromptInvocation) => {
      // Defer messages typed mid-run; main combines and sends them when it ends.
      if (chat.running && settings?.selected) {
        queue.enqueue({
          text,
          images,
          ...(invokedAs ? { invokedAs } : {}),
          providerId: settings.selected.providerId,
          model: settings.selected.model,
          approvalPolicy: settings.approvalPolicy,
          reasoningEffort: settings.reasoningEffort
        })
      } else void sendNow(text, images, invokedAs)
    },
    [chat.running, settings, queue, sendNow]
  )

  // A message the user wrote in the composer.
  // ---- Rewind ----

  const prefillComposer = useCallback(
    (text: string, images?: ImageAttachment[]) => {
      setComposerPrefill((prev) => ({
        text,
        ...(images?.length ? { images } : {}),
        seq: (prev?.seq ?? 0) + 1,
        conversationId: currentId
      }))
    },
    [currentId]
  )

  // Rewind the open chat to just before `target`, then reload it (transcript, usage,
  // the latest turn's revert) from what main stored. Null when refused or failed;
  // the reason is shown in the transcript.
  const performRewind = useCallback(
    async (target: RewindItemTarget, mode: RewindMode): Promise<RewindOutcome | null> => {
      if (!currentId) return null
      let res
      try {
        res = await window.api.rewind(currentId, target.turn, mode, target.text)
      } catch {
        res = { ok: false as const, error: "Couldn't rewind this conversation." }
      }
      if (!res.ok) {
        chat.notify(res.error, 'error')
        return null
      }
      await selectConversation(currentId)
      chat.notify(rewindDoneText(mode, res), res.conflicts.length > 0 ? 'error' : 'info')
      setCanUndoRewind(res.undoable)
      return res
    },
    [currentId, chat, selectConversation]
  )

  const onConfirmRewind = useCallback(
    async (mode: RewindMode) => {
      const pending = rewindConfirm
      setRewindConfirm(null)
      if (!pending) return
      const done = await performRewind(pending.target, mode)
      // The message left the chat: put it back in the composer to send again or change.
      if (done && rewindsConversation(mode)) prefillComposer(done.text)
    },
    [rewindConfirm, performRewind, prefillComposer]
  )

  const onEditMessage = useCallback(
    (target: RewindItemTarget) => {
      setRewindConfirm(null)
      setRewindPickerOpen(false)
      setEditing({ target, mode: 'both' })
      prefillComposer(target.text, target.images)
    },
    [prefillComposer]
  )

  const onUndoRewind = useCallback(async () => {
    if (!currentId) return
    const res = await window.api.undoRewind(currentId)
    setCanUndoRewind(false)
    if (!res.ok) {
      chat.notify(res.error, 'error')
      return
    }
    await selectConversation(currentId)
    const left = res.conflicts.length
      ? ` Left ${res.conflicts.length} file${res.conflicts.length === 1 ? '' : 's'} that changed since: ${res.conflicts.slice(0, 5).join(', ')}.`
      : ''
    chat.notify(
      `Undid the rewind${res.reapplied ? ` and put back ${res.reapplied} file${res.reapplied === 1 ? '' : 's'}` : ''}.${left}`,
      left ? 'error' : 'info'
    )
  }, [currentId, chat, selectConversation])

  const rewindHandlers = useMemo<RewindHandlers | undefined>(
    () =>
      currentId
        ? {
            disabled: chat.running,
            onRewind: (target, mode) => setRewindConfirm({ target, mode }),
            onEdit: onEditMessage
          }
        : undefined,
    [currentId, chat.running, onEditMessage]
  )

  // A different chat: whatever rewind UI was up belongs to the old one.
  useEffect(() => {
    setEditing(null)
    setRewindConfirm(null)
    setRewindPickerOpen(false)
    setCanUndoRewind(false)
    setComposerPrefill(undefined)
    if (!currentId) return
    let live = true
    void window.api
      .canUndoRewind(currentId)
      .then((ok) => live && setCanUndoRewind(ok))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [currentId])

  // A new turn moves the chat on from a rewind: main drops the undo then too.
  useEffect(() => {
    if (chat.running) setCanUndoRewind(false)
  }, [chat.running])

  // Edit and resend: a message sent while editing first rewinds to the edited one.
  // If the rewind is refused, the text goes back in the field and nothing is sent.
  const sendAfterEdit = useCallback(
    async (text: string, images: ImageAttachment[] | undefined, send: () => void) => {
      const pending = editing
      if (!pending) return send()
      setEditing(null)
      const done = await performRewind(pending.target, pending.mode)
      if (!done) {
        prefillComposer(text, images)
        return
      }
      send()
    },
    [editing, performRewind, prefillComposer]
  )

  const onSend = useCallback(
    (text: string, images?: ImageAttachment[]) =>
      void sendAfterEdit(text, images, () => dispatch(text, images)),
    [dispatch, sendAfterEdit]
  )

  // A prompt Houston wrote on the user's behalf (see @shared/promptInvocation): the
  // transcript shows what they did, not the instructions it expanded to.
  const onInvoke = useCallback(
    (turn: InvokedTurn) =>
      void sendAfterEdit(turn.invokedAs.typed ?? turn.text, undefined, () =>
        dispatch(turn.text, undefined, turn.invokedAs)
      ),
    [dispatch, sendAfterEdit]
  )

  // Save a `#`-captured standing instruction to the workspace's (or every project's)
  // rules file — the files Houston already loads each run — and say where it landed.
  const onSaveMemory = useCallback(
    (scope: 'project' | 'global', text: string) => {
      void saveMemoryAndNotify(window.api.saveMemory, chat.notify, workspace ?? '', scope, text)
    },
    [workspace, chat]
  )

  // The open conversation, readable from an async continuation that must not act on
  // a chat the user has since navigated away from.
  const currentIdRef = useRef(currentId)
  currentIdRef.current = currentId

  // The agent's open `ask_user` question, if it is waiting on one. While it is, the
  // run can't read a steer (it is blocked on the answer), so Enter answers it instead.
  const openQuestion = useMemo(() => {
    if (!chat.running) return null
    for (let i = chat.items.length - 1; i >= 0; i--) {
      const it = chat.items[i]
      if (it.kind === 'question' && it.answer === undefined) return it
    }
    return null
  }, [chat.running, chat.items])

  // Enter mid-run: answer the open question, or else steer the running turn (the
  // model reads it before its next step). Main decides steer vs queue against the
  // live run in one step and has the message on disk before replying, so it shows
  // as a chip until it lands and can't vanish with a run that ends first.
  const onSteer = useCallback(
    (text: string) => {
      const selected = settings?.selected
      const send = selected
        ? {
            providerId: selected.providerId,
            model: selected.model,
            approvalPolicy: settings.approvalPolicy,
            reasoningEffort: settings.reasoningEffort
          }
        : null
      void deliverMidRunMessage(text, {
        openQuestionId: openQuestion?.id ?? null,
        // Captured now: the reply is async, and the text belongs to the conversation
        // it was typed in, not wherever the user is by then.
        conversationId: currentId,
        canSend: !!send,
        answer: chat.answerQuestion,
        steer: (conversationId, t) =>
          send ? queue.steer({ conversationId, text: t, ...send }) : Promise.reject(new Error('No model selected.')),
        isOpen: (cid) => currentIdRef.current === cid,
        sendNow: (t) => void sendNow(t),
        enqueue: (conversationId, t) => {
          if (send) queue.enqueue({ conversationId, text: t, ...send })
        },
        giveBack: (t, cid, failed) => {
          // Shown in that chat's message box, even if the user has moved on.
          prefillComposer(t)
          if (failed && cid && currentIdRef.current === cid) {
            chat.notify("Couldn't send that message, so it's back in the message box.", 'error')
          }
        }
      })
    },
    [chat, settings, queue, currentId, openQuestion, prefillComposer, sendNow]
  )

  // Hand shipping off to the agent: close the panel and send the chosen action's
  // standing prompt (Create PR / Publish to GitHub / Commit & push, see
  // @shared/shipAction) as a normal turn, so the git and gh work runs through the
  // agent's tools and approval gate rather than the renderer touching git.
  // propose_session cards: start one as its own chat, ask for it here, or dismiss it.
  // Each decision is persisted on the chat (main returns the updated map).
  const proposalHandlers = useMemo<ProposalHandlers | undefined>(() => {
    if (!currentId || !settings) return undefined
    const convId = currentId
    return {
      states: proposalStates,
      start: async (callId) => {
        const res = await window.api.startProposal(convId, callId, settings.approvalPolicy)
        setProposalStates(res.proposals)
        await refreshConversations()
      },
      here: async (callId, title, prompt) => {
        // onSend quietly does nothing without a model or project, so check first:
        // recording "asked here" for a message that never went out would strand the
        // card with no way to start it.
        if (!settings.selected || !workspace) throw new Error('Pick a model first.')
        setProposalStates(await window.api.decideProposal(convId, callId, 'here'))
        onInvoke(proposalHereTurn({ title, prompt }))
      },
      dismiss: async (callId) => {
        setProposalStates(await window.api.decideProposal(convId, callId, 'dismissed'))
      },
      open: (id) => void selectConversation(id)
    }
  }, [currentId, settings, workspace, proposalStates, refreshConversations, onInvoke, selectConversation])

  // The handoff banner's link back to the chat that spawned this one. That chat may
  // have been deleted since; say so rather than doing nothing.
  const onOpenLinkedConversation = useCallback(
    (id: string) => {
      void window.api.getConversation(id).then((conv) => {
        if (conv) void selectConversation(id)
        else chat.notify('The chat this was handed off from no longer exists.', 'error')
      })
    },
    [selectConversation, chat]
  )

  // Side chat: "Continue in new chat" forks this chat and leaves the exchange as the
  // fork's composer draft, so the user decides what to send.
  const onSideChatContinue = useCallback(
    async (text: string) => {
      if (!currentId) return
      const fork = await window.api.forkConversation(currentId)
      if (!fork) return
      saveComposerDraft(fork.id, text)
      setSideChatOpen(false)
      await refreshConversations()
      await selectConversation(fork.id)
    },
    [currentId, refreshConversations, selectConversation]
  )

  const onShip = useCallback(
    (action: ShipAction) => {
      setChangesOpen(false)
      onInvoke(shipTurn(action))
    },
    [onInvoke]
  )

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
          ? "This conversation is a single turn, so there are no earlier turns to summarize. Start a new chat to free up context."
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

  /**
   * A command the desktop shares with the terminal: do it with the desktop's own
   * surface for the job (see desktopCommandAction), and say so when it can't run.
   */
  const runSharedCommand = useCallback(
    (action: DesktopCommandAction) => {
      switch (action.kind) {
        case 'settings':
          setSettingsSection(action.section)
          setSettingsQuery(action.query ?? '')
          setSettingsOpen(true)
          return
        case 'model': {
          const q = action.query.toLowerCase()
          if (q && settings) {
            // An exact id, provider/id, or display name switches straight away;
            // anything else opens the picker on that search.
            for (const p of settings.providers) {
              if (p.requiresKey && !p.hasKey) continue
              const m = p.models.find(
                (x) =>
                  x.id.toLowerCase() === q ||
                  `${p.id}/${x.id}`.toLowerCase() === q ||
                  (x.label ?? modelDisplayName(p.kind, x.id)).toLowerCase() === q
              )
              if (m) {
                void onSelectModel({ providerId: p.id, model: m.id })
                chat.notify(`Model: ${m.label ?? modelDisplayName(p.kind, m.id)}`)
                return
              }
            }
          }
          setPaletteSeed(action.query || 'model')
          setPaletteOpen(true)
          return
        }
        case 'changes':
          setChangesOpen(true)
          return
        case 'undo':
          if (chat.running) chat.notify('/undo can run once this turn ends.')
          else if (chat.checkpoint && !chat.checkpoint.reverted) void onRevert()
          else chat.notify('Nothing to undo: the last turn changed no files, or it was already undone.')
          return
        case 'redo':
          if (chat.checkpoint?.reverted && !chat.running) void onReapply()
          else chat.notify('Nothing to redo: /redo puts back what /undo reverted.')
          return
        case 'retry':
          if (chat.errored && !chat.running) onRetry()
          else chat.notify('Nothing to retry: /retry runs your last message again after a turn fails.')
          return
        case 'fork':
          if (currentId) void onForkConversation(currentId)
          else chat.notify('Nothing to fork yet: send a message first.')
          return
        case 'resume':
          setPaletteSeed(action.query)
          setPaletteOpen(true)
          return
        case 'btw':
        case 'btw-clear': {
          if (!currentId) {
            chat.notify('The side chat needs a saved chat: send a message first.')
            return
          }
          setSideChatOpen(true)
          if (action.kind === 'btw-clear') void window.api.clearSideChat(currentId)
          else if (action.question && settings?.selected) {
            const { providerId, model } = settings.selected
            void window.api
              .askSideChat(currentId, action.question, providerId, model)
              .catch((e: unknown) => chat.notify(`Side chat: ${(e as Error).message}`, 'error'))
          }
          return
        }
        case 'cost': {
          const u = chat.usage
          chat.notify(
            u && (u.context > 0 || u.output > 0)
              ? `This chat: ${formatTokens(u.context)} context · ${formatTokens(u.output)} out` +
                  (u.cost > 0 ? ` · about ${formatUsd(u.cost)}` : '') +
                  '. Hover the token count under the message box for a per-model breakdown.'
              : 'No usage yet in this chat.'
          )
          return
        }
        case 'cwd':
          chat.notify(workspace ? `Working folder: ${workspace}` : 'No folder is open.')
          return
        case 'share':
          void window.api.shareFromMenu()
          return
        case 'approval':
          if (action.policy) {
            void onChangePolicy(action.policy)
            chat.notify(`Approval mode: ${POLICY_LABEL[action.policy]}`)
          } else {
            const current = settings?.approvalPolicy ?? 'ask'
            chat.notify(
              (action.invalid ? `No approval mode "${action.invalid}". ` : '') +
                `Approval mode: ${POLICY_LABEL[current]}. Switch with /plan, /ask, /auto or /full.`,
              action.invalid ? 'error' : undefined
            )
          }
          return
        case 'reasoning':
          if (action.effort) {
            void onChangeReasoning(action.effort)
            chat.notify(`Thinking effort: ${action.effort}`)
          } else {
            chat.notify(
              (action.invalid ? `No thinking effort "${action.invalid}". ` : '') +
                `Thinking effort: ${settings?.reasoningEffort ?? DEFAULT_REASONING_EFFORT}. ` +
                'Set it with /reasoning off, low, medium, high or xhigh.',
              action.invalid ? 'error' : undefined
            )
          }
          return
      }
    },
    [
      settings,
      chat,
      currentId,
      workspace,
      onSelectModel,
      onRevert,
      onReapply,
      onRetry,
      onForkConversation,
      onChangePolicy,
      onChangeReasoning
    ]
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
        const turn = agentTurn(args, `/${cmd.name} ${args}`)
        if (turn) onInvoke(turn)
        else chat.notify('Usage: /agent <name> <task>. The name matches a file in .houston/agents', 'error')
      } else if (cmd.name === 'doctor') setDoctorOpen(true)
      else if (cmd.name === 'rewind') {
        if (currentId) setRewindPickerOpen(true)
        else chat.notify('Nothing to rewind yet: send a message first.')
      }
      else if (cmd.name === 'help') {
        chat.notify(
          'Commands: ' + BUILTIN_COMMANDS.map((c) => `/${c.name}`).join('  ') +
            (commands.length > BUILTIN_COMMANDS.length ? '  (+ custom from .houston/commands)' : '')
        )
      } else if (POLICY_COMMANDS[cmd.name]) {
        const policy = POLICY_COMMANDS[cmd.name]
        void onChangePolicy(policy)
        chat.notify(`Approval mode: ${POLICY_LABEL[policy]}`)
      } else {
        const action = desktopCommandAction(cmd.name, args)
        if (action) runSharedCommand(action)
      }
    },
    [onNewChat, onCompact, onListCapability, onChangePolicy, onInvoke, chat, commands, currentId, runSharedCommand]
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
        title: previewOpen && dockTab === 'preview' ? 'Hide preview panel' : 'Show preview panel',
        section: 'Actions',
        keywords: 'browser localhost dev server web',
        run: togglePreview
      },
      {
        id: 'act-toggle-tasks',
        title: previewOpen && dockTab === 'tasks' ? 'Hide background tasks' : 'Show background tasks',
        section: 'Actions',
        keywords: 'shell server process running port stop',
        run: toggleTasks
      },
      {
        id: 'act-change-folder',
        title: 'New chat in another folder',
        section: 'Actions',
        hint: shortcutHint('new-chat-in-folder', mac, shortcuts),
        keywords: 'open project workspace directory cwd',
        run: () => void onChangeWorkspace()
      },
      {
        id: 'act-import',
        title: 'Import chat from file',
        section: 'Actions',
        run: () => void onImportConversation()
      },
      {
        id: 'act-share',
        title: 'Share Houston',
        section: 'Actions',
        keywords: 'invite friend email airdrop link',
        run: () => void window.api.shareFromMenu()
      },
      {
        id: 'act-find',
        title: 'Find in conversation',
        section: 'Actions',
        hint: shortcutHint('find-in-chat', mac, shortcuts),
        keywords: 'search',
        run: openFind
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
      },
      {
        id: 'act-tips',
        title: 'Take the tour',
        section: 'Actions',
        keywords: 'tips getting started onboarding help walkthrough',
        run: onboarding.startTour
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
        id: 'act-side-chat',
        title: sideChatOpen ? 'Close side chat' : 'Open side chat',
        section: 'Actions',
        keywords: 'aside btw question ask sidebar',
        run: () => setSideChatOpen((o) => !o)
      })
      items.push({
        id: 'act-compact',
        title: 'Compact conversation',
        section: 'Actions',
        keywords: 'summarize context',
        run: () => void onCompact()
      })
      // Not while the chat waits on the user: answering is what clears that.
      if ((chatStatus[currentId]?.pending.length ?? 0) === 0) {
        const id = currentId
        items.push({
          id: 'act-mark-unread',
          title: 'Mark chat as unread',
          section: 'Actions',
          keywords: 'new later remind flag',
          run: () => onSetUnread(id, true)
        })
      }
    }
    if (Object.values(chatStatus).some((st) => st.unread !== undefined)) {
      items.push({
        id: 'act-mark-all-read',
        title: 'Mark all chats as read',
        section: 'Actions',
        keywords: 'unread clear seen',
        run: onMarkAllRead
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
        subtitle: baseName(c.workspace),
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
    dockTab,
    sideChatOpen,
    settings?.approvalPolicy,
    settings?.providers,
    settings?.selected,
    conversations,
    onNewChat,
    toggleSidebar,
    toggleTerminal,
    togglePreview,
    toggleTasks,
    onChangeWorkspace,
    onImportConversation,
    onCompact,
    onChangePolicy,
    onSelectModel,
    selectConversation,
    onboarding.startTour,
    chatStatus,
    onSetUnread,
    onMarkAllRead,
    openFind
  ])

  // Every overlay's open state in one place (see lib/overlays.ts), read live by the
  // keyboard handler through a ref so a newly opened overlay can never be missing
  // from a stale closure.
  const overlays: OverlayFlags = {
    settings: settingsOpen,
    doctor: doctorOpen,
    changes: changesOpen,
    files: filesOpen,
    scorecard: scorecardOpen,
    help: helpOpen,
    viewer: viewer !== null,
    palette: paletteOpen,
    find: findOpen,
    connect: connectOpen,
    whatsNew: whatsNew !== null,
    rewind: rewindPickerOpen || rewindConfirm !== null
  }
  const overlaysRef = useRef(overlays)
  overlaysRef.current = overlays
  // The native File menu (main/menu.ts) sends its commands here so they run through
  // the same handlers as the palette and sidebar, and it greys out Export when no
  // chat is open, so report that as it changes.
  useEffect(
    () =>
      window.api.onMenuCommand((cmd) => {
        if (cmd.type === 'new-chat') void onNewChat()
        else if (cmd.type === 'new-chat-in-folder') void onChangeWorkspace()
        else if (cmd.type === 'new-chat-in-workspace') enterNewChat(cmd.workspace)
        else if (cmd.type === 'import-chat') void onImportConversation()
        else if (cmd.type === 'take-tour') startTour()
        else if (cmd.type === 'export-chat' && currentId) {
          if (cmd.format === 'html') void onExportConversationHtml(currentId)
          else void onExportConversation(currentId)
        }
      }),
    [
      onNewChat,
      onChangeWorkspace,
      enterNewChat,
      onImportConversation,
      onExportConversation,
      onExportConversationHtml,
      currentId,
      startTour
    ]
  )
  useEffect(() => window.api.setMenuState({ hasConversation: currentId !== null }), [currentId])

  // Global keyboard shortcuts (see lib/shortcuts.ts for the registry): ⌘N new chat,
  // ⇧⌘N new chat in another folder, ⌘K palette, ⌘1–9 / ⌃Tab switch chats, Shift+Tab
  // cycle mode, ⌘F find, ⌘⇧M model, ⌘/ or ? help, ⌃` terminal, Esc to stop a run /
  // close a dialog.
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
      } else if (action === 'new-chat-in-folder') {
        e.preventDefault()
        void onChangeWorkspace()
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
        openFind()
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
        // Shift+Tab is reverse-focus in dialogs: let their focus trap (or the find
        // bar) have it; only hijack it for mode-cycling in the main chat view. An
        // open popover menu (model picker, ⋯ menu) is portaled to <body>, invisible
        // to these flags, so consult its registry too, and a non-modal dialog (the
        // What's new card) owns the key while focus is inside it.
        const inDialog = e.target instanceof Element && e.target.closest('[role="dialog"]') !== null
        if (ownsShiftTab(overlaysRef.current) || isAnyPopoverOpen() || inDialog) return
        e.preventDefault()
        cyclePolicy()
      } else if (action === 'escape') {
        // The open overlays own their own Esc (focus trap), so this mainly handles
        // Esc with nothing focused, still ordered most-recent-first defensively.
        const o = overlaysRef.current
        if (o.viewer) setViewer(null)
        else if (o.palette) setPaletteOpen(false)
        else if (o.help) setHelpOpen(false)
        else if (o.find) setFindOpen(false)
        else if (o.settings) setSettingsOpen(false)
        else if (o.changes) setChangesOpen(false)
        else if (o.files) setFilesOpen(false)
        else if (o.scorecard) setScorecardOpen(false)
        else if (o.doctor) setDoctorOpen(false)
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
    onChangeWorkspace,
    toggleSidebar,
    toggleTerminal,
    jumpToChat,
    cycleChat,
    cyclePolicy,
    shortcuts,
    openFind,
    chat.running,
    chat.cancel
  ])

  if (!settings) {
    return <div className="loading">Loading…</div>
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
  // First-run onboarding (see @shared/onboarding): the checklist reads real state, so
  // each step ticks itself off; tips show once each, when their control first matters.
  const checklistFacts: ChecklistFacts = {
    modelReady: Boolean(settings.selected && selectionReady),
    hasWorkspace: Boolean(workspace),
    hasConversation: conversations.length > 0
  }
  const showChecklist = checklistVisible(onboarding.state, checklistFacts, conversationsLoaded)
  // Setup is down to step 3: point the user at the message box (cursor + glow).
  const awaitingFirstTask =
    showChecklist && !connectOpen && checklistFacts.modelReady && checklistFacts.hasWorkspace
  const tipsRelevant = relevantTips({
    readyToSend: chat.items.length === 0 && canChat && !chat.running,
    afterEdit: Boolean(chat.checkpoint && !chat.checkpoint.reverted && !chat.running),
    touring: onboarding.touring
  })
  const tipsSuppressed = suppressesTips(overlays)
  // Only offer the image-attachment affordance when the selected model can see
  // images. Resolve host-reported capabilities first (same source the model picker
  // uses) so a host-listed vision model isn't denied the attach buttons by the
  // name-only heuristic — and vice-versa.
  const selectedModelOption = selectedProvider?.models.find((m) => m.id === settings.selected?.model)
  const visionSupported = settings.selected
    ? resolveCapabilities(settings.selected.model, selectedModelOption?.caps).vision
    : true

  return (
    <ImageViewerContext.Provider value={imageViewerApi}>
    <VisualsContext.Provider value={visualsSettings}>
    <div
      className="app"
      ref={appRef}
      style={
        {
          '--sidebar-w': `${sidebarCollapsed ? SIDEBAR_RAIL_WIDTH : sidebarWidth}px`,
          '--terminal-h': `${terminalHeight}px`,
          '--preview-w': `${previewOpen ? previewWidth : 0}px`,
          '--plan-w': `${planPanelOpen || sideChatVisible ? planWidth : 0}px`
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
        toggleShortcut={shortcutHint('toggle-sidebar', mac, shortcuts)}
        chatStatus={chatStatus}
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
        onSetUnread={onSetUnread}
        onMarkAllRead={onMarkAllRead}
        unreadFirst={settings.sidebarUnreadFirst ?? false}
        onToggleUnreadFirst={onToggleUnreadFirst}
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
        collapsedParents={collapsedParents}
        onToggleParentCollapsed={(id) => void onToggleParentCollapsed(id)}
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
          tasksOpen={previewOpen && dockTab === 'tasks'}
          onToggleTasks={toggleTasks}
          changes={workspace ? workingTreeStats : undefined}
          onShowFiles={workspace ? () => setFilesOpen(true) : undefined}
          onShowChanges={workspace ? () => setChangesOpen(true) : undefined}
          onTogglePreview={togglePreview}
          previewOpen={previewOpen && dockTab === 'preview'}
          previewCount={previewableCount}
          onToggleTerminal={toggleTerminal}
          terminalOpen={terminalOpen}
          onToggleSideChat={currentId ? () => setSideChatOpen((o) => !o) : undefined}
          sideChatOpen={sideChatVisible}
          terminalShortcut={shortcutHint('toggle-terminal', mac, shortcuts)}
          needsYou={{ count: waitingIds.length, onNext: openNextWaiting }}
        />

        <UpdateBanner
          update={updateBanner.update}
          progress={updateBanner.progress}
          downloaded={updateBanner.downloaded}
          failed={updateBanner.failed}
          onInstall={() => void window.api.installUpdate()}
          onDismiss={updateBanner.dismiss}
        />

        {findOpen && (
          <Suspense fallback={null}>
            <FindBar getRoots={getFindRoots} onClose={() => setFindOpen(false)} focusRequest={findRequest} />
          </Suspense>
        )}

        {chat.items.length === 0 ? (
          <div className="welcome">
            <h1>Houston</h1>
            <p>A model-agnostic, sandboxed coding agent. Decoupled from your model bill.</p>
            {showChecklist && connectOpen ? (
              <ConnectModel
                settings={settings}
                onConnected={(fresh, id, model) => void onModelConnected(fresh, id, model)}
                onBack={() => {
                  setConnectBackedOut(true)
                  setConnectOpen(false)
                }}
              />
            ) : showChecklist ? (
              <GetStarted
                facts={checklistFacts}
                modelSummary={
                  selectedProvider && settings.selected
                    ? `${providerShortName(selectedProvider)} · ${modelDisplayName(selectedProvider.kind, settings.selected.model)}`
                    : undefined
                }
                folderSummary={workspace ? baseName(workspace) : undefined}
                taskExample={firstTaskExample(workspaceKind)}
                onConnectModel={() => setConnectOpen(true)}
                onChooseFolder={() => void onChangeWorkspace()}
                focusModelStep={connectBackedOut}
              />
            ) : (
              <>
                {!workspace && <p className="welcome__hint">Choose a project folder to begin.</p>}
                {workspace && !settings.selected && (
                  <p className="welcome__hint">Pick a model (set an API key in Settings first).</p>
                )}
              </>
            )}
          </div>
        ) : (
          <Transcript
            items={chat.items}
            onApprove={chat.approve}
            onAnswer={chat.answerQuestion}
            onElicit={chat.answerElicitation}
            onOpenPlan={onOpenPlan}
            onRunInTerminal={(command) => void runInTerminal(command)}
            proposals={proposalHandlers}
            onOpenConversation={onOpenLinkedConversation}
            rewind={rewindHandlers}
            {...(currentId && (chatStatus[currentId]?.pending.length ?? 0) === 0
              ? { onMarkUnreadFrom: (n: number) => onSetUnread(currentId, true, n) }
              : {})}
            {...(newFrom && newFrom.conversationId === currentId ? { newFromId: newFrom.itemId } : {})}
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

        <GlobalRulesNotice onDecided={setSettings} />

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
              <Icon name="refresh" /> Retry
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
              <button className="btn btn--sm" onClick={onRevert} data-tour="revert">
                ↶ Revert
              </button>
            )}
          </div>
        )}

        {canUndoRewind && !chat.running && currentId && (
          <div className="checkpoint-bar">
            <span className="checkpoint-bar__label">Rewound to an earlier message.</span>
            <button className="btn btn--sm" onClick={() => void onUndoRewind()}>
              ↶ Undo rewind
            </button>
          </div>
        )}

        {queue.queued.length > 0 && (
          <div className="queue-bar">
            <span className="queue-bar__label">{queueBarLabel(queue.queued, chat.running)}</span>
            <ul className="queue-bar__items">
              {queue.queued.map((q) => {
                const label =
                  q.text.trim() ||
                  (q.imageCount ? `🖼 ${q.imageCount} image${q.imageCount === 1 ? '' : 's'}` : '')
                // A steer is the agent's to read at its next step; × takes it back.
                const removeLabel = q.steer ? 'Take back this steer' : 'Remove from queue'
                return (
                  <li key={q.id} className={`queue-chip${q.steer ? ' queue-chip--steer' : ''}`} title={label}>
                    {q.steer && <Icon name="steer" size={12} />}
                    <span className="queue-chip__text">{label}</span>
                    <button
                      className="queue-chip__remove"
                      title={removeLabel}
                      aria-label={removeLabel}
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
            subagentSpend={subagentSpendRows}
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
            {...(currentId && chatSettings && savedSettings && differsFromDefaults(chatSettings, savedSettings)
              ? { onMakeDefault: () => void onMakeChatSettingsDefault() }
              : {})}
          />
          <Composer
            // Remount per conversation so each chat shows its own draft (and a
            // fresh attachment/menu state), in isolation from the others.
            key={currentId ?? 'new'}
            conversationId={currentId}
            disabled={!canChat}
            disabledReason={disabledReason}
            running={chat.running}
            attention={awaitingFirstTask}
            workspace={workspace}
            commands={commands}
            vision={visionSupported}
            lastUserMessage={lastUserText(chat.items)}
            changes={workspace ? workingTreeStats : undefined}
            onShowChanges={() => setChangesOpen(true)}
            onShip={canChat ? onShip : undefined}
            onCommand={onCommand}
            onSend={onSend}
            onInvoke={onInvoke}
            onSteer={onSteer}
            answering={openQuestion !== null}
            onSaveMemory={onSaveMemory}
            onCancel={chat.cancel}
            editing={editing ? { label: editing.target.label, mode: editing.mode } : undefined}
            onEditModeChange={(mode) => setEditing((prev) => (prev ? { ...prev, mode } : prev))}
            onCancelEdit={() => setEditing(null)}
            prefill={composerPrefill?.conversationId === currentId ? composerPrefill : undefined}
            onRewindPicker={currentId ? () => setRewindPickerOpen(true) : undefined}
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
            // The native preview views paint above every HTML overlay; hide them (but
            // keep them alive) while one is open so a preview can't cover it.
            occluded={occludesPreview(overlays)}
            onResizeMouseDown={onPreviewResizeMouseDown}
            onClose={closeDock}
            tab={dockTab}
            onTabChange={setDockTab}
            focusServerId={previewFocus?.id ?? null}
            focusRequest={previewFocus}
            taskCount={activeTaskCount(backgroundTasks)}
            tasks={
              <TasksPanel
                tasks={backgroundTasks}
                currentId={currentId}
                active={dockTab === 'tasks'}
                onStop={(id) => window.api.stopBackgroundShell(id)}
                onOpenPreview={(task) => {
                  setPreviewFocus({ id: task.id })
                  setDockTab('preview')
                }}
                onGoToChat={openBackgroundTask}
                onOpenTerminal={openBackgroundTask}
                onClearFinished={clearFinishedTasks}
              />
            }
          />
        </Suspense>
      )}

      {sideChatOpen && currentId && (
        <SideChatPanel
          // One panel per chat (its side chat is stored with the chat, so switching
          // back shows it again). While a plan review has the column the panel stays
          // mounted but hidden, rather than unmounted, so nothing in it is lost.
          key={currentId}
          hidden={!sideChatVisible}
          conversationId={currentId}
          providerId={settings.selected?.providerId}
          model={settings.selected?.model}
          onClose={() => setSideChatOpen(false)}
          onSendToMain={(question, answer) => onInvoke(sideChatTurn(question, answer))}
          onContinueInNewChat={(question, answer) => void onSideChatContinue(sideChatExchangeText(question, answer))}
          onResizeMouseDown={onPlanResizeMouseDown}
        />
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
            initial={savedSettings ?? settings}
            initialTab={settingsSection}
            initialQuery={settingsQuery}
            workspace={workspace}
            onClose={() => {
              setSettingsOpen(false)
              setSettingsSection('models')
              setSettingsQuery('')
            }}
            onSaved={(s) => setSettings(s)}
            onShowScorecard={() => {
              setSettingsOpen(false)
              setScorecardOpen(true)
            }}
            onShowDoctor={() => {
              setSettingsOpen(false)
              setDoctorOpen(true)
            }}
          />
        )}

        {doctorOpen && <DoctorModal workspace={workspace} onClose={() => setDoctorOpen(false)} />}

        {filesOpen && (
          <FilesPanel
            workspace={workspace}
            initialPath={filesTarget}
            onClose={() => {
              setFilesOpen(false)
              setFilesTarget(undefined)
            }}
          />
        )}

        {scorecardOpen && <Scorecard onClose={() => setScorecardOpen(false)} />}

        {changesOpen && (
          <DiffPanel
            workspace={workspace}
            onClose={() => setChangesOpen(false)}
            onShip={canChat ? onShip : undefined}
            creating={chat.running}
          />
        )}

        {whatsNew && <WhatsNewModal info={whatsNew} onClose={() => setWhatsNew(null)} />}

        {helpOpen && <ShortcutsHelp shortcuts={shortcuts} onClose={() => setHelpOpen(false)} />}

        {rewindPickerOpen && (
          <RewindPicker
            targets={rewindTargets(chat.items)}
            onClose={() => setRewindPickerOpen(false)}
            onPick={(target) => {
              setRewindPickerOpen(false)
              setRewindConfirm({ target, mode: 'both' })
            }}
          />
        )}

        {rewindConfirm && currentId && (
          <RewindDialog
            conversationId={currentId}
            target={rewindConfirm.target}
            initialMode={rewindConfirm.mode}
            onCancel={() => setRewindConfirm(null)}
            onConfirm={(mode) => void onConfirmRewind(mode)}
            onEdit={() => onEditMessage(rewindConfirm.target)}
          />
        )}

        {paletteOpen && (
          <CommandPalette
            items={paletteItems}
            initialQuery={paletteSeed}
            onClose={() => setPaletteOpen(false)}
          />
        )}
      </Suspense>

      {undoToast && (
        <div className="undo-toast" role="status">
          <span>{undoToast.text}</span>
          <button
            type="button"
            className="undo-toast__btn"
            onClick={() => {
              undoToast.undo()
              setUndoToast(null)
            }}
          >
            Undo
          </button>
        </div>
      )}
      <TipHost
        relevant={tipsRelevant}
        seen={onboarding.state.seenTips}
        suppressed={tipsSuppressed}
        touring={onboarding.touring}
        delayMs={PRE_SEND_TIP_DELAY_MS}
        onSeen={(ids) => onboarding.update((s) => markTipsSeen(s, ids))}
        onTourEnd={onboarding.endTour}
      />
      {viewer && (
        <ImageViewer
          images={viewer.images}
          initialIndex={viewer.index}
          onClose={() => setViewer(null)}
          onOpenFile={async (path) => {
            if (!workspace) return 'No project folder is open.'
            const res = await window.api.openWorkspacePath(workspace, path)
            return res.ok ? null : (res.error ?? "Couldn't open that file.")
          }}
          onShowInFiles={(path) => {
            const rel = workspace ? workspaceRelativePath(path, workspace) : null
            if (!rel) return 'That file is outside the project folder.'
            setViewer(null)
            setFilesTarget(rel)
            setFilesOpen(true)
            return null
          }}
          onCopy={async (img) =>
            (await window.api.copyImage(img.src))
              ? { ok: true, message: 'Copied' }
              : { ok: false, message: "Couldn't copy the image." }
          }
          onSave={async (img) => {
            const saved = await window.api.saveImage(img.src, img.label)
            return saved ? { ok: true, message: `Saved to ${saved.split(/[\\/]/).pop()}` } : null
          }}
        />
      )}
    </div>
    </VisualsContext.Provider>
    </ImageViewerContext.Provider>
  )
}
