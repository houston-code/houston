import { describe, expect, it, vi } from 'vitest'
import { describePermissionPolicy, type PolicyDeps } from './permissionPolicy'
import type { ProjectConfig } from './agent/projectConfig'

const emptyProject: ProjectConfig = {
  permissionRules: [],
  elevated: { allowRules: [], hooks: [], mcpServers: [] },
  elevatedHash: ''
}

function deps(over: Partial<PolicyDeps> = {}): PolicyDeps {
  return {
    loadManaged: vi.fn(async () => ({ permissionRules: [] })),
    loadProject: vi.fn(async () => emptyProject),
    trustFor: vi.fn(() => 'undecided' as const),
    ...over
  }
}

describe('describePermissionPolicy', () => {
  it('reports the managed policy even with no project open', async () => {
    const d = deps({ loadManaged: async () => ({ permissionRules: [{ action: 'deny', tool: '*', match: '*' }] }) })
    expect(await describePermissionPolicy(null, d)).toEqual({
      managed: [{ action: 'deny', tool: '*', match: '*' }],
      project: null
    })
    expect(d.loadProject).not.toHaveBeenCalled()
  })

  it('reports no project section when the project config adds nothing', async () => {
    expect((await describePermissionPolicy('/repo', deps())).project).toBeNull()
  })

  it('lists project guardrails without a trust state when nothing elevates', async () => {
    const d = deps({
      loadProject: async () => ({ ...emptyProject, permissionRules: [{ action: 'ask', tool: 'run_shell', match: 'git push*' }] })
    })
    const view = await describePermissionPolicy('/repo', d)
    expect(view.project).toMatchObject({ rules: [{ action: 'ask', tool: 'run_shell', match: 'git push*' }], trust: 'none' })
    expect(d.trustFor).not.toHaveBeenCalled()
  })

  it('lists the elevating config with its trust state, and never the MCP secrets', async () => {
    const trustFor = vi.fn(() => 'trusted' as const)
    const view = await describePermissionPolicy(
      '/repo',
      deps({
        trustFor,
        loadProject: async () => ({
          permissionRules: [],
          elevated: {
            allowRules: [{ action: 'allow', tool: 'run_shell', match: 'npm test' }],
            hooks: [{ event: 'PostToolUse', matcher: 'edit_file', command: 'npm run fmt' }],
            mcpServers: [
              { id: 'db', command: 'npx', args: ['db-mcp'], enabled: true, env: { DB_PASSWORD: 'hunter2' } },
              { id: 'api', url: 'https://mcp.example/x', command: '', enabled: true, headers: { Authorization: 'Bearer s3cret' } }
            ]
          },
          elevatedHash: 'abc'
        })
      })
    )
    expect(trustFor).toHaveBeenCalledWith('/repo', 'abc')
    expect(view.project).toEqual({
      rules: [],
      allowRules: [{ action: 'allow', tool: 'run_shell', match: 'npm test' }],
      hooks: [{ event: 'PostToolUse', matcher: 'edit_file', command: 'npm run fmt' }],
      mcpServers: [
        { id: 'db', transport: 'stdio', target: 'npx db-mcp' },
        { id: 'api', transport: 'http', target: 'https://mcp.example/x' }
      ],
      trust: 'trusted'
    })
    expect(JSON.stringify(view)).not.toMatch(/hunter2|s3cret/)
  })
})
