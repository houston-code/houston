import type { WebPreferences } from 'electron'

/**
 * The main window's webPreferences. The renderer runs inside Chromium's process
 * sandbox with context isolation and no Node integration: everything it can ask of
 * the main process goes through the preload's `contextBridge` API over IPC. A
 * sandboxed preload may only require 'electron' (plus a few polyfilled modules), and
 * src/preload/index.ts needs nothing beyond `contextBridge`, `ipcRenderer` and
 * `webUtils`.
 */
export function mainWindowWebPreferences(preload: string): WebPreferences {
  return {
    preload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false
  }
}
