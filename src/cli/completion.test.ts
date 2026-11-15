import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { completionScript, runCompletionCommand } from './completion'
import { CLI_FLAGS, CLI_SUBCOMMANDS } from './flags'

const has = (bin: string): boolean => process.platform !== 'win32' && spawnSync(bin, ['-c', 'exit 0']).status === 0

/** Source the bash script, complete the words typed so far, and return the candidates. */
function bashComplete(words: string[], setup?: (dir: string) => void): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'houston-complete-'))
  setup?.(dir)
  const script = join(dir, 'houston.bash')
  writeFileSync(script, completionScript('bash'))
  const arr = words.map((w) => `'${w.replace(/'/g, `'\\''`)}'`).join(' ')
  const res = spawnSync(
    'bash',
    ['--norc', '--noprofile', '-c', `source "$1"; COMP_WORDS=(${arr}); COMP_CWORD=$((\${#COMP_WORDS[@]}-1)); _houston; printf '%s\\n' "\${COMPREPLY[@]}"`, 'x', script],
    { encoding: 'utf8', cwd: dir }
  )
  expect(res.stderr).toBe('')
  return res.stdout.split('\n').filter(Boolean)
}

describe('completion scripts', () => {
  it('name every flag and every subcommand, from the one table', () => {
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const s = completionScript(shell)
      for (const sub of CLI_SUBCOMMANDS) expect(s).toContain(sub.name)
      for (const f of CLI_FLAGS) {
        for (const n of f.names) {
          // fish writes `--cwd` as `-l cwd` and `-C` as `-s C`.
          const spelled = shell === 'fish' ? (n.startsWith('--') ? `-l ${n.slice(2)}` : `-s ${n.slice(1)}`) : n
          expect(s, `${shell} ${n}`).toContain(spelled)
        }
      }
    }
  })

  it.skipIf(!has('bash'))('bash: parses, and completes subcommands, verbs, flags and flag values', () => {
    expect(spawnSync('bash', ['-n'], { input: completionScript('bash') }).status).toBe(0)
    expect(bashComplete(['houston', 'd'])).toEqual(['doctor'])
    expect(bashComplete(['houston', 'mcp', 'lo']).sort()).toEqual(['login', 'logout'])
    expect(bashComplete(['houston', 'mcp', 'add', '--u'])).toEqual(['--url'])
    expect(bashComplete(['houston', 'completion', ''])).toEqual(['bash', 'zsh', 'fish'])
    expect(bashComplete(['houston', 'doctor', '--'])).toEqual(['--json'])
    expect(bashComplete(['houston', '--approval', 'a']).sort()).toEqual(['ask', 'auto-edit'])
    expect(bashComplete(['houston', '-p', 'x', '--effort', 'x'])).toEqual(['xhigh'])
    expect(bashComplete(['houston', '--scr'])).toEqual(['--screen-reader'])
    // A free-form value (a model id) offers nothing rather than the flag list.
    expect(bashComplete(['houston', '--model', ''])).toEqual([])
  })

  it.skipIf(!has('bash'))('bash: keeps a folder or file name with spaces as one candidate', () => {
    const tree = (dir: string): void => {
      mkdirSync(join(dir, 'My Projects'))
      mkdirSync(join(dir, 'My Other'))
      writeFileSync(join(dir, 'My Schema.json'), '{}')
    }
    expect(bashComplete(['houston', '-C', 'My'], tree).sort()).toEqual(['My Other', 'My Projects'])
    expect(bashComplete(['houston', 'open', 'My'], tree).sort()).toEqual(['My Other', 'My Projects'])
    expect(bashComplete(['houston', '--output-schema', 'My S'], tree)).toEqual(['My Schema.json'])
  })

  it.skipIf(!has('zsh'))('zsh: parses', () => {
    const res = spawnSync('zsh', ['-n'], { input: completionScript('zsh'), encoding: 'utf8' })
    expect(res.stderr).toBe('')
    expect(res.status).toBe(0)
  })

  it.skipIf(!has('fish'))('fish: parses', () => {
    const res = spawnSync('fish', ['--no-execute'], { input: completionScript('fish'), encoding: 'utf8' })
    expect(res.stderr).toBe('')
    expect(res.status).toBe(0)
  })

  it('quotes every description for its shell', () => {
    // The approval policies' help has a pipe and parentheses; none may reach a shell bare.
    const zsh = completionScript('zsh')
    expect(zsh).toContain("'--approval[approval policy]:policy:(plan ask auto-edit full-auto)'")
    const fish = completionScript('fish')
    expect(fish).toContain("-l approval -x -a 'plan ask auto-edit full-auto' -d 'approval policy'")
    expect(fish).toContain("-d 'title the session\\'s chat'")
  })
})

describe('houston completion', () => {
  const run = (...args: string[]) => {
    const out: string[] = []
    const err: string[] = []
    const code = runCompletionCommand(args, { out: (s) => void out.push(s), err: (s) => void err.push(s) })
    return { code, out: out.join(''), err: err.join('') }
  }

  it('prints the script for a named shell', () => {
    expect(run('zsh')).toEqual({ code: 0, out: completionScript('zsh'), err: '' })
  })

  it('asks for a shell it knows, exit 2', () => {
    expect(run().code).toBe(2)
    expect(run().err).toContain('name a shell')
    const bad = run('powershell')
    expect(bad.code).toBe(2)
    expect(bad.err).toContain('no completion for "powershell"')
    expect(run('bash', 'zsh').code).toBe(2)
  })
})
