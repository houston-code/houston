import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IPC } from '@shared/constants'
import type { AppSettings } from '@shared/types'
import type { AgentEvent, AgentStartRequest, ToolApprovalDecision } from '@shared/agent'

/**
 * The bridge object exposed to the renderer as `window.api`.
 * Everything the UI is allowed to ask the main process to do passes through here.
 */
const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke(IPC.appGetVersion),
  pickWorkspace: (): Promise<string | null> => ipcRenderer.invoke(IPC.workspacePick),

  // Settings
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
  saveSettings: (next: AppSettings): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.settingsSave, next),
  setKey: (providerId: string, key: string): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.settingsSetKey, providerId, key),
  deleteKey: (providerId: string): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.settingsDeleteKey, providerId),
  listModels: (providerId: string): Promise<string[]> =>
    ipcRenderer.invoke(IPC.settingsListModels, providerId),

  // Agent
  startAgent: (req: AgentStartRequest): Promise<void> => ipcRenderer.invoke(IPC.agentStart, req),
  cancelAgent: (runId: string): Promise<void> => ipcRenderer.invoke(IPC.agentCancel, runId),
  approveTool: (runId: string, callId: string, decision: ToolApprovalDecision): Promise<void> =>
    ipcRenderer.invoke(IPC.agentApprove, runId, callId, decision),
  /** Subscribe to streamed agent events. Returns an unsubscribe function. */
  onAgentEvent: (cb: (e: AgentEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: AgentEvent): void => cb(payload)
    ipcRenderer.on(IPC.agentEvent, listener)
    return () => ipcRenderer.removeListener(IPC.agentEvent, listener)
  }
}

export type CoderApi = typeof api

// The app always runs with contextIsolation enabled.
contextBridge.exposeInMainWorld('api', api)
