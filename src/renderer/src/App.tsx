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
import type { AppSettings, ApprovalPolicy, ChatGroup, SelectedModel } from '@shared/types'
import type { ConversationMeta, ReasoningEffort, RepoInfo } from '@shared/agent'
import { mergeCommands, type Command } from '@shared/commands'
import type { ImageAttachment } from '@shared/images'
import { modelCapabilities } from '@shared/usage'
import { branchNameError, suggestBranch } from './lib/worktree'
import { applyTheme } from './lib/theme'
import { shortcutFor } from './lib/shortcuts'
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
import { useChat } from './hooks/useChat'
import { useInputQueue } from './hooks/useInputQueue'
import { itemsFromMessages } from './lib/items'
import { Sidebar } from './components/Sidebar'
import { Titlebar } from './components/Titlebar'
import { ControlBar } from './components/ControlBar'
import { Transcript } from './components/Transcript'
import { Composer } from './components/Composer'
import { UpdateBanner } from './components/UpdateBanner'
import type { UpdateCheckResult, WhatsNew } from '@shared/update'

// These overlays aren't on the initial render path, so load them as separate
// chunks fetched on first open instead of bloating the main bundle. SettingsModal
// alone is the largest component in the renderer.
const SettingsModal = lazy(() =>
  import('./components/SettingsModal').then((m) => ({ default: m.SettingsModal }))
)
const DiffPanel = lazy(() => import('./components/DiffPanel').then((m) => ({ default: m.DiffPanel })))
const TerminalDock = lazy(() =>
  import('./components/TerminalDock').then((m) => ({ default: m.TerminalDock }))
)
const WhatsNewModal = lazy(() =>
  import('./components/WhatsNewModal').then((m) => ({ default: m.WhatsNewModal }))
)

/** Built-in slash commands (custom ones are loaded from the workspace). */
const BUILTIN_COMMANDS: Command[] = [
  { name: 'new', description: 'Start a new chat' },
  { name: 'compact', description: 'Summarize older turns to free up context now' },
  { name: 'plan', description: 'Plan mode — read-only (research & propose, no edits/commands)' },
  { name: 'ask', description: 'Approval: ask before every edit and command' },
  { name: 'auto', description: 'Approval: auto-approve edits, ask for commands' },
  { name: 'full', description: 'Approval: full auto (sandboxed)' },
  { name: 'help', description: 'List the available slash commands' },
  {
    name: 'review',
    description: 'Adversarial review of your uncommitted changes',
    template:
      'Review my current uncommitted changes for correctness, security, and quality. Use the review_changes tool to run the adversarial review (a separate reviewer per dimension, then a verification pass), then fix any confirmed issues and summarize what you found.'
  }
]

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
  if (ready) return { providerId: ready.id, model: ready.defaultModel ?? ready.models[0].id }
  return null
}

