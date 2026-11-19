import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/agent'
import type { Command } from '@shared/commands'
import type { AppSettings } from '@shared/types'
import { workspaceTrusted } from './agent/commandRun'
import { loadProjectConfig } from './agent/projectConfig'
import { runTui, type TuiDeps, type TuiIo } from './tui'
import { StatusLineRunner } from './tui-statusline'

// /cd and /trust re-resolve everything a session reads from its folder: the project's
// status line (and whether its folder is trusted), the trust question, its commands.

const done: AgentEvent = { runId: 'x', type: 'done', stopReason: 'end_turn' }
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', timedOut: false, truncated: false })

let roots: string[] = []
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots = []
})

/** Folders a and b, each with a project status line naming the same relative script. */
async function projects(): Promise<{ a: string; b: string; hash: (dir: string) => Promise<string> }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'houston-cd-status-')))
  roots.push(root)
  for (const name of ['a', 'b']) {
    mkdirSync(join(root, name, '.houston'), { recursive: true })
    writeFileSync(
      join(root, name, '.houston', 'settings.json'),
      JSON.stringify({ statusLine: { command: './.houston/status.sh' } })
    )
  }
  return {
    a: join(root, 'a'),
    b: join(root, 'b'),
    hash: async (dir) => (await loadProjectConfig(dir)).elevatedHash ?? ''
  }
}

/**
 * A session wired the way the terminal host wires it: the status line command runs in
 * the session's current folder, and a project's applies only while that folder is trusted.
 */
function harness(cwd: string, inputs: Array<string | null>, settings: Partial<AppSettings> = {}, color = false) {
  let current: AppSettings = {
    schemaVersion: 1,
    providers: [{ id: 'anthropic', requiresKey: true, hasKey: true, models: [{ id: 'claude' }], defaultModel: 'claude' }],
    selected: { providerId: 'anthropic', model: 'claude' },
    approvalPolicy: 'ask',
    recentWorkspaces: [],
    ...settings
  } as unknown as AppSettings
  const o = { cwd, approvalPolicy: 'ask' as const, color }
  const out: string[] = []
  const reads: string[] = []
  const ran: Array<{ command: string; cwd: string }> = []
  let i = 0
  const io: TuiIo = {
    out: (s) => out.push(s),
    clearLine: () => {},
    readLine: async (prompt) => {
      reads.push(prompt)
      return i < inputs.length ? inputs[i++] : null
    },
    onInterrupt: () => {},
    cancelRead: () => {},
    startSpinner: () => {},
    setSpinnerLabel: () => {},
    stopSpinner: () => {}
  }
  let runs = 0
  const d: TuiDeps = {
    getSettings: () => current,
    updateSettings: (patch) => {
      current = { ...current, ...patch }
    },
    startRun: async (req, send, onMessages) => {
      send({ runId: req.runId, type: 'text', delta: 'See `notes.md` for it.' })
      send({ ...done, runId: req.runId })
      onMessages?.(req.messages)
    },
    resolveApproval: () => {},
    resolveQuestion: () => {},
    resolvePlan: () => {},
    resolveElicitation: () => {},
    cancelRun: () => {},
    io,
    newId: () => `run-${++runs}`,
    runStatusLine: async (command) => {
      ran.push({ command, cwd: o.cwd })
      return ok(`status from ${o.cwd}\n`)
    },
    projectStatusLine: async () => {
      const config = (await loadProjectConfig(o.cwd)).elevated.statusLine ?? null
      return { config, trusted: config ? await workspaceTrusted(o.cwd, current.trustedFolders) : false }
    }
  }
  return { d, o, out, reads, ran, text: () => out.join(''), settings: () => current }
}

const trust = (path: string, hash: string) => ({ path, decision: 'trusted' as const, hash, decidedAt: 1 })

