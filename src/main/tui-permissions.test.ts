import { describe, it, expect, vi } from 'vitest'
import { permissionRuleKey, type AppSettings, type PermissionPolicyView, type PermissionRule } from '@shared/types'
import { makePainter, parseSlashCommand } from './tui'
import {
  forgetTrustAt,
  parsePermissionsArgs,
  renderPermissionsView,
  renderTrustList,
  runPermissionsCommand,
  type PermissionsCommandDeps
} from './tui-permissions'

const paint = makePainter(false)
const DAY = 86_400_000
const NOW = 100 * DAY

function harness(rules: PermissionRule[], answers: Array<string | null> = [], over: Partial<PermissionsCommandDeps> = {}) {
  const settings = { permissionRules: rules } as AppSettings
  const out: string[] = []
  const lines = [...answers]
  const deps: PermissionsCommandDeps = {
    getSettings: () => settings,
    updateSettings: vi.fn((patch: Partial<AppSettings>) => Object.assign(settings, patch)),
    readLine: vi.fn(async () => (lines.length ? (lines.shift() as string | null) : null)),
    now: () => NOW,
    out: (t) => out.push(t),
    ...over
  }
  const run = (arg: string) => runPermissionsCommand(parsePermissionsArgs(arg), deps, paint)
  return { settings, deps, run, text: () => out.join('') }
}

describe('parsePermissionsArgs', () => {
  it('reads list, remove n, and add with the desktop editor\'s validation', () => {
    expect(parsePermissionsArgs('')).toEqual({ op: 'list' })
    expect(parsePermissionsArgs('rm 2')).toEqual({ op: 'remove', index: 2 })
    expect(parsePermissionsArgs('add deny run_shell git push *')).toEqual({
      op: 'add',
      rule: { action: 'deny', tool: 'run_shell', match: 'git push *' }
    })
    expect(parsePermissionsArgs('add Allow web_fetch https://docs.example/x --exact')).toEqual({
      op: 'add',
      rule: { action: 'allow', tool: 'web_fetch', match: 'https://docs.example/x', exact: true }
    })
  })
  it('refuses a bad action, a missing pattern, and a bad number', () => {
    expect(parsePermissionsArgs('add permit run_shell ls')).toEqual({
      op: 'usage',
      error: 'The rule needs "action": "allow", "ask", or "deny".'
    })
    expect(parsePermissionsArgs('add allow run_shell')).toMatchObject({ op: 'usage', error: expect.stringContaining('pattern') })
    expect(parsePermissionsArgs('remove 0')).toEqual({ op: 'usage' })
    expect(parsePermissionsArgs('remove two')).toEqual({ op: 'usage' })
  })
  it('is what /permissions parses to', () => {
    expect(parseSlashCommand('/permissions remove 1', {} as AppSettings)).toEqual({
      kind: 'permissions',
      op: { op: 'remove', index: 1 }
    })
  })
})

describe('/permissions list', () => {
  const policy: PermissionPolicyView = {
    managed: [{ action: 'deny', tool: 'run_shell', match: 'curl *' }],
    project: {
      rules: [{ action: 'ask', tool: 'write_file', match: 'migrations/**' }],
      allowRules: [{ action: 'allow', tool: 'run_shell', match: 'npm test' }],
      hooks: [],
      mcpServers: [],
      plugins: [],
      trust: 'undecided'
    }
  }

  it('shows every tier in the order they are checked, labeling the read-only ones', () => {
    const user: PermissionRule = { action: 'allow', tool: 'run_shell', match: 'git status', addedAt: NOW - 3 * DAY, source: 'prompt' }
    const text = renderPermissionsView([user], policy, { [permissionRuleKey(user)]: NOW - DAY }, paint, NOW)
    const order = ['Administrator policy (read-only)', 'curl *', "This project's guardrails", 'migrations/**', 'Your rules', 'git status', "This project's allow rules", 'npm test', 'approval mode']
    let at = -1
    for (const piece of order) {
      const next = text.indexOf(piece)
      expect(next, piece).toBeGreaterThan(at)
      at = next
    }
    expect(text).toContain('not trusted yet, so they are off')
    expect(text).toContain('added 3 days ago from an approval prompt, last used yesterday')
    expect(text).toMatch(/ {3}1\. allow run_shell/)
  })

  it('flags rules that can never apply or approve everything', () => {
    const rules: PermissionRule[] = [
      { action: 'deny', tool: 'run_shell', match: '*' },
      { action: 'allow', tool: 'run_shell', match: 'ls' },
      { action: 'allow', tool: '*', match: '*' }
    ]
    const text = renderPermissionsView(rules, null, {}, paint, NOW)
    expect(text).toContain('! Never applies: rule 1 (deny run_shell *) matches it, and a deny always wins.')
    expect(text).toContain('! Approves every tool call without asking.')
    expect(text).toContain('rules need attention')
  })

  it('reads the policy and usage through its deps, and survives either failing', async () => {
    const h = harness([], [], {
      policy: vi.fn(async () => Promise.reject(new Error('bad file'))),
      ruleUsage: () => {
        throw new Error('bad usage')
      }
    })
    await h.run('')
    expect(h.text()).toContain('Your rules')
    const ok = harness([], [], { policy: async () => policy })
    await ok.run('')
    expect(ok.text()).toContain('curl *')
  })

  it('strips control characters from rules a project wrote', () => {
    const text = renderPermissionsView([], { managed: [], project: { ...policy.project!, rules: [{ action: 'ask', tool: 'x\u001b[2J', match: 'y\u0007' }] } }, {}, paint, NOW)
    expect(text).not.toContain('\u001b')
    expect(text).not.toContain('\u0007')
  })
})

