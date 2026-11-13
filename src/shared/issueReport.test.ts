import { describe, expect, it } from 'vitest'
import type { DoctorFacts } from './doctor'
import { issueReportBody, issueReportUrl } from './issueReport'

const SECRET = 'sk-ant-api03-secretvalue'

function facts(over: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    version: '1.2.3',
    nodeVersion: 'v22.1.0',
    platform: 'darwin arm64',
    cwd: '/home/someone/private-project',
    settingsPath: '/home/someone/.config/Houston/settings.json',
    sandbox: { backend: 'seatbelt', enforced: true },
    providers: [
      { id: 'anthropic', requiresKey: true, hasKey: true, shadowedByEnv: 'ANTHROPIC_API_KEY' },
      { id: 'openai', requiresKey: true, hasKey: false },
      { id: 'acme-internal-gateway', requiresKey: true, hasKey: true }
    ],
    active: { providerId: 'acme-internal-gateway', model: 'secret-model-x' },
    mcp: [
      { id: 'my-company-jira', state: 'connected', detail: 'connected, 3 tools' },
      { id: 'other', state: 'error', detail: `failed at /home/someone/x with ${SECRET}` }
    ],
    binaries: [
      { name: 'git', path: '/usr/bin/git', purpose: 'git' },
      { name: 'rg', path: null, purpose: 'search' }
    ],
    update: null,
    languageServers: [
      { id: 'my-own-lsp', name: 'Mine', path: '/home/someone/bin/lsp', usedByProject: true, installHint: 'x' }
    ],
    ...over
  }
}

describe('issueReportBody', () => {
  const body = issueReportBody(facts())

  it('starts with prompts for the user, then version, platform and the checks', () => {
    expect(body.startsWith('### What happened?')).toBe(true)
    expect(body).toContain('- Houston 1.2.3')
    expect(body).toContain('- Platform: darwin arm64')
    expect(body).toContain('- Node: v22.1.0')
    expect(body).toContain('- Sandbox: shell sandbox ok')
    expect(body).toContain('- Tools: git ok, rg warn')
    expect(body).toContain('anthropic warn, openai warn')
  })

  it('carries no detail text, paths, keys, or names the user chose', () => {
    for (const leak of [
      '/home/someone',
      'private-project',
      'settings.json',
      SECRET,
      'ANTHROPIC_API_KEY',
      'acme-internal-gateway',
      'secret-model-x',
      'my-company-jira',
      'my-own-lsp',
      '/usr/bin/git'
    ]) {
      expect(body, leak).not.toContain(leak)
    }
  })

  it('counts user-named checks instead of naming them', () => {
    expect(body).toContain('other providers: 1 ok')
    expect(body).toContain('- MCP: 1 ok, 1 fail')
    expect(body).toContain('- Language servers: 1 ok')
  })
})

describe('issueReportUrl', () => {
  it('puts the body in the query string, encoded', () => {
    const url = issueReportUrl('https://github.com/o/r/issues/new', 'a b\n&c')
    expect(url).toBe('https://github.com/o/r/issues/new?body=a%20b%0A%26c')
  })
})
