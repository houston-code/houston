/**
 * Shared constants used by both the main and renderer processes.
 */

export const APP_NAME = 'Houston'

/** Secrets-store id under which the web-search (Tavily) API key is kept. */
export const WEB_SEARCH_KEY_ID = 'web-search'

/** Name of the tool that asks the user a structured question. Shared so the main
 * process, the loop, and the renderer agree on the one string. */
export const ASK_USER_TOOL = 'ask_user'

/** IPC channel names. Keep in one place so main + preload + renderer agree. */
export const IPC = {
  // App / system
  appGetVersion: 'app:getVersion',
  // Updates
  updateCheck: 'update:check',
  updateWhatsNew: 'update:whatsNew',
  updateAvailable: 'update:available',
  // Workspace
  workspacePick: 'workspace:pick',
  directoryPick: 'directory:pick',
  workspaceListFiles: 'workspace:listFiles',
  commandsList: 'commands:list',
  gitRepoInfo: 'git:repoInfo',
  workingTreeChanges: 'workingTree:changes',
  // Settings
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  settingsSetKey: 'settings:setKey',
  settingsDeleteKey: 'settings:deleteKey',
  settingsListModels: 'settings:listModels',
  // Optional integrations status (gh CLI, formatters) — for the Settings UI hint.
  integrationsGet: 'integrations:get',
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
  /** Main → renderer: a chat got a model-generated title (live sidebar/header update). */
  conversationTitleChanged: 'conversation:titleChanged',
  // Agent
  agentStart: 'agent:start',
  agentRetry: 'agent:retry',
  agentCancel: 'agent:cancel',
  agentApprove: 'agent:approve',
  agentRespondQuestion: 'agent:respondQuestion',
  agentSetPolicy: 'agent:setPolicy',
  /** Query the runId of the live run for a conversation (or null) to re-adopt it. */
  agentActiveRun: 'agent:activeRun',
  agentEvent: 'agent:event',
  // Queued input (messages typed while a run is in progress)
  agentQueueAdd: 'agent:queue:add',
  agentQueueRemove: 'agent:queue:remove',
  agentQueueClear: 'agent:queue:clear',
  agentQueueList: 'agent:queue:list',
  agentQueueChanged: 'agent:queue:changed',
  checkpointRestore: 'checkpoint:restore',
  checkpointReapply: 'checkpoint:reapply',
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
  terminalCloseActive: 'terminal:closeActive'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
