import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppSettings, ApprovalPolicy, SelectedModel } from '@shared/types'
import type { ConversationMeta } from '@shared/agent'
import { useChat } from './hooks/useChat'
import { itemsFromMessages } from './lib/items'
import { Sidebar } from './components/Sidebar'
import { Topbar } from './components/Topbar'
import { Transcript } from './components/Transcript'
import { Composer } from './components/Composer'
import { SettingsModal } from './components/SettingsModal'

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

  const currentConv = useMemo(
    () => conversations.find((c) => c.id === currentId) ?? null,
    [conversations, currentId]
  )
  const workspace = currentConv?.workspace ?? lastWorkspace

  const selectConversation = useCallback(
    async (id: string) => {
      const conv = await window.api.getConversation(id)
      if (!conv) return
      setCurrentId(id)
      setLastWorkspace(conv.workspace)
      chat.reset(itemsFromMessages(conv.messages))
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

  const onSend = useCallback(
    async (text: string) => {
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
        providerId: settings.selected.providerId,
        model: settings.selected.model,
        approvalPolicy: settings.approvalPolicy
      })
      void refreshConversations()
    },
    [settings, workspace, currentId, chat, refreshConversations]
  )

  if (!settings) {
    return <div className="loading">Loading…</div>
  }

  // The composer is usable only when the *selected* provider is actually ready —
  // it doesn't require a key, or it has a usable one. Otherwise sending would fail
  // in the agent loop with "No API key set"; instead we disable input and the
  // Topbar shows its "⚠︎ Set API key" prompt.
  const selectedProvider = settings.providers.find((p) => p.id === settings.selected?.providerId)
  const selectionReady = Boolean(
    selectedProvider && (!selectedProvider.requiresKey || selectedProvider.hasKey)
  )
  const canChat = Boolean(settings.selected && workspace && selectionReady)

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        currentId={currentId}
        onSelect={selectConversation}
        onNew={onNewChat}
        onDelete={onDeleteConversation}
        onExport={onExportConversation}
        onImport={onImportConversation}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="main">
        <Topbar
          settings={settings}
          selected={settings.selected}
          workspace={workspace}
          onSelectModel={onSelectModel}
          onChangePolicy={onChangePolicy}
          onChangeWorkspace={onChangeWorkspace}
          onOpenSettings={() => setSettingsOpen(true)}
        />

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

        <Composer disabled={!canChat} running={chat.running} onSend={onSend} onCancel={chat.cancel} />
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
