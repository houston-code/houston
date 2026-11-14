// Types for electron-fuses.mjs, imported by the e2e suite (e2e/fuses.ts).

export type FuseName =
  | 'RunAsNode'
  | 'EnableCookieEncryption'
  | 'EnableNodeOptionsEnvironmentVariable'
  | 'EnableNodeCliInspectArguments'
  | 'EnableEmbeddedAsarIntegrityValidation'
  | 'OnlyLoadAppFromAsar'
  | 'LoadBrowserProcessSpecificV8Snapshot'
  | 'GrantFileProtocolExtraPrivileges'

export const FUSE_INDEX: Record<FuseName, number>
export function fusesFor(electronPlatformName: string): Record<FuseName, boolean>
export function fuseConfigFor(electronPlatformName: string): Record<string, unknown>
export function flipFusesForPack(context: unknown): Promise<Record<string, unknown>>
