import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { ROOT } from '../launch'
import { startSoakModel, TURN_PROMPT, type SoakModel } from './model'
import { envNumber, report, soakWorkspace, type Check } from './fixtures'
import { descendants, processesTagged, residentMB, waitUntil } from './processes'
import { budget } from './budgets'
import { isOwnHelper } from './desktop'

const TURNS = envNumber('SOAK_TURNS', 12)
const STEPS = envNumber('SOAK_STEPS', 12)
const TURN_TIMEOUT_MS = envNumber('SOAK_TURN_TIMEOUT_MS', 180_000)
const CLI = join(ROOT, 'out', 'cli', 'houston-cli.cjs')

/** A headless CLI session reading one turn per stdin line, with its result lines counted. */
interface CliSession {
  child: ChildProcessWithoutNullStreams
  /** Result lines seen so far, one per finished turn. */
  results: { status?: string }[]
  send(text: string): void
  exited: Promise<number | null>
  dataDir: string
}

function startCli(model: SoakModel, workspace: string): CliSession {
  const dataDir = mkdtempSync(join(tmpdir(), 'houston-soak-cli-'))
  writeFileSync(
    join(dataDir, 'settings.json'),
    JSON.stringify({
      providers: [{ id: 'soak', kind: 'openai-compatible', label: 'Soak', baseUrl: model.baseUrl, models: [{ id: model.model }], defaultModel: model.model, requiresKey: false }],
      selected: { providerId: 'soak', model: model.model },
      recentWorkspaces: [workspace],
      approvalPolicy: 'full-auto'
    })
  )
  const child = spawn(process.execPath, [CLI, '--json', '--input-format', 'stream-json', '--full-auto', '--cwd', workspace], {
    cwd: workspace,
    env: { ...process.env, HOUSTON_DATA_DIR: dataDir, HOUSTON_NO_UPDATE_CHECK: '1' },
    windowsHide: true
  })
  const results: { status?: string }[] = []
  let pending = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    // Events carry whole tool outputs; keep only the unfinished line between chunks.
    pending += chunk
    let nl: number
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl)
      pending = pending.slice(nl + 1)
      if (line.startsWith('{"type":"result"')) results.push(JSON.parse(line) as { status?: string })
    }
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (c: string) => (stderr = (stderr + c).slice(-4000)))
  const exited = new Promise<number | null>((resolve) =>
    child.on('exit', (code, signal) => {
      if (code !== 0) console.log(`[soak] cli exited ${code ?? signal}; stderr tail:\n${stderr}`)
      resolve(code)
    })
  )
  return {
    child,
    results,
    send: (text) => child.stdin.write(`${JSON.stringify({ type: 'user', content: text })}\n`),
    exited,
    dataDir
  }
}

test.beforeAll(() => {
  if (!existsSync(CLI)) throw new Error('No out/cli/houston-cli.cjs. Run `npm run build:cli` first.')
})

/**
 * One long, heavy session in the terminal client (the same agent loop and save path
 * the interactive TUI uses). Fails when its resident memory keeps growing turn after
 * turn, stays high once idle, or when it leaves a child process running.
 */
test('a long heavy CLI session keeps its memory flat and gives it back', async () => {
  test.setTimeout(TURNS * TURN_TIMEOUT_MS + 300_000)
  const workspace = soakWorkspace()
  const model = await startSoakModel({ steps: STEPS, subagentEvery: 3 })
  const cli = startCli(model, workspace)
  const pid = cli.child.pid!
  const samples: Record<string, unknown>[] = []
  let peak = 0
  const poll = setInterval(() => (peak = Math.max(peak, residentMB(pid))), process.platform === 'win32' ? 3000 : 1000)
  try {
    await new Promise((r) => setTimeout(r, 3000))
    samples.push({ label: 'idle after start', residentMB: Math.round(residentMB(pid)) })
    const at: Record<number, number> = {}
    for (let turn = 1; turn <= TURNS; turn++) {
      cli.send(`${TURN_PROMPT} ${turn}: keep going with the task.`)
      expect(await waitUntil(() => cli.results.length >= turn, TURN_TIMEOUT_MS, 250), `turn ${turn} finished`).toBe(true)
      expect(cli.results[turn - 1].status, `turn ${turn} status`).toBe('success')
      at[turn] = residentMB(pid)
      samples.push({ label: `after turn ${turn}`, residentMB: Math.round(at[turn]) })
    }
    await new Promise((r) => setTimeout(r, 15_000))
    const idle = residentMB(pid)
    const stray = descendants(pid)
      .filter((p) => !isOwnHelper(p.command))
      .map((p) => `${p.pid} ${p.command.slice(0, 120)}`)
    samples.push({ label: 'idle 15s after the last turn', residentMB: Math.round(idle), stray })
    cli.child.stdin.end()
    expect(await cli.exited, 'the CLI exits cleanly at end of input').toBe(0)

    const b = budget('cliSession')
    // Growth from early in the session to its end. The CLI's footprint once grew ~65 MB
    // every turn as the allocator kept each save's freed buffers; a fix flattened it.
    const from = at[Math.min(2, TURNS)]
    const checks: Check[] = [
      { name: 'peak resident during the session', value: Math.round(peak), limit: b.peakResidentMB, unit: 'MB' },
      { name: 'growth from turn 2 to the last turn', value: Math.round(at[TURNS] - from), limit: b.lateGrowthMB, unit: 'MB' },
      { name: 'resident once idle', value: Math.round(idle), limit: b.idleResidentMB, unit: 'MB' },
      { name: 'child processes left running', value: stray.length, limit: 0, unit: '' }
    ]
    const over = report('cli-session', [...samples, { requests: model.requests(), subagentReports: model.subagentReports() }], checks)
    expect(model.subagentReports(), 'subagents ran').toBeGreaterThan(0)
    expect(stray, 'child processes left running').toEqual([])
    expect(over.map((c) => c.name), 'checks over budget').toEqual([])
  } finally {
    clearInterval(poll)
    cli.child.kill()
    await model.close()
    rmSync(cli.dataDir, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})

/**
 * Closing the terminal a CLI session runs in (SIGHUP), or stopping it with SIGTERM,
 * while a shell command is running must end that command too. Windows has no such
 * signals: a console close there ends the whole process tree with it.
 */
for (const signal of ['SIGHUP', 'SIGTERM'] as const) {
  test(`a CLI stopped by ${signal} mid-run leaves no command running`, async () => {
    test.skip(process.platform === 'win32', 'POSIX signals only')
    test.setTimeout(180_000)
    const workspace = soakWorkspace()
    const tag = `soak-cli-${randomBytes(4).toString('hex')}`
    const model = await startSoakModel({
      steps: 1,
      subagentEvery: 0,
      override: () => ({ name: 'run_shell', args: { command: `node -e "setTimeout(() => {}, 600000)" ${tag}` } })
    })
    const cli = startCli(model, workspace)
    try {
      cli.send(`${TURN_PROMPT} 1: run the long command.`)
      expect(await waitUntil(() => processesTagged(tag).length > 0, 60_000), 'the command started').toBe(true)
      cli.child.kill(signal)
      expect(await cli.exited, `exit code for ${signal}`).toBe(signal === 'SIGHUP' ? 129 : 143)
      expect(await waitUntil(() => processesTagged(tag).length === 0, 15_000), 'the command ended with the CLI').toBe(true)
    } finally {
      for (const p of processesTagged(tag)) {
        try {
          process.kill(p.pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
      cli.child.kill('SIGKILL')
      await model.close()
      rmSync(cli.dataDir, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  })
}
