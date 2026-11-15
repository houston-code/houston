import { describe, it, expect } from 'vitest'
import { makePainter } from './tui'
import { describeShellNetwork, renderStatus, summarizeMcp, type HostStatusFacts, type StatusView } from './tui-status'

const host = (over: Partial<HostStatusFacts> = {}): HostStatusFacts => ({
  installMethod: 'homebrew',
  sandbox: { backend: 'seatbelt', enforced: true },
  egressMode: 'allowlist',
  network: null,
  managed: null,
  ...over
})

const view = (over: Partial<StatusView> = {}): StatusView => ({
  version: '1.2.3',
  host: host(),
  provider: { id: 'anthropic', model: 'claude-x', name: 'Claude X' },
  effort: 'medium',
  policy: 'auto-edit',
  mcp: { configured: 0, statuses: [] },
  settingsPath: '/profile/settings.json',
  project: { exists: false, elevates: false, trust: 'undecided' },
  cost: '10+20 tok · $0.01',
  usageLimitWait: true,
  ...over
})

describe('describeShellNetwork', () => {
  it('says when this chat granted it, and where it goes', () => {
    const granted = { shellGranted: true, shellDecided: true, hosts: 0, shellHosts: 0 }
    expect(describeShellNetwork(granted, 'ask', 'allowlist')).toBe('on for this chat, to the egress allowlist')
    expect(describeShellNetwork(granted, 'ask', 'all')).toBe('on for this chat, to any domain')
  })

  it('is off once declined, even in full auto', () => {
    const declined = { shellGranted: false, shellDecided: true, hosts: 0, shellHosts: 0 }
    expect(describeShellNetwork(declined, 'full-auto', 'allowlist')).toBe('off: declined for this chat')
  })

  it('is on through the allowlist in full auto, and off otherwise until asked', () => {
    expect(describeShellNetwork(null, 'full-auto', 'allowlist')).toContain('on in full auto')
    // All domains has no proxy to bound it, so full auto still waits for a grant.
    expect(describeShellNetwork(null, 'full-auto', 'all')).toContain('off until you allow it')
    expect(describeShellNetwork(null, 'ask', 'allowlist')).toContain('off until you allow it')
  })
})

describe('summarizeMcp', () => {
  it('counts connected, failed, sign-in and not yet started', () => {
    expect(summarizeMcp({ configured: 0, statuses: [] })).toBe('none configured')
    expect(
      summarizeMcp({
        configured: 5,
        statuses: [{ state: 'connected' }, { state: 'connected' }, { state: 'error' }, { state: 'needs-auth' }]
      })
    ).toBe('2 connected, 1 failed, 1 needs sign-in, 1 not started yet')
    expect(summarizeMcp({ configured: 1, statuses: [{ state: 'connected' }] })).toBe('1 connected, 0 failed')
  })
})

describe('renderStatus', () => {
  const plain = makePainter(false)

  it('shows every item on its own label: value line', () => {
    const text = renderStatus(
      view({
        host: host({
          network: { shellGranted: true, shellDecided: true, hosts: 2, shellHosts: 1 },
          managed: { path: '/Library/Application Support/Houston/managed-settings.json', rules: 3 }
        }),
        mcp: { configured: 2, statuses: [{ state: 'connected' }, { state: 'error' }] },
        project: { exists: true, elevates: true, trust: 'trusted' }
      }),
      plain
    )
    expect(text).toMatch(/version:\s+Houston 1\.2\.3/)
    expect(text).toMatch(/installed with:\s+homebrew/)
    expect(text).toMatch(/model:\s+Claude X \(claude-x\), anthropic/)
    expect(text).toMatch(/thinking effort:\s+medium/)
    expect(text).toMatch(/approval:\s+auto-edit \(Auto-approve edits\)/)
    expect(text).toMatch(/sandbox:\s+seatbelt, enforced/)
    expect(text).toMatch(/shell network:\s+on for this chat/)
    expect(text).toMatch(/allowed hosts:\s+2 for network tools, 1 for shell commands/)
    expect(text).toMatch(/MCP servers:\s+1 connected, 1 failed/)
    expect(text).toMatch(/usage limits:\s+wait for the reset/)
    expect(renderStatus(view({ usageLimitWait: false }), plain)).toMatch(/usage limits:\s+stop the turn/)
    expect(text).toMatch(/user settings:\s+\/profile\/settings\.json/)
    expect(text).toMatch(/project settings:\s+present, trusted/)
    expect(text).toMatch(/managed policy:\s+.*managed-settings\.json \(3 rules\)/)
    expect(text).toMatch(/session cost:\s+10\+20 tok/)
  })

  it('says plainly what it could not find out', () => {
    const text = renderStatus(
      view({
        host: null,
        provider: null,
        settingsPath: null,
        project: null
      }),
      plain
    )
    expect(text).toMatch(/installed with:\s+unknown/)
    expect(text).toMatch(/model:\s+none \(run \/login\)/)
    expect(text).toMatch(/sandbox:\s+unknown/)
    expect(text).toMatch(/project settings:\s+none in this folder/)
    expect(text).toMatch(/managed policy:\s+none/)
  })

  it('names an unconfining sandbox and an untrusted project', () => {
    const text = renderStatus(
      view({
        host: host({ sandbox: { backend: 'none', enforced: false } }),
        project: { exists: true, elevates: true, trust: 'changed' }
      }),
      plain
    )
    expect(text).toContain('not confining')
    expect(text).toContain('changed since you trusted it')
    expect(renderStatus(view({ project: { exists: true, elevates: false, trust: 'undecided' } }), plain)).toContain(
      'guardrails only'
    )
  })

  it('with no color (screen-reader mode) has no escape sequences, and strips them from the facts', () => {
    const text = renderStatus(view({ settingsPath: '/p/\u001b[2Jsettings.json' }), plain)
    expect(text).not.toContain('\u001b')
    expect(text).not.toContain('—')
    for (const line of text.split('\n').slice(1, -1)) expect(line).toMatch(/^ {2}[A-Za-z ]+: /)
  })
})
