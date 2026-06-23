/**
 * Shared constants used by both the main and renderer processes.
 */

export const APP_NAME = 'Houston'

/** Secrets-store id under which the web-search (Tavily) API key is kept. */
export const WEB_SEARCH_KEY_ID = 'web-search'

/** IPC channel names. Keep in one place so main + preload + renderer agree. */
export const IPC = {
  // App / system
  appGetVersion: 'app:getVersion',
  // Workspace
  workspacePick: 'workspace:pick',
  workspaceListFiles: 'workspace:listFiles',
  commandsList: 'commands:list',
  // Settings
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  settingsSetKey: 'settings:setKey',
  settingsDeleteKey: 'settings:deleteKey',
  settingsListModels: 'settings:listModels',
  // Conversations
  conversationList: 'conversation:list',
  conversationGet: 'conversation:get',
  conversationCreate: 'conversation:create',
  conversationDelete: 'conversation:delete',
  conversationExport: 'conversation:export',
  conversationImport: 'conversation:import',
  // Agent
  agentStart: 'agent:start',
  agentCancel: 'agent:cancel',
  agentApprove: 'agent:approve',
  agentEvent: 'agent:event'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
