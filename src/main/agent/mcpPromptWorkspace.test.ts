import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppSettings, McpServerConfig } from '@shared/types'
import { loadProjectConfig, PROJECT_CONFIG } from './projectConfig'
import { workspaceMcpServerIds } from './mcpPromptWorkspace'

let workspace: string
beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'houston-mcp-prompts-')))
})
afterEach(() => rmSync(workspace, { recursive: true, force: true }))

const server = (id: string, enabled = true): McpServerConfig => ({ id, name: id, command: id, enabled }) as McpServerConfig
const settings = (over: Partial<AppSettings> = {}): AppSettings =>
  ({ mcpServers: [server('web'), server('off', false)], trustedFolders: [], ...over }) as unknown as AppSettings

function projectServers(): void {
  mkdirSync(join(workspace, '.houston'), { recursive: true })
  writeFileSync(join(workspace, PROJECT_CONFIG), JSON.stringify({ mcpServers: [{ id: 'db', command: 'db-server' }] }))
}

describe('workspaceMcpServerIds', () => {
  it("is the user's enabled servers plus a session's own", async () => {
    expect([...(await workspaceMcpServerIds(workspace, settings()))]).toEqual(['web'])
    expect([...(await workspaceMcpServerIds(workspace, settings(), [server('editor')]))]).toEqual(['web', 'run-editor'])
  })

  it("leaves out an untrusted folder's project servers", async () => {
    projectServers()
    expect([...(await workspaceMcpServerIds(workspace, settings()))]).toEqual(['web'])
  })

  it("adds a trusted folder's project servers under proj-", async () => {
    projectServers()
    const cfg = await loadProjectConfig(workspace)
    const trusted = settings({ trustedFolders: [{ path: workspace, decision: 'trusted', hash: cfg.elevatedHash, decidedAt: 0 }] })
    expect([...(await workspaceMcpServerIds(workspace, trusted))]).toEqual(['web', 'proj-db'])
  })
})
