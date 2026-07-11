/**
 * Shared constants used by both the main and renderer processes.
 */

export const APP_NAME = 'Houston'

/** Secrets-store id under which the web-search (Tavily) API key is kept. */
export const WEB_SEARCH_KEY_ID = 'web-search'

/** Name of the tool that asks the user a structured question. Shared so the main
 * process, the loop, and the renderer agree on the one string. */
export const ASK_USER_TOOL = 'ask_user'

/** Name of the tool that presents a finished plan for review in Plan mode. Shared
 * so the main process, the loop, and the renderer agree on the one string. */
export const PRESENT_PLAN_TOOL = 'present_plan'

/** IPC channel names. Keep in one place so main + preload + renderer agree. */
export const IPC = {
  // App / system
  appGetVersion: 'app:getVersion',
  // Updates
  updateCheck: 'update:check',
  updateWhatsNew: 'update:whatsNew',
  updateAvailable: 'update:available',
  /** Main → renderer: the native menu's "Settings…" item was chosen — open the modal. */
  menuOpenSettings: 'menu:openSettings',
  // Workspace
  workspacePick: 'workspace:pick',
  directoryPick: 'directory:pick',
  workspaceListFiles: 'workspace:listFiles',
  /** One directory level for the Finder-like Files panel (lazy tree expansion). */
  workspaceListDir: 'workspace:listDir',
  /** Read a workspace file for the Files panel's in-app preview (text / image / note). */
  workspaceReadFile: 'workspace:readFile',
  /** Open a workspace file in its OS default app (from the Files panel). */
  workspaceOpenPath: 'workspace:openPath',
  /** Pick files in a native dialog and read their (capped) text contents — composer "+" menu. */
  attachmentPickFiles: 'attachment:pickFiles',
  /** Read the system clipboard (text + image) for the composer "+" menu. */
  clipboardRead: 'clipboard:read',
  commandsList: 'commands:list',
  gitRepoInfo: 'git:repoInfo',
  gitInit: 'git:init',
  workingTreeChanges: 'workingTree:changes',
  // Settings
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  settingsSetKey: 'settings:setKey',
  settingsDeleteKey: 'settings:deleteKey',
  settingsListModels: 'settings:listModels',
  /** Whether a local (Ollama) model supports tool calling — true / false / null (unknown). */
  ollamaSupportsTools: 'ollama:supportsTools',
  // Optional integrations status (gh CLI, formatters) — for the Settings UI hint.
  integrationsGet: 'integrations:get',
  // "Open project in…" — launch an external editor / reveal in the file manager.
  // A user gesture (not the agent); see main/openInEditor.ts.
  editorsList: 'editors:list',
  openInEditor: 'editor:open',
  revealInFileManager: 'fileManager:reveal',
  // Conversations
  conversationList: 'conversation:list',
  conversationSearch: 'conversation:search',
  conversationGet: 'conversation:get',
  conversationCreate: 'conversation:create',
  conversationFork: 'conversation:fork',
  conversationCompact: 'conversation:compact',
  conversationDelete: 'conversation:delete',
  conversationExport: 'conversation:export',
  conversationExportHtml: 'conversation:exportHtml',
  conversationImport: 'conversation:import',
  conversationOrganize: 'conversation:organize',
  conversationReorder: 'conversation:reorder',
  /** Aggregate a local-only per-model loop scorecard over every persisted chat. */
  conversationScorecard: 'conversation:scorecard',
  /** Main → renderer: a chat got a model-generated title (live sidebar/header update). */
  conversationTitleChanged: 'conversation:titleChanged',
  // Agent
  agentStart: 'agent:start',
  agentRetry: 'agent:retry',
  agentCancel: 'agent:cancel',
  agentApprove: 'agent:approve',
  agentRespondQuestion: 'agent:respondQuestion',
  /** Renderer → main: the user's decision on a present_plan review (accept / suggest / reject). */
  agentResolvePlan: 'agent:resolvePlan',
  agentSetPolicy: 'agent:setPolicy',
  /** Query the runId of the live run for a conversation (or null) to re-adopt it. */
  agentActiveRun: 'agent:activeRun',
  /** Query the prompts (approvals/questions) blocking a conversation's live run, to replay on re-adopt. */
  agentPendingPrompts: 'agent:pendingPrompts',
  /** Query the ids of every conversation with a live run (drives the sidebar "running" dot). */
  agentRunningList: 'agent:runningList',
  /** Main → renderer: the set of conversations with a live run changed (started/ended). */
  agentRunsChanged: 'agent:runsChanged',
  agentEvent: 'agent:event',
  /** Query the background shells (run_shell background mode) for the tasks indicator. */
  shellList: 'shell:list',
  /** Main → renderer: the background-shell registry changed (one started or exited). */
  shellsChanged: 'shell:changed',
  // Queued input (messages typed while a run is in progress)
  agentQueueAdd: 'agent:queue:add',
  agentQueueRemove: 'agent:queue:remove',
  agentQueueClear: 'agent:queue:clear',
  agentQueueList: 'agent:queue:list',
  // Dispatch a conversation's queued messages now (e.g. after Stop leaves them held).
  agentQueueFlush: 'agent:queue:flush',
  agentQueueChanged: 'agent:queue:changed',
  checkpointRestore: 'checkpoint:restore',
  checkpointReapply: 'checkpoint:reapply',
  /** Query a conversation's latest-run checkpoint (files + reverted) to restore the revert/redo UI on re-open. */
  checkpointGet: 'checkpoint:get',
  // Integrated terminal (PTY-backed; see main/terminal.ts)
  terminalCreate: 'terminal:create',
  terminalInput: 'terminal:input',
  terminalResize: 'terminal:resize',
  terminalKill: 'terminal:kill',
  /** Main → renderer: a chunk of terminal output (coalesced). */
  terminalData: 'terminal:data',
  /** Main → renderer: a terminal's shell exited. */
  terminalExit: 'terminal:exit',
  /** Renderer → main: terminal focus gained/lost (drives Cmd+W routing). */
  terminalFocusChanged: 'terminal:focusChanged',
  /** Main → renderer: Cmd+W while the terminal is focused — close the active tab. */
  terminalCloseActive: 'terminal:closeActive',
  // Live preview dock (started dev servers; see main/preview.ts)
  /** Renderer → main: list the dev servers detected from started background shells. */
  previewListServers: 'preview:listServers',
  /** Main → renderer: the set of detected servers changed (started / got a URL / exited). */
  previewServersChanged: 'preview:serversChanged',
  /** Renderer → main: reconcile the live preview panes to these specs (+ whether visible). */
  previewSync: 'preview:sync',
  /** Renderer → main: reload one preview pane. */
  previewReload: 'preview:reload',
  /** Renderer → main: open a loopback URL in the OS browser (validated loopback-only). */
  previewOpenExternal: 'preview:openExternal'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
