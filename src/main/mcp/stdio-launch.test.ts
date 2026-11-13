import { describe, expect, it } from 'vitest'
import { planStdioLaunch, resolveWindowsCommand } from './stdio-launch'

// A fake Windows box: npm's shims live in the nodejs dir, a native tool elsewhere.
const NODE_DIR = 'C:\\Program Files\\nodejs'
const TOOLS_DIR = 'C:\\tools'
const files = new Set([
  `${NODE_DIR}\\npx.cmd`,
  `${NODE_DIR}\\npx`, // the sh shim npm writes beside it, which Windows can't run
  `${NODE_DIR}\\node.exe`,
  `${TOOLS_DIR}\\uvx.exe`,
  `${TOOLS_DIR}\\legacy.bat`
])
const exists = (p: string): boolean => files.has(p)
const env = { Path: `${NODE_DIR};${TOOLS_DIR}`, PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS' }
const win = { platform: 'win32' as const, exists, comspec: 'C:\\Windows\\system32\\cmd.exe' }

describe('resolveWindowsCommand', () => {
  it('finds a .cmd shim on PATH (read case-insensitively) through PATHEXT', () => {
    expect(resolveWindowsCommand('npx', env, win)).toBe(`${NODE_DIR}\\npx.cmd`)
  })

  it('searches dir by dir, trying every suffix in PATHEXT order', () => {
    const both = new Set([`${NODE_DIR}\\dup.cmd`, `${TOOLS_DIR}\\dup.exe`, `${NODE_DIR}\\pick.cmd`, `${NODE_DIR}\\pick.exe`])
    const has = (p: string): boolean => both.has(p)
    expect(resolveWindowsCommand('dup', env, { ...win, exists: has })).toBe(`${NODE_DIR}\\dup.cmd`)
    expect(resolveWindowsCommand('pick', env, { ...win, exists: has })).toBe(`${NODE_DIR}\\pick.exe`)
  })

  it('takes a name that already has its extension as given', () => {
    expect(resolveWindowsCommand('npx.cmd', env, win)).toBe(`${NODE_DIR}\\npx.cmd`)
  })

  it('resolves an absolute path, adding a missing suffix', () => {
    expect(resolveWindowsCommand(`${NODE_DIR}\\npx`, env, win)).toBe(`${NODE_DIR}\\npx.cmd`)
  })

  it('never offers a .js/.vbs/.ps1 from PATHEXT, and returns null when nothing matches', () => {
    const has = (p: string): boolean => p === `${NODE_DIR}\\script.js`
    expect(resolveWindowsCommand('script', env, { ...win, exists: has })).toBeNull()
    expect(resolveWindowsCommand('missing', env, win)).toBeNull()
  })

  it('does not search the current directory for a bare name', () => {
    const has = (p: string): boolean => p === 'C:\\repo\\npx.cmd'
    expect(resolveWindowsCommand('npx', env, { ...win, exists: has, cwd: 'C:\\repo' })).toBeNull()
  })
})

describe('planStdioLaunch', () => {
  it('leaves the command alone off Windows', () => {
    expect(planStdioLaunch('npx', ['-y', 'pkg'], env, { ...win, platform: 'linux' })).toEqual({
      command: 'npx',
      args: ['-y', 'pkg']
    })
  })

  it('runs a .cmd shim through cmd.exe with every argument quoted and intact', () => {
    const plan = planStdioLaunch(
      'npx',
      ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\me\\My Project\\', 'a&b|c<d>e^f(g)'],
      env,
      win
    )
    expect(plan.command).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(plan.windowsVerbatimArguments).toBe(true)
    expect(plan.args.slice(0, 4)).toEqual(['/d', '/v:off', '/s', '/c'])
    expect(plan.args[4]).toBe(
      '""C:\\Program Files\\nodejs\\npx.cmd" "-y" "@modelcontextprotocol/server-filesystem" ' +
        '"C:\\Users\\me\\My Project\\\\" "a&b|c<d>e^f(g)""'
    )
  })

  it('treats a .bat the same way', () => {
    const plan = planStdioLaunch('legacy', [], env, win)
    expect(plan.args[4]).toBe(`""${TOOLS_DIR}\\legacy.bat""`)
  })

  it('spawns a native executable directly by its resolved path', () => {
    expect(planStdioLaunch('uvx', ['mcp-server-git'], env, win)).toEqual({
      command: `${TOOLS_DIR}\\uvx.exe`,
      args: ['mcp-server-git']
    })
  })

  it('spawns an unresolvable command unchanged (it fails with ENOENT as before)', () => {
    expect(planStdioLaunch('nope', ['x'], env, win)).toEqual({ command: 'nope', args: ['x'] })
  })

  it.each(['say "hi"', '%PATH%', 'wow!', 'two\nlines', 'cr\rx', 'nul\0x'])(
    'refuses an argument cmd.exe cannot pass literally: %j',
    (arg) => {
      expect(() => planStdioLaunch('npx', ['-y', arg], env, win)).toThrow(/Argument 2 .*cmd\.exe/)
    }
  )

  it('allows those characters when no cmd.exe is involved', () => {
    expect(planStdioLaunch('uvx', ['%PATH%', 'wow!'], env, win).args).toEqual(['%PATH%', 'wow!'])
  })
})
