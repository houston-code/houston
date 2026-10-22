import { describe, expect, it, vi } from 'vitest'
import { describePermissionPolicy, testPermission, type PolicyDeps } from './permissionPolicy'
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

describe('testPermission', () => {
  const base = { workspace: null, userRules: [], tool: 'run_shell', subject: 'git status', additionalRoots: [] }

  it('falls through to the approval mode when no rule matches', async () => {
    expect(await testPermission(base, deps())).toEqual({ decision: null, tier: null, userMatches: [] })
  })

  it("reports the user's rule that decides, by index, with every user rule that matches", async () => {
    const res = await testPermission(
      {
        ...base,
        userRules: [
          { action: 'deny', tool: 'web_fetch', match: '*' },
          { action: 'allow', tool: 'run_shell', match: 'git *' },
          { action: 'ask', tool: 'run_shell', match: '*' }
        ]
      },
      deps()
    )
    expect(res).toEqual({ decision: 'allow', tier: 'user', userMatches: [1, 2] })
  })

  it('lets the admin tier and then project guardrails decide ahead of the user', async () => {
    const userRules = [{ action: 'allow' as const, tool: 'run_shell', match: '*' }]
    const managed = await testPermission(
      { ...base, userRules },
      deps({ loadManaged: async () => ({ permissionRules: [{ action: 'deny', tool: 'run_shell', match: 'git *' }] }) })
    )
    expect(managed).toMatchObject({ decision: 'deny', tier: 'managed', userMatches: [0] })
    const project = await testPermission(
      { ...base, workspace: '/repo', userRules },
      deps({
        loadProject: async () => ({ ...emptyProject, permissionRules: [{ action: 'ask', tool: 'run_shell', match: 'git *' }] })
      })
    )
    expect(project).toMatchObject({ decision: 'ask', tier: 'project' })
  })

  it("applies a project's allow rules only when the folder is trusted, and after the user's", async () => {
    const projectWithAllow = async (): Promise<ProjectConfig> => ({
      ...emptyProject,
      elevated: { ...emptyProject.elevated, allowRules: [{ action: 'allow', tool: 'run_shell', match: 'git *' }] },
      elevatedHash: 'h'
    })
    const untrusted = await testPermission({ ...base, workspace: '/repo' }, deps({ loadProject: projectWithAllow }))
    expect(untrusted.decision).toBeNull()
    const trusted = await testPermission(
      { ...base, workspace: '/repo' },
      deps({ loadProject: projectWithAllow, trustFor: () => 'trusted' })
    )
    expect(trusted).toMatchObject({ decision: 'allow', tier: 'project-allow' })
    const userFirst = await testPermission(
      { ...base, workspace: '/repo', userRules: [{ action: 'deny', tool: 'run_shell', match: 'git *' }] },
      deps({ loadProject: projectWithAllow, trustFor: () => 'trusted' })
    )
    expect(userFirst).toMatchObject({ decision: 'deny', tier: 'user' })
  })

  it('resolves a compound shell command as the gate does: one denied part denies it', async () => {
    const res = await testPermission(
      {
        ...base,
        subject: 'git status && rm -rf build',
        userRules: [
          { action: 'allow', tool: 'run_shell', match: 'git *' },
          { action: 'deny', tool: 'run_shell', match: 'rm *' }
        ]
      },
      deps()
    )
    expect(res.decision).toBe('deny')
    expect(res.tier).toBe('user')
  })

  it('ignores malformed user rules rather than throwing', async () => {
    const res = await testPermission(
      {
        ...base,
        userRules: [
          { action: 'nope', tool: 'run_shell', match: '*' } as never,
          null as never,
          { action: 'ask', tool: 'run_shell', match: 'git *' }
        ]
      },
      deps()
    )
    // Indices stay those of the given list.
    expect(res).toEqual({ decision: 'ask', tier: 'user', userMatches: [2] })
  })
})
