import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { permissionRuleKey, type PermissionRule } from '@shared/types'
import { cliArgvError, nodeVersionError, selectRunMode, shortUsage, USAGE, wireCliHost } from './index'
import { HEADLESS_FLAGS } from '../main/headless'
import { noteRuleUsed } from '../main/agentHost'
import { flushRuleUsage, resetRuleUsageForTests } from '../main/ruleUsage'

describe('nodeVersionError', () => {
  it('returns null when the runtime is new enough', () => {
    expect(nodeVersionError('v22.0.0')).toBeNull()
    expect(nodeVersionError('v24.3.1')).toBeNull()
    expect(nodeVersionError('v22.22.3')).toBeNull()
  })

  it('reports an actionable error on an older runtime', () => {
    const err = nodeVersionError('v18.19.0')
    expect(err).not.toBeNull()
    expect(err).toContain('Node 22')
    expect(err).toContain('v18.19.0')
  })

  it('honors a custom minimum', () => {
    expect(nodeVersionError('v20.0.0', 22)).toContain('Node 22')
    expect(nodeVersionError('v20.0.0', 20)).toBeNull()
  })

  it('does not block on an unparseable version string', () => {
    expect(nodeVersionError('not-a-version')).toBeNull()
    expect(nodeVersionError('')).toBeNull()
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
  let dir = ''
  afterEach(() => {
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
})

describe('cliArgvError', () => {
  it('accepts every documented run-mode command line', () => {
    expect(cliArgvError([])).toBeNull()
    expect(cliArgvError(['-i', '--model', 'm', '--provider', 'p', '-C', '/x'])).toBeNull()
    expect(cliArgvError(['-p', 'fix the bug', '--json', '--max-turns', '3'])).toBeNull()
    expect(cliArgvError(['-p', '-', '--full-auto'])).toBeNull()
    expect(cliArgvError(['-p', '--json'])).toBeNull() // prompt piped in
    expect(cliArgvError(['--prompt=hi', '--cwd=/x', '--approval=plan'])).toBeNull()
    expect(cliArgvError(['--max-cost', '-1'])).toBeNull() // a value may start with a dash
    expect(cliArgvError(['--acp'])).toBeNull()
  })

  it('rejects an unknown flag by name', () => {
    expect(cliArgvError(['--modle', 'x'])).toBe('unknown option: --modle')
    expect(cliArgvError(['--frobnicate=1'])).toBe('unknown option: --frobnicate')
  })

  it('rejects a stray word, pointing at -p for a prompt', () => {
    const err = cliArgvError(['fix the bug'])
    expect(err).toContain('unexpected argument: "fix the bug"')
    expect(err).toContain('-p "fix the bug"')
    expect(cliArgvError(['--continue', 'extra'])).toContain('unexpected argument')
  })

  it('rejects a flag missing its value, and a switch given one', () => {
    expect(cliArgvError(['--model'])).toBe('--model needs a value')
    expect(cliArgvError(['--json=yes'])).toBe('--json takes no value')
  })

  it('knows every flag the run-mode parsers read', () => {
    for (const flag of [...HEADLESS_FLAGS, '-i', '--interactive', '--tui', '--acp']) {
      expect(cliArgvError([flag, 'v']) ?? '').not.toContain('unknown option')
    }
  })

  it('documents every flag it accepts in --help', () => {
    for (const flag of [...HEADLESS_FLAGS, '-i', '--interactive', '--tui', '--acp', '-h', '--help', '-v', '--version']) {
      expect(USAGE).toMatch(new RegExp(`(^|[\\s,(])${flag.replace(/[-]/g, '\\-')}([\\s,=)]|$)`, 'm'))
    }
    expect(USAGE).toContain('houston providers remove <id>')
  })
})

describe('shortUsage', () => {
  it('is the run-mode block of --help, without the option list', () => {
    const u = shortUsage()
    expect(u.startsWith('Usage:')).toBe(true)
    expect(u).toContain('houston -p "<prompt>"')
    expect(u).not.toContain('Options:')
  })
})
