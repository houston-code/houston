/**
 * Shared constants used by both the main and renderer processes.
 */

export const APP_NAME = 'Coder Pro'

/** IPC channel names. Keep in one place so main + preload + renderer agree. */
export const IPC = {
  // App / system
  appGetVersion: 'app:getVersion',
  // Workspace
  workspacePick: 'workspace:pick'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
