import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The entry must answer -h/-v without evaluating the real program (run.ts and, through
// it, the agent core, store, TUI, and sandbox). The factory below runs only if something
// actually loads './run', so it doubles as the "was the heavy graph evaluated" probe.
const probe = vi.hoisted(() => ({ loads: 0, runCli: [] as string[][] }))
vi.mock('./run', () => {
  probe.loads++
  return {
    runCli: async (argv: string[]) => {
      probe.runCli.push(argv)
      return 7
    },
    log: { error: () => {} },
    flushRuleUsage: () => {}
  }
})

import { USAGE, cliArgvError, main, nodeVersionError, shortUsage } from './index'
import { HEADLESS_FLAGS } from '../main/headless'

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

describe('main', () => {
  let out: string[]
  beforeEach(() => {
    out = []
    probe.runCli = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk))
      return true
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([['--version'], ['-v'], ['--help'], ['-h'], ['-p', 'hi', '--version']])(
    'answers %s without loading the program',
    async (...args) => {
      const load = vi.fn()
      const code = await main(['node', 'houston', ...args], load)
      expect(code).toBe(0)
      expect(load).not.toHaveBeenCalled()
    }
  )

  it('prints the version and the usage text', async () => {
    await main(['node', 'houston', '--version'])
    await main(['node', 'houston', '--help'])
    expect(out[0]).toMatch(/^\S+\n$/)
    expect(out[1]).toBe(USAGE)
  })

  it('never evaluates the program module for -h/-v with the default loader', async () => {
    await main(['node', 'houston', '--version'])
    await main(['node', 'houston', '-h'])
    expect(probe.loads).toBe(0)
  })

  it('loads the program for a real mode and returns its exit code', async () => {
    const argv = ['node', 'houston', 'providers']
    expect(await main(argv)).toBe(7)
    expect(probe.loads).toBe(1)
    expect(probe.runCli).toEqual([argv])
  })

  it('hands the program the version, the usage, and the command-line check', async () => {
    let opts: Parameters<typeof import('./run').runCli>[1] | undefined
    const load = vi.fn(async () => ({
      runCli: async (_argv: string[], o: NonNullable<typeof opts>) => {
        opts = o
        return 0
      }
    })) as unknown as Parameters<typeof main>[1]
    await main(['node', 'houston', '--modle', 'x'], load)
    expect(opts!.usage).toBe(USAGE)
    expect(opts!.argvProblem(['-p', 'hi'])).toBeNull()
    const problem = opts!.argvProblem(['--modle', 'x'])!
    expect(problem.startsWith('houston: unknown option: --modle\n\n')).toBe(true)
    expect(problem).toContain(shortUsage())
    expect(problem.endsWith('Run houston --help for every option.\n')).toBe(true)
  })

  it('opens a folder in the desktop app without loading the program', async () => {
    const load = vi.fn()
    // A missing folder fails inside the open command, before anything is launched.
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(await main(['node', 'houston', 'open', '/definitely/not/a/folder'], load)).toBe(1)
    expect(load).not.toHaveBeenCalled()
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
