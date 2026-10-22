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

/** Name of the tool that proposes a parallel session as a card the user starts. Shared
 * so the main process, the loop, and the renderer agree on the one string. */
export const PROPOSE_SESSION_TOOL = 'propose_session'

/** IPC channel names. Keep in one place so main + preload + renderer agree. */
export const IPC = {
  // App / system
  appGetVersion: 'app:getVersion',
  /** Gather the /doctor health facts (sandbox, provider keys, MCP, binaries). */
  doctorFacts: 'app:doctorFacts',
  /** Save a `#`-captured standing instruction to AGENTS.md (project or global). */
  memorySave: 'app:memorySave',
  /** Whether to show the one-time "global rules moved to ~/.houston/AGENTS.md" notice. */
  legacyRulesNoticeStatus: 'app:legacyRulesNoticeStatus',
  /** Answer that notice: import ~/.claude/CLAUDE.md, or keep the rules separate. */
  legacyRulesNoticeDecide: 'app:legacyRulesNoticeDecide',
  // Updates
  updateCheck: 'update:check',
  updateWhatsNew: 'update:whatsNew',
  updateAvailable: 'update:available',
  /** Main → renderer: in-place update download progress (signed macOS auto-update). */
  updateDownloadProgress: 'update:downloadProgress',
  /** Main → renderer: an update finished downloading and is ready to install. */
  updateDownloaded: 'update:downloaded',
  /** Main → renderer: macOS refused to install a downloaded update; offer a manual download. */
  updateInstallFailed: 'update:installFailed',
  /** Renderer → main: install the downloaded update now (quit, apply, relaunch). */
  updateInstall: 'update:install',
  /** Renderer → main: cancel the background download (the banner's close button). */
  updateCancelDownload: 'update:cancelDownload',
  /** Main → renderer: the native menu's "Settings…" item was chosen — open the modal. */
  menuOpenSettings: 'menu:openSettings',
  /** Main → renderer: a native File-menu command was chosen (see MenuCommand). */
  menuCommand: 'menu:command',
  /** Renderer → main: UI state the native menu depends on (see MenuState). */
  menuState: 'menu:state',
  /** Renderer → main: share Houston (macOS share menu, else copy the invite). */
  shareHouston: 'share:houston',
  /** Renderer → main: run a fixed share action (copy the invite, or email it). */
  shareVia: 'share:via',
  /** Renderer → main: share with native confirmation (command palette; same as the menu item). */
  shareFromMenu: 'share:fromMenu',
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
  /** Put an image from the image viewer on the system clipboard. */
  imageCopy: 'image:copy',
  /** Save an image from the image viewer to a file the user picks. */
  imageSave: 'image:save',
  /** Render a Mermaid diagram to SVG in the main process's locked-down renderer. */
  visualMermaid: 'visual:mermaid',
  /** Keep an interactive HTML visual for its sandboxed frame to load; returns its id. */
  visualRegisterHtml: 'visual:registerHtml',
  commandsList: 'commands:list',
  /** List the workspace's skills (.houston/skills) as {name, description}, for /skills. */
  skillsList: 'skills:list',
  /** List the workspace's custom agents (.houston/agents) as {name, description}, for /agents. */
  agentsList: 'agents:list',
  gitRepoInfo: 'git:repoInfo',
  gitInit: 'git:init',
  /** Whether the user opted out of the first-write git-init prompt for a folder. */
  gitInitDismissed: 'git:initDismissed',
  /** Persist "don't ask again" for the first-write git-init prompt (per folder). */
  gitInitDismiss: 'git:initDismiss',
  /** Trust state + elevating-config counts for a workspace (drives the trust banner). */
  folderTrustStatus: 'folderTrust:status',
  /** Persist the user's trust decision for a workspace ('trusted' | 'never'). */
  folderTrustDecide: 'folderTrust:decide',
  workingTreeChanges: 'workingTree:changes',
  // Settings
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  // Tidy a permission-rule list (re-generalize + dedupe) for the "Clean up rules" action.
  permissionsCleanup: 'permissions:cleanup',
  /** The managed policy + open project's permission config, read-only for Settings. */
  permissionsPolicy: 'permissions:policy',
  /** Test one call against every permission tier (Settings' rule tester). */
  permissionsTest: 'permissions:test',
  /** When each permission rule last decided a call. */
  permissionsUsage: 'permissions:usage',
  /** Write a preferences export to a file the user picks. */
  settingsExportFile: 'settings:exportFile',
  /** Read a preferences export from a file the user picks. */
  settingsImportFile: 'settings:importFile',
  settingsSetKey: 'settings:setKey',
  settingsDeleteKey: 'settings:deleteKey',
  settingsListModels: 'settings:listModels',
  /** Whether the OS secure store (Keychain etc.) can hold credentials right now. */
  secureStorageStatus: 'secrets:status',
  /** Relaunch Houston (confirming if work is running), e.g. to re-prompt for Keychain access. */
  appRelaunch: 'app:relaunch',
  /** Check a candidate API key with a live model listing, without storing it. */
  settingsTestKey: 'settings:testKey',
  /** Whether a local (Ollama) model supports tool calling — true / false / null (unknown). */
  ollamaSupportsTools: 'ollama:supportsTools',
  // MCP: remote-server OAuth sign-in/out + live connection status (Settings UI).
  mcpOAuthLogin: 'mcp:oauthLogin',
  mcpOAuthLogout: 'mcp:oauthLogout',
  mcpStatus: 'mcp:status',
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
  conversationSetSettings: 'conversation:setSettings',
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
  /** Renderer → main: the user's answer to an MCP elicitation (accept/decline/cancel). */
  agentRespondElicitation: 'agent:respondElicitation',
  /** Renderer → main: the user's decision on a present_plan review (accept / suggest / reject). */
  agentResolvePlan: 'agent:resolvePlan',
  agentSetPolicy: 'agent:setPolicy',
  agentSetEffort: 'agent:setEffort',
  /** Renderer → main: a course correction for the live run, injected before its next step. */
  agentSteer: 'agent:steer',
  /** Query the runId of the live run for a conversation (or null) to re-adopt it. */
  agentActiveRun: 'agent:activeRun',
  /** Query the prompts (approvals/questions) blocking a conversation's live run, to replay on re-adopt. */
  agentPendingPrompts: 'agent:pendingPrompts',
  /** Query the live run's streamed-but-unpersisted transcript, to replay on re-adopt (mid-turn re-open). */
  agentLiveTranscript: 'agent:liveTranscript',
  /** Query the ids of every conversation with a live run (drives the sidebar "running" dot). */
  agentRunningList: 'agent:runningList',
  /** Main → renderer: the set of conversations with a live run changed (started/ended). */
  agentRunsChanged: 'agent:runsChanged',
  agentEvent: 'agent:event',
  // Session proposals (propose_session cards)
  /** Renderer → main: start a proposed session as its own chat. */
  proposalStart: 'proposal:start',
  /** Renderer → main: record "do it here" or "dismiss" on a proposal card. */
  proposalSetState: 'proposal:setState',
  // Side chat (a read-only aside about the open conversation, persisted per chat)
  sideChatAsk: 'sideChat:ask',
  /** Query a chat's side chat: its stored exchanges and the one in flight. */
  sideChatGet: 'sideChat:get',
  sideChatCancel: 'sideChat:cancel',
  /** Renderer → main: start the chat's side chat over (forget its exchanges). */
  sideChatClear: 'sideChat:clear',
  /** Main → renderer: a chat's side chat changed (asked, progressed, answered, cleared). */
  sideChatChanged: 'sideChat:changed',
  /** Query the background shells (run_shell background mode) for the tasks indicator. */
  shellList: 'shell:list',
  /** Main → renderer: the background-shell registry changed (one started or exited). */
  shellsChanged: 'shell:changed',
  /** Renderer → main: stop a background shell (or what it left running) from the Tasks panel. */
  shellStop: 'shell:stop',
  /** Renderer → main: the last lines a background shell printed, secrets masked. */
  shellTail: 'shell:tail',
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
  /** Rewind to an earlier user message (see main/agent/rewind.ts): preview, apply, undo. */
  rewindPreview: 'rewind:preview',
  rewindApply: 'rewind:apply',
  rewindUndo: 'rewind:undo',
  rewindCanUndo: 'rewind:can-undo',
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
