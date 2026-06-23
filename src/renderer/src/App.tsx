import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppSettings, ApprovalPolicy, ChatGroup, SelectedModel } from '@shared/types'
import type { ConversationMeta, ReasoningEffort } from '@shared/agent'
import { mergeCommands, type Command } from '@shared/commands'
import type { ImageAttachment } from '@shared/images'
import { applyTheme } from './lib/theme'
import { shortcutFor } from './lib/shortcuts'
import { statusText } from './lib/statusLine'
import { newGroupId } from './lib/chatGroups'
import { useChat } from './hooks/useChat'
import { itemsFromMessages } from './lib/items'
import { Sidebar } from './components/Sidebar'
import { Titlebar } from './components/Titlebar'
import { ControlBar } from './components/ControlBar'
import { Transcript } from './components/Transcript'
import { Composer } from './components/Composer'
import { SettingsModal } from './components/SettingsModal'

/** Built-in slash commands (custom ones are loaded from the workspace). */
const BUILTIN_COMMANDS: Command[] = [
  { name: 'new', description: 'Start a new chat' },
  {
    name: 'review',
    description: 'Adversarial review of your uncommitted changes',
    template:
      'Review my current uncommitted changes for correctness, security, and quality. Use the review_changes tool to run the adversarial review (a separate reviewer per dimension, then a verification pass), then fix any confirmed issues and summarize what you found.'
  }
]

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
  const [commands, setCommands] = useState<Command[]>(BUILTIN_COMMANDS)
  const chat = useChat()

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
      await refreshConversations()
    })()
  }, [refreshConversations])

  // Reload the conversation list when a run finishes (titles/updatedAt change).
  useEffect(() => {
    if (!chat.running) void refreshConversations()
  }, [chat.running, refreshConversations])

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

  const currentConv = useMemo(
    () => conversations.find((c) => c.id === currentId) ?? null,
    [conversations, currentId]
  )
  const workspace = currentConv?.workspace ?? lastWorkspace

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
      const conv = await window.api.getConversation(id)
      if (!conv) return
      setCurrentId(id)
      setLastWorkspace(conv.workspace)
      chat.reset(
        itemsFromMessages(conv.messages),
        conv.usage ? { context: conv.usage.inputTokens, output: conv.usage.outputTokens } : null
      )
    },
    [chat]
  )

  const newChatInWorkspace = useCallback(
    async (ws: string) => {
      if (!settings) return
      const sel = settings.selected
      const conv = await window.api.createConversation({
        workspace: ws,
        providerId: sel?.providerId ?? '',
        model: sel?.model ?? ''
      })
      setLastWorkspace(ws)
      setCurrentId(conv.id)
      chat.reset([])
      await refreshConversations()
    },
    [settings, chat, refreshConversations]
  )

  const onNewChat = useCallback(async () => {
    const ws = workspace ?? (await window.api.pickWorkspace())
    if (ws) await newChatInWorkspace(ws)
  }, [workspace, newChatInWorkspace])

  const onChangeWorkspace = useCallback(async () => {
    const ws = await window.api.pickWorkspace()
    if (ws) await newChatInWorkspace(ws)
  }, [newChatInWorkspace])

  const onDeleteConversation = useCallback(
    async (id: string) => {
      await window.api.deleteConversation(id)
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

  const onChangePolicy = useCallback(async (policy: ApprovalPolicy) => {
    const fresh = await window.api.saveSettings({
      ...(await window.api.getSettings()),
      approvalPolicy: policy
    })
    setSettings(fresh)
  }, [])

  const onChangeReasoning = useCallback(async (reasoningEffort: ReasoningEffort) => {
    const fresh = await window.api.saveSettings({
      ...(await window.api.getSettings()),
      reasoningEffort
    })
    setSettings(fresh)
  }, [])

  const onRevert = useCallback(async () => {
    const n = await chat.revertCheckpoint()
    if (n > 0) alert(`Reverted ${n} file change${n === 1 ? '' : 's'} from the last turn.`)
  }, [chat])

  const onReapply = useCallback(async () => {
    const n = await chat.reapplyCheckpoint()
    if (n > 0) alert(`Re-applied ${n} file change${n === 1 ? '' : 's'} from the last turn.`)
  }, [chat])

  const onSend = useCallback(
    async (text: string, images?: ImageAttachment[]) => {
      if (!settings?.selected || !workspace) return
      let convId = currentId
      if (!convId) {
        const conv = await window.api.createConversation({
          workspace,
          providerId: settings.selected.providerId,
          model: settings.selected.model
        })
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
    [settings, workspace, currentId, chat, refreshConversations]
  )

  const onCommand = useCallback(
    (cmd: Command) => {
      // Only built-in action commands reach here; custom (template) commands are
      // expanded into the composer by the Composer itself.
      if (cmd.name === 'new') void onNewChat()
    },
    [onNewChat]
  )

  // Global keyboard shortcuts: Cmd/Ctrl+N new chat, Cmd/Ctrl+, settings,
  // Esc to stop a run or close the settings dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const action = shortcutFor(e)
      if (action === 'new-chat') {
        e.preventDefault()
        void onNewChat()
      } else if (action === 'open-settings') {
        e.preventDefault()
        setSettingsOpen(true)
      } else if (action === 'escape') {
        if (settingsOpen) setSettingsOpen(false)
        else if (chat.running) chat.cancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // chat.cancel is stable (useCallback); depending on the whole `chat` object
    // would re-subscribe every render. The fields we read are listed explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onNewChat, settingsOpen, chat.running, chat.cancel])

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
  const canChat = Boolean(settings.selected && workspace && selectionReady)

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        groups={settings.chatGroups ?? []}
        currentId={currentId}
        onSelect={selectConversation}
        onNew={onNewChat}
        onDelete={onDeleteConversation}
        onFork={onForkConversation}
        onExport={onExportConversation}
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

      <div className="main">
        <Titlebar title={currentConv?.title ?? 'Houston'} />

        {chat.items.length === 0 ? (
          <div className="welcome">
            <h1>Houston</h1>
            <p>An open-source coding agent. Bring your own model.</p>
            {!workspace && <p className="welcome__hint">Choose a project folder to begin.</p>}
            {workspace && !settings.selected && (
              <p className="welcome__hint">Pick a model (set an API key in Settings first).</p>
            )}
          </div>
        ) : (
          <Transcript items={chat.items} onApprove={chat.approve} />
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

        <div className="dock">
          <ControlBar
            settings={settings}
            selected={settings.selected}
            workspace={workspace}
            usage={chat.usage}
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

      {settingsOpen && (
        <SettingsModal
          initial={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={(s) => setSettings(s)}
        />
      )}
    </div>
  )
}