describe('/permissions add and remove', () => {
  it('adds a rule last, stamped as added in Settings, and shows its lint', async () => {
    const existing: PermissionRule = { action: 'deny', tool: 'run_shell', match: 'git push *' }
    const h = harness([existing])
    await h.run('add allow run_shell git push *')
    expect(h.settings.permissionRules).toEqual([existing, { action: 'allow', tool: 'run_shell', match: 'git push *', addedAt: NOW, source: 'settings' }])
    expect(h.text()).toContain('! Never applies: rule 1')
    expect(h.text()).toContain('added as rule 2')
  })
  it('asks before saving an allow that approves everything', async () => {
    const no = harness([], ['n'])
    await no.run('add allow * *')
    expect(no.deps.updateSettings).not.toHaveBeenCalled()
    expect(no.text()).toContain('not saved')
    const yes = harness([], ['y'])
    await yes.run('add allow run_shell *')
    expect(yes.settings.permissionRules).toHaveLength(1)
  })
  it('removes one by number and refuses one that is not there', async () => {
    const h = harness([{ action: 'allow', tool: 'run_shell', match: 'ls', exact: true }])
    await h.run('remove 2')
    expect(h.text()).toContain('no rule 2')
    await h.run('remove 1')
    expect(h.settings.permissionRules).toEqual([])
    expect(h.text()).toContain('removed: allow run_shell ls (exact)')
  })
  it('prints the validation error and the usage', async () => {
    const h = harness([])
    await h.run('add maybe run_shell ls')
    expect(h.text()).toContain('The rule needs "action"')
    expect(h.deps.updateSettings).not.toHaveBeenCalled()
  })
})

describe('/trust list and forget <n>', () => {
  const settings = {
    trustedFolders: [
      { path: '/work/a', decision: 'trusted', hash: 'h1', decidedAt: NOW },
      { path: '/work/b', decision: 'never', hash: 'h2', decidedAt: NOW }
    ]
  } as AppSettings

  it('numbers every decision', () => {
    const text = renderTrustList(settings, paint)
    expect(text).toContain(' 1. trusted  /work/a')
    expect(text).toContain(' 2. never    /work/b')
    expect(renderTrustList({} as AppSettings, paint)).toContain('no folder decisions yet')
  })
  it('forgets one by number', () => {
    const s = { ...settings }
    const out: string[] = []
    const updateSettings = vi.fn((patch: Partial<AppSettings>) => Object.assign(s, patch))
    forgetTrustAt(2, { getSettings: () => s, updateSettings, out: (t) => out.push(t) }, paint)
    expect(s.trustedFolders?.map((r) => r.path)).toEqual(['/work/a'])
    forgetTrustAt(5, { getSettings: () => s, updateSettings, out: (t) => out.push(t) }, paint)
    expect(out.join('')).toContain('no decision 5')
  })
  it('is what /trust list and /trust forget <n> parse to', () => {
    expect(parseSlashCommand('/trust list', {} as AppSettings)).toEqual({ kind: 'trust', op: 'list' })
    expect(parseSlashCommand('/trust forget 2', {} as AppSettings)).toEqual({ kind: 'trust', op: 'forget', index: 2 })
    expect(parseSlashCommand('/trust forget', {} as AppSettings)).toEqual({ kind: 'trust', op: 'forget' })
  })
})
