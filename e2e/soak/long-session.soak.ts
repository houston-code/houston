import { rmSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { startSoakModel } from './model'
import { envNumber, report, soakWorkspace, type Check } from './fixtures'
import { launchSoakApp, leaveChat, saveWindowHeap, runTurn, sampleDesktop, settledSample, useSoakModel, type DesktopSample } from './desktop'
import { budget } from './budgets'

const TURNS = envNumber('SOAK_TURNS', 12)
const STEPS = envNumber('SOAK_STEPS', 12)
const TURN_TIMEOUT_MS = envNumber('SOAK_TURN_TIMEOUT_MS', 180_000)

/**
 * One long, heavy chat in the desktop app: TURNS turns of STEPS tool calls each, every
 * result large (file windows, near-cap shell output, searches, screenshots, file
 * writes, and a subagent every few turns). Fails when memory grows past its budget
 * during the run, is not given back after the run and after leaving the chat, or when
 * a shell or other child process is left running.
 */
test('a long heavy session stays within its memory budget and gives it back', async () => {
  test.setTimeout(TURNS * TURN_TIMEOUT_MS + 300_000)
  const workspace = soakWorkspace()
  const model = await startSoakModel({ steps: STEPS, subagentEvery: 3 })
  const s = await launchSoakApp()
  const samples: DesktopSample[] = []
  try {
    await useSoakModel(s, { baseUrl: model.baseUrl, model: model.model, workspace })
    await s.page.waitForTimeout(1500)
    const baseline = await sampleDesktop(s, 'baseline', true)
    samples.push(baseline)
    const every = Math.max(1, Math.floor(TURNS / 6))
    for (let turn = 1; turn <= TURNS; turn++) {
      await runTurn(s, turn, TURN_TIMEOUT_MS)
      if (turn === 1 || turn % every === 0 || turn === TURNS) samples.push(await sampleDesktop(s, `after turn ${turn}`, false))
    }
    await s.page.waitForTimeout(2000)
    const ended = await sampleDesktop(s, 'run ended + GC', true)
    samples.push(ended)
    await leaveChat(s)
    await s.page.waitForTimeout(2500)
    samples.push(await sampleDesktop(s, 'left the chat + GC', true))
    const settled = await settledSample(s, 'settled (lowest of 4, 20s)')
    samples.push(settled)

    const b = budget('desktopSession')
    const peak = Math.max(...samples.map((x) => x.totalMB))
    const checks: Check[] = [
      { name: 'peak total during the run', value: peak, limit: b.peakTotalMB, unit: 'MB' },
      { name: 'main heap after the run (GC)', value: ended.mainHeapMB, limit: b.mainHeapAfterGcMB, unit: 'MB' },
      { name: 'total kept after leaving the chat', value: settled.totalMB - baseline.totalMB, limit: b.retainedMB, unit: 'MB' },
      { name: 'window heap kept after leaving the chat', value: settled.rendererHeapMB - baseline.rendererHeapMB, limit: b.rendererRetainedMB, unit: 'MB' },
      { name: 'page elements kept after leaving the chat', value: settled.domNodes - baseline.domNodes, limit: b.domNodesRetained, unit: 'nodes' },
      { name: 'child processes left running', value: settled.strayChildren.length, limit: 0, unit: '' }
    ]
    if (checks.some((c) => c.name.startsWith('window heap kept') && c.value > c.limit)) await saveWindowHeap(s, 'long-session-after-leaving')
    const over = report('long-session', [...samples, { requests: model.requests(), peakToolResults: model.peakToolResults(), subagentReports: model.subagentReports() }], checks)
    // The session must really have been long and heavy, or the numbers mean nothing.
    expect(model.subagentReports(), 'subagents ran').toBeGreaterThan(0)
    expect(settled.strayChildren, 'child processes left running').toEqual([])
    expect(over.map((c) => c.name), 'checks over budget').toEqual([])
  } finally {
    await s.launched.close()
    await model.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})