export default function App(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [conversations, setConversations] = useState<ConversationMeta[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [lastWorkspace, setLastWorkspace] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [changesOpen, setChangesOpen] = useState(false)
  // Worktree setup for a not-yet-started chat (shown inline in the control bar).
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null)
  const [worktreeMode, setWorktreeMode] = useState(true)
  const [branchName, setBranchName] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [commands, setCommands] = useState<Command[]>(BUILTIN_COMMANDS)
  const [search, setSearch] = useState('')
  const [matchIds, setMatchIds] = useState<Set<string> | null>(null)
  const [update, setUpdate] = useState<Extract<UpdateCheckResult, { status: 'available' }> | null>(
    null
  )
  const [whatsNew, setWhatsNew] = useState<WhatsNew | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  // Latches true on first open and stays mounted thereafter (hidden via CSS when
  // closed) so terminal sessions and scrollback survive hide/show.
  const [terminalMounted, setTerminalMounted] = useState(false)
  const [terminalHeight, setTerminalHeight] = useState(TERMINAL_DEFAULT_HEIGHT)
  const appRef = useRef<HTMLDivElement>(null)
  const chat = useChat(currentId)

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
    const unsubscribe = window.api.onUpdateAvailable(setUpdate)
    void window.api.getWhatsNew().then((wn) => {
      if (wn) setWhatsNew(wn)
    })
    return unsubscribe
  }, [])

  // Apply the color theme whenever it changes, and follow the OS while on "system".
  const theme = settings?.theme ?? 'system'
  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = (): void => applyTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

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

  const visibleConversations = useMemo(
    () => (matchIds ? conversations.filter((c) => matchIds.has(c.id)) : conversations),
    [conversations, matchIds]
  )

  const currentConv = useMemo(
    () => conversations.find((c) => c.id === currentId) ?? null,
    [conversations, currentId]
  )
  const workspace = currentConv?.workspace ?? lastWorkspace

  // For a not-yet-started chat, load the workspace's git info and seed fresh
  // worktree defaults: a new worktree (on for git repos), a suggested branch
  // name, and the current branch as the base. Re-runs when the folder changes.
  useEffect(() => {
    if (currentId !== null || !workspace) {
      setRepoInfo(null)
      return
    }
    let cancelled = false
    void window.api.getRepoInfo(workspace).then((info) => {
      if (cancelled) return
      setRepoInfo(info)
      setWorktreeMode(info.isRepo)
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
      const [conv, activeRunId] = await Promise.all([
        window.api.getConversation(id),
        window.api.getActiveRun(id)
      ])
      if (!conv) return
      setCurrentId(id)
      setLastWorkspace(conv.workspace)
      chat.reset(
        itemsFromMessages(conv.messages),
        conv.usage
          ? {
              context: conv.usage.inputTokens,
              output: conv.usage.outputTokens,
              cost: conv.usage.cost ?? 0
            }
          : null
      )
      // A run for this conversation is still in flight in the main process —
      // re-adopt it so the composer shows Stop and events/approvals reconnect.
      if (activeRunId) chat.adopt(activeRunId)
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
      const conv = conversations.find((c) => c.id === id)
      let removeWorktree = false
      if (conv?.worktree) {
        // The chat is deleted either way; the prompt only governs the worktree.
        removeWorktree = window.confirm(
          `Delete “${conv.title}”.\n\n` +
            `Also remove its git worktree and branch “${conv.worktree.branch}”?\n\n` +
            `OK — remove the worktree (any uncommitted or unmerged work is kept).\n` +
            `Cancel — keep the worktree on disk.`
        )
      }
      const res = await window.api.deleteConversation(
        id,
        conv?.worktree ? { removeWorktree } : undefined
      )
      if (removeWorktree && res?.message) alert(res.message)
      if (id === currentId) {
        setCurrentId(null)
        chat.reset([])
      }
      await refreshConversations()
    },
    [conversations, currentId, chat, refreshConversations]
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

  const onMoveConversation = useCallback(
    async (id: string, groupId: string | null) => {
      await window.api.organizeConversation(id, { groupId })
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

  const onCommand = useCallback(
    (cmd: Command) => {
      // Only built-in action commands reach here; custom (template) commands are
      // expanded into the composer by the Composer itself.
      if (cmd.name === 'new') void onNewChat()
      else if (cmd.name === 'compact') void onCompact()
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
    [onNewChat, onCompact, onChangePolicy, chat, commands]
  )

  // Global keyboard shortcuts: Cmd/Ctrl+N new chat, Cmd/Ctrl+, settings,
  // Esc to stop a run or close the settings dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const action = shortcutFor(e)
      // Keys typed inside the terminal belong to the shell (Esc → vim, etc.).
      // Only the terminal toggle is honoured there; everything else passes through.
      const inTerminal =
        e.target instanceof HTMLElement && e.target.closest('.terminal-dock') !== null
      if (inTerminal && action !== 'toggle-terminal') return
      if (action === 'new-chat') {
        e.preventDefault()
        void onNewChat()
      } else if (action === 'open-settings') {
        e.preventDefault()
        setSettingsOpen(true)
      } else if (action === 'toggle-sidebar') {
        e.preventDefault()
        toggleSidebar()
      } else if (action === 'toggle-terminal') {
        e.preventDefault()
        toggleTerminal()
      } else if (action === 'escape') {
        if (settingsOpen) setSettingsOpen(false)
        else if (changesOpen) setChangesOpen(false)
        else if (chat.running) chat.cancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // chat.cancel is stable (useCallback); depending on the whole `chat` object
    // would re-subscribe every render. The fields we read are listed explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onNewChat, toggleSidebar, toggleTerminal, settingsOpen, changesOpen, chat.running, chat.cancel])

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
  // Only offer the image-attachment affordance when the selected model can see images.
  const visionSupported = settings.selected
    ? modelCapabilities(settings.selected.model).vision
    : true

  return (
    <div
      className="app"
      ref={appRef}
      style={
        {
          '--sidebar-w': `${sidebarCollapsed ? SIDEBAR_RAIL_WIDTH : sidebarWidth}px`,
          '--terminal-h': `${terminalHeight}px`
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
        onMove={onMoveConversation}
        onCreateGroup={onCreateGroup}
        onRenameGroup={onRenameGroup}
        onDeleteGroup={onDeleteGroup}
        onToggleGroupCollapsed={onToggleGroupCollapsed}
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
          onShowChanges={workspace ? () => setChangesOpen(true) : undefined}
          onToggleTerminal={toggleTerminal}
          terminalOpen={terminalOpen}
        />

        <UpdateBanner update={update} onDismiss={() => setUpdate(null)} />

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
          <Transcript items={chat.items} onApprove={chat.approve} onAnswer={chat.answerQuestion} />
        )}

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
              {queue.queued.length} queued · sent when this run finishes
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
            <button className="btn btn--sm" onClick={queue.clear}>
              Clear
            </button>
          </div>
        )}

        {terminalMounted && (
          <Suspense fallback={null}>
            <TerminalDock
              workspace={workspace}
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
            disabled={!canChat}
            running={chat.running}
            workspace={workspace}
            commands={commands}
            vision={visionSupported}
            onCommand={onCommand}
            onSend={onSend}
            onCancel={chat.cancel}
          />
        </div>

        <footer className="statusbar">
          <span className={`statusbar__dot${chat.running ? ' statusbar__dot--busy' : ''}`} />
          <span className="statusbar__state">{statusText(chat.items, chat.running)}</span>
          {settings.selected && <span className="statusbar__model">{settings.selected.model}</span>}
        </footer>
      </div>

      <Suspense fallback={null}>
        {settingsOpen && (
          <SettingsModal
            initial={settings}
            onClose={() => setSettingsOpen(false)}
            onSaved={(s) => setSettings(s)}
          />
        )}

        {changesOpen && (
          <DiffPanel
            workspace={workspace}
            onClose={() => setChangesOpen(false)}
            onCreatePr={canChat ? onCreatePr : undefined}
            creating={chat.running}
          />
        )}

        {whatsNew && <WhatsNewModal info={whatsNew} onClose={() => setWhatsNew(null)} />}
      </Suspense>
    </div>
  )
}
