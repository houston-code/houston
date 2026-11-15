import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { permissionRuleKey, type PermissionRule } from '@shared/types'
import { cliDaemonCommand, selectRunMode, stableLauncherPath, wireCliHost } from './run'
import { noteRuleUsed } from '../main/agentHost'
import { flushRuleUsage, resetRuleUsageForTests } from '../main/ruleUsage'

describe('cliDaemonCommand', () => {
  it('records Homebrew kegs through their stable links, so an upgrade does not strand the login agent', () => {
    const links = new Set(['/opt/homebrew/opt/node@22/bin/node', '/opt/homebrew/opt/houston/libexec/houston-cli.cjs'])
    const cmd = cliDaemonCommand({
      execPath: '/opt/homebrew/Cellar/node@22/22.23.4/bin/node',
      script: '/opt/homebrew/bin/houston',
      realpath: () => '/opt/homebrew/Cellar/houston/0.9.0/libexec/houston-cli.cjs',
      env: { HOUSTON_DATA_DIR: '/p' },
      exists: (p) => links.has(p)
    })
    expect(cmd).toEqual({
      program: '/opt/homebrew/opt/node@22/bin/node',
      args: ['/opt/homebrew/opt/houston/libexec/houston-cli.cjs', 'schedule-daemon', 'run'],
      env: { HOUSTON_DATA_DIR: '/p' },
      logFile: join('/p', 'schedule-daemon.out.log')
    })
  })

  it('keeps any other path, and a keg whose link is missing, as it is', () => {
    expect(stableLauncherPath('/usr/local/bin/node', () => true)).toBe('/usr/local/bin/node')
    expect(stableLauncherPath('/home/u/.nvm/versions/node/v22.1.0/bin/node', () => true)).toBe(
      '/home/u/.nvm/versions/node/v22.1.0/bin/node'
    )
    expect(stableLauncherPath('/usr/local/Cellar/node/26.1.0/bin/node', () => false)).toBe('/usr/local/Cellar/node/26.1.0/bin/node')
    expect(stableLauncherPath('/home/linuxbrew/.linuxbrew/Cellar/node/26.1.0/bin/node', () => true)).toBe(
      '/home/linuxbrew/.linuxbrew/opt/node/bin/node'
    )
  })
})

describe('selectRunMode', () => {
  const tty = (argv: string[]) => selectRunMode(argv, '/cwd', true)
  const piped = (argv: string[]) => selectRunMode(argv, '/cwd', false)

  it('serves ACP on --acp, ahead of every other mode, piped stdin or not', () => {
    expect(piped(['--acp']).kind).toBe('acp')
    expect(selectRunMode(['--acp'], '/cwd', false, true).kind).toBe('acp')
    expect(tty(['--acp', '-i']).kind).toBe('acp')
    expect(tty(['--acp', '-p', 'x']).kind).toBe('acp')
  })

  it('runs interactive on explicit -i / --interactive / --tui, TTY or not', () => {
    expect(tty(['-i']).kind).toBe('tui')
    expect(piped(['--interactive']).kind).toBe('tui')
    expect(piped(['--tui']).kind).toBe('tui')
  })

  it('runs headless on -p, and -p wins even at a TTY', () => {
    expect(tty(['-p', 'do it']).kind).toBe('headless')
    expect(piped(['-p', 'do it']).kind).toBe('headless')
  })

  it('a bare invocation at a TTY defaults to interactive', () => {
    const mode = tty([])
    expect(mode.kind).toBe('tui')
    // Flags on a bare invocation are still honored in the defaulted interactive mode.
    expect(selectRunMode(['--model=gpt'], '/cwd', true)).toMatchObject({
      kind: 'tui',
      options: { model: 'gpt' }
    })
  })

  it('a bare invocation without a TTY falls to usage (no REPL to hang)', () => {
    expect(piped([]).kind).toBe('usage')
  })

  it('a bare invocation with a prompt piped in runs headless, reading it from stdin', () => {
    expect(selectRunMode([], '/cwd', false, true)).toMatchObject({
      kind: 'headless',
      options: { prompt: '', promptFromStdin: true }
    })
    expect(selectRunMode(['--json', '--max-turns', '5'], '/cwd', false, true)).toMatchObject({
      kind: 'headless',
      options: { promptFromStdin: true, json: true, maxTurns: 5 }
    })
    // An explicit prompt still wins over whatever is piped.
    expect(selectRunMode(['-p', 'do it'], '/cwd', false, true)).toMatchObject({
      kind: 'headless',
      options: { prompt: 'do it' }
    })
    // -i is explicit too: a piped stdin doesn't turn it into a one-shot run.
    expect(selectRunMode(['-i'], '/cwd', false, true).kind).toBe('tui')
  })

  it('`-p -` reads the prompt from stdin', () => {
    expect(selectRunMode(['-p', '-'], '/cwd', false, true)).toMatchObject({
      kind: 'headless',
      options: { promptFromStdin: true }
    })
  })

  it('carries the resolved cwd into the interactive options', () => {
    expect(selectRunMode(['--cwd', '/proj'], '/cwd', true)).toMatchObject({
      kind: 'tui',
      options: { cwd: '/proj' }
    })
  })
})

describe('wireCliHost', () => {
  const saved = process.env.HOUSTON_DATA_DIR
  // wireCliHost puts a gate on tls.connect until the certificate store is read.
  const savedConnect = tls.connect
  let dir = ''
  afterEach(() => {
    tls.connect = savedConnect
    resetRuleUsageForTests()
    if (saved === undefined) delete process.env.HOUSTON_DATA_DIR
    else process.env.HOUSTON_DATA_DIR = saved
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('records when a permission rule decides a call, in the profile the desktop app reads', () => {
    dir = mkdtempSync(join(tmpdir(), 'houston-cli-host-'))
    process.env.HOUSTON_DATA_DIR = dir
    wireCliHost()
    const rule: PermissionRule = { action: 'allow', tool: 'run_shell', match: 'npm test' }
    noteRuleUsed(rule)
    flushRuleUsage()
    const usage = JSON.parse(readFileSync(join(dir, 'rule-usage.json'), 'utf8')) as Record<string, number>
    expect(typeof usage[permissionRuleKey(rule)]).toBe('number')
  })

  // Reading the OS store takes tens of milliseconds, so start-up no longer pays for it:
  // the TUI runs it after its first paint (system-ca.test.ts covers the TLS gate).
  it('leaves the system certificate store for later and hands back the read', () => {
    dir = mkdtempSync(join(tmpdir(), 'houston-cli-host-'))
    process.env.HOUSTON_DATA_DIR = dir
    const read = vi.spyOn(tls, 'getCACertificates').mockReturnValue([])
    try {
      const { trustCertificatesNow } = wireCliHost()
      expect(read).not.toHaveBeenCalled()
      expect(tls.connect).not.toBe(savedConnect)
      trustCertificatesNow()
      expect(read).toHaveBeenCalledWith('system')
      expect(tls.connect).toBe(savedConnect)
    } finally {
      read.mockRestore()
    }
  })
})