describe('/cd and the project status line', () => {
  it("stops the old folder's status line and never runs it in an untrusted new folder", async () => {
    const { a, b, hash } = await projects()
    const h = harness(a, ['/cd ../b', 'n', 'hello', null], { trustedFolders: [trust(a, await hash(a))] })
    await runTui(h.o, h.d)
    // It ran in a, the trusted folder, and the user declined to trust b.
    expect(h.ran.some((r) => r.cwd === a)).toBe(true)
    expect(h.ran.filter((r) => r.cwd === b)).toEqual([])
    expect(h.text()).not.toContain(`status from ${b}`)
  })

  it("picks up the new folder's status line when that folder is trusted", async () => {
    const { a, b, hash } = await projects()
    rmSync(join(a, '.houston'), { recursive: true })
    const h = harness(a, ['/cd ../b', null], { trustedFolders: [trust(b, await hash(b))] })
    await runTui(h.o, h.d)
    expect(h.ran.filter((r) => r.cwd === a)).toEqual([])
    expect(h.ran.some((r) => r.cwd === b)).toBe(true)
    expect(h.text()).toContain(`status from ${b}`)
  })

  it('/statusline describes the new folder after a move', async () => {
    const { a, b, hash } = await projects()
    rmSync(join(b, '.houston'), { recursive: true })
    const h = harness(a, ['/cd ../b', '/statusline', null], { trustedFolders: [trust(a, await hash(a))] })
    await runTui(h.o, h.d)
    const after = h.text().slice(h.text().indexOf('working folder is now'))
    expect(after).not.toContain('./.houston/status.sh')
  })

  it('asks the new folder’s trust question once, not again after the next message', async () => {
    const { a, b } = await projects()
    rmSync(join(a, '.houston'), { recursive: true })
    const h = harness(a, ['/cd ../b', 'n', 'hello', null])
    await runTui(h.o, h.d)
    expect(h.reads.filter((r) => r.startsWith('Trust this folder?'))).toHaveLength(1)
    expect(h.ran.filter((r) => r.cwd === b)).toEqual([])
  })

  it('/trust forget stops a running project status line once the folder is no longer trusted', async () => {
    const { a, hash } = await projects()
    const h = harness(a, ['/trust forget', 'n', 'hello', null], { trustedFolders: [trust(a, await hash(a))] })
    await runTui(h.o, h.d)
    expect(h.settings().trustedFolders).toEqual([])
    expect(h.reads.some((r) => r.startsWith('Trust this folder?'))).toBe(true)
    const out = h.text()
    expect(out).toContain(`status from ${a}`)
    const tail = out.slice(out.indexOf('forgot the trust decision'))
    expect(tail).not.toContain(`status from ${a}`)
  })

  it('reloads the new folder’s commands without the ones named like a built-in', async () => {
    const { a, b } = await projects()
    rmSync(join(a, '.houston'), { recursive: true })
    rmSync(join(b, '.houston'), { recursive: true })
    const h = harness(a, ['/cd ../b', '/help', null])
    const loaded: Command[] = [
      { name: 'help', description: 'shadow', template: 'evil' } as Command,
      { name: 'ship-it', description: 'mine', template: 'go' } as Command
    ]
    h.d.commands = async () => loaded
    await runTui(h.o, h.d)
    const help = h.text().slice(h.text().lastIndexOf('working folder is now'))
    expect(help).toContain('/ship-it')
    expect(help).not.toContain('shadow')
  })
})

describe('/cd and reply links', () => {
  it('links a file named in a reply to the copy in the new folder', async () => {
    const { a, b } = await projects()
    for (const dir of [a, b]) {
      rmSync(join(dir, '.houston'), { recursive: true })
      writeFileSync(join(dir, 'notes.md'), 'x')
    }
    const h = harness(a, ['first', '/cd ../b', 'second', null], {}, true)
    await runTui(h.o, h.d)
    const out = h.text()
    const after = out.slice(out.indexOf('working folder is now'))
    expect(out.slice(0, out.indexOf('working folder is now'))).toContain(pathToFileURL(join(a, 'notes.md')).href)
    expect(after).toContain(pathToFileURL(join(b, 'notes.md')).href)
    expect(after).not.toContain(pathToFileURL(join(a, 'notes.md')).href)
  })
})

describe('StatusLineRunner.dispose', () => {
  it('drops a queued refresh and starts no new run', async () => {
    let release: () => void = () => {}
    const commands: string[] = []
    const runner = new StatusLineRunner({ command: 'st', source: 'project' }, async (command) => {
      commands.push(command)
      await new Promise<void>((r) => (release = r))
      return ok('x\n')
    })
    const payload = { cwd: '/a' } as unknown as Parameters<StatusLineRunner['refresh']>[0]
    const first = runner.refresh(payload)
    void runner.refresh({ ...payload, cwd: '/b' })
    runner.dispose()
    release()
    await first
    await runner.refresh(payload)
    expect(commands).toEqual(['st'])
  })
})
