import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp, ROOT, type LaunchedApp } from '../launch'
import { MOCK_PROVIDER_ID } from '../mock-provider'
import { descendants } from './processes'
import { TURN_DONE, TURN_PROMPT } from './model'

/** A desktop app launched for a soak, with what sampling it needs. */
export interface SoakApp {
  launched: LaunchedApp
  app: ElectronApplication
  page: Page
  cdp: CDPSession
  mainPid: number
  execPath: string
}

/** One memory sample of the whole desktop app. */
export interface DesktopSample {
  label: string
  /** Sum of every Electron process's working set (browser, GPU, utility, renderers). */
  totalMB: number
  byType: Record<string, number>
  mainHeapMB: number
  rendererHeapMB: number
  domNodes: number
  /** Processes Houston started that are not Electron's own (shells, rg, MCP, LSP). */
  strayChildren: string[]
  atSeconds: number
}

const started = Date.now()

/**
 * Launch the unpackaged app on a fresh profile with GC exposed (so "after GC" samples
 * measure what is retained rather than what the collector has not reached yet).
 */
export async function launchSoakApp(userDataDir?: string): Promise<SoakApp> {
  const launched = await launchApp({ prefer: 'unpackaged', switches: ['--js-flags=--expose-gc'], userDataDir })
  const page = await launched.app.firstWindow()
  await expect(page.locator('.app')).toBeVisible({ timeout: 60_000 })
  const cdp = await page.context().newCDPSession(page)
  const { pid, execPath } = await launched.app.evaluate(() => ({ pid: process.pid, execPath: process.execPath }))
  return { launched, app: launched.app, page, cdp, mainPid: pid, execPath }
}

/** Point the app at the soak model with full-auto approval, open `workspace`, and reload. */
export async function useSoakModel(s: SoakApp, opts: { baseUrl: string; model: string; workspace: string }): Promise<void> {
  await s.page.evaluate(
    async ({ id, baseUrl, model, workspace }) => {
      type Api = {
        getSettings(): Promise<Record<string, unknown> & { providers: unknown[] }>
        saveSettings(v: unknown): Promise<unknown>
      }
      const api = (globalThis as unknown as { api: Api }).api
      const settings = await api.getSettings()
      settings.providers = [
        ...settings.providers,
        { id, kind: 'openai-compatible', label: 'Soak', baseUrl, models: [{ id: model }], defaultModel: model, requiresKey: false, hasKey: false }
      ]
      settings.selected = { providerId: id, model }
      settings.recentWorkspaces = [workspace]
      settings.approvalPolicy = 'full-auto'
      await api.saveSettings(settings)
    },
    { id: MOCK_PROVIDER_ID, ...opts }
  )
  await s.page.reload()
  await expect(s.page.locator('.app')).toBeVisible()
}

/** Sample memory across every process of the app, collecting garbage first when `gc`. */
export async function sampleDesktop(s: SoakApp, label: string, gc: boolean): Promise<DesktopSample> {
  if (gc) {
    await s.app.evaluate(() => (globalThis as { gc?: () => void }).gc?.())
    await s.cdp.send('HeapProfiler.collectGarbage').catch(() => {})
  }
  const mainHeapMB = await s.app.evaluate(() => process.memoryUsage().heapUsed / 1048576)
  const rendererHeapMB = ((await s.cdp.send('Runtime.getHeapUsage')) as { usedSize: number }).usedSize / 1048576
  const metrics = await s.app.evaluate(({ app }) =>
    app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, mb: m.memory.workingSetSize / 1024 }))
  )
  const byType: Record<string, number> = {}
  let totalMB = 0
  for (const m of metrics) {
    totalMB += m.mb
    byType[m.type] = Math.round((byType[m.type] ?? 0) + m.mb)
  }
  const domNodes = await s.page.evaluate(() => document.querySelectorAll('*').length)
  return {
    label,
    totalMB: Math.round(totalMB),
    byType,
    mainHeapMB: Math.round(mainHeapMB),
    rendererHeapMB: Math.round(rendererHeapMB),
    domNodes,
    strayChildren: strayChildren(s, metrics.map((m) => m.pid)),
    atSeconds: Math.round((Date.now() - started) / 1000)
  }
}

/** Processes under the app that Electron did not start itself, as "pid command". */
export function strayChildren(s: SoakApp, electronPids: number[]): string[] {
  const own = new Set(electronPids)
  return descendants(s.mainPid)
    .filter((p) => !own.has(p.pid) && !p.command.includes(s.execPath) && !/crashpad/i.test(p.command))
    .map((p) => `${p.pid} ${p.command.slice(0, 120)}`)
}

/**
 * What the app settles to: the lowest of `count` GC'd samples `gapMs` apart. The
 * browser and GPU processes give pages back to the OS on their own schedule, so one
 * sample can land high by a hundred MB or more; what is truly kept is the floor.
 */
export async function settledSample(s: SoakApp, label: string, count = 4, gapMs = 5000): Promise<DesktopSample> {
  const all: DesktopSample[] = []
  for (let i = 0; i < count; i++) {
    await s.page.waitForTimeout(gapMs)
    all.push(await sampleDesktop(s, label, true))
  }
  const lowest = all.reduce((a, b) => (b.totalMB < a.totalMB ? b : a))
  return { ...lowest, rendererHeapMB: Math.min(...all.map((x) => x.rendererHeapMB)) }
}

/** Send one soak turn and wait for the model's finishing line to show in the transcript. */
export async function runTurn(s: SoakApp, turn: number, timeoutMs: number): Promise<void> {
  const composer = s.page.locator('textarea.composer__input')
  await expect(composer).toBeEnabled({ timeout: 120_000 })
  await composer.fill(`${TURN_PROMPT} ${turn}: keep going with the task.`)
  await composer.press('Enter')
  // Follow the transcript if it stopped following, so the last row renders.
  await s.page.waitForFunction(
    (marker) => {
      ;(document.querySelector('.jump-bottom') as HTMLElement | null)?.click()
      return document.body.innerText.includes(marker)
    },
    `${TURN_DONE}-${turn}`,
    { timeout: timeoutMs, polling: 1000 }
  )
}

/** Leave the open chat for a new, empty one. */
export async function leaveChat(s: SoakApp): Promise<void> {
  await s.page.getByRole('button', { name: 'New chat' }).first().click()
}

/**
 * Save the window's heap to test-results/soak/<name>.heapsnapshot (kept with the CI
 * artifact), for when a check on what the window keeps fails: open it in the DevTools
 * Memory tab and follow the retainers of what should have been freed.
 */
export async function saveWindowHeap(s: SoakApp, name: string): Promise<void> {
  const dir = join(ROOT, 'test-results', 'soak')
  mkdirSync(dir, { recursive: true })
  const chunks: string[] = []
  const onChunk = (e: { chunk: string }): void => {
    chunks.push(e.chunk)
  }
  s.cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk)
  try {
    await s.cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  } finally {
    s.cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk)
  }
  writeFileSync(join(dir, `${name}-${process.platform}.heapsnapshot`), chunks.join(''))
}
