import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { envNumber, noisePng, report, soakWorkspace, type Check } from './fixtures'
import { launchSoakApp, leaveChat, saveWindowHeap, sampleDesktop, settledSample, type DesktopSample } from './desktop'
import { budget } from './budgets'

const TURNS = envNumber('SOAK_LARGE_CHAT_TURNS', 400)
const TITLE = 'Large soak chat'
const END = 'LARGE_CHAT_END'

/**
 * A saved chat as the app writes one: TURNS turns, each with three tool calls whose
 * results are tens of KB, every tenth with a stored screenshot, and a long final reply.
 * Returns the size of the JSON file.
 */
function seedLargeChat(userDataDir: string, workspace: string): number {
  const id = randomUUID()
  const dir = join(userDataDir, 'conversations')
  const media = join(dir, `${id}.media`)
  mkdirSync(media, { recursive: true })
  const output = (n: number): string =>
    Array.from({ length: 600 }, (_, i) => `line ${i} of the output of call ${n}: some text that a tool printed`).join('\n')
  const messages: Record<string, unknown>[] = []
  for (let t = 0; t < TURNS; t++) {
    messages.push({ role: 'user', content: `Turn ${t}: check the files and run the tests.` })
    const calls = [0, 1, 2].map((k) => ({ id: `c${t}_${k}`, name: k === 1 ? 'run_shell' : 'read_file', arguments: k === 1 ? { command: 'npm test' } : { path: `src/file${k}.ts` } }))
    messages.push({ role: 'assistant', content: `Looking at turn ${t}.`, toolCalls: calls })
    for (const c of calls) {
      const msg: Record<string, unknown> = { role: 'tool', toolCallId: c.id, toolName: c.name, content: output(t * 3) }
      if (t % 10 === 0 && c.name === 'read_file' && c.id.endsWith('_0')) {
        const b64 = noisePng(t).toString('base64')
        const ref = `${createHash('sha256').update(b64).digest('hex')}.png`
        writeFileSync(join(media, ref), Buffer.from(b64, 'base64'))
        msg.images = [{ mediaType: 'image/png', mediaRef: ref }]
      }
      messages.push(msg)
    }
    messages.push({ role: 'assistant', content: `Done with turn ${t}. ${'Here is what changed and why. '.repeat(40)}` })
  }
  messages.push({ role: 'user', content: 'Wrap up.' })
  messages.push({ role: 'assistant', content: `All done. ${END}` })
  const now = Date.now()
  const file = join(dir, `${id}.json`)
  writeFileSync(
    file,
    JSON.stringify({ id, schemaVersion: 2, title: TITLE, titleGenerated: true, workspace, providerId: 'soak', model: 'soak-model', createdAt: now - 86_400_000, updatedAt: now, messages })
  )
  return statSync(file).size
}

/**
 * Reopening a very large saved chat: how much memory opening it costs, how long it
 * takes, and that leaving it gives the memory back.
 */
test('reopening a very large chat stays within budget and is released on leaving', async () => {
  test.setTimeout(600_000)
  const workspace = soakWorkspace()
  const userDataDir = mkdtempSync(join(tmpdir(), 'houston-soak-large-'))
  const bytes = seedLargeChat(userDataDir, workspace)
  const s = await launchSoakApp(userDataDir)
  const samples: (DesktopSample | Record<string, unknown>)[] = [{ chatFileMB: Math.round(bytes / 1048576), turns: TURNS }]
  try {
    await s.page.waitForTimeout(2000)
    const baseline = await sampleDesktop(s, 'baseline', true)
    samples.push(baseline)
    const t0 = Date.now()
    await s.page.getByText(TITLE).first().click()
    await expect(s.page.getByText(END)).toBeVisible({ timeout: 120_000 })
    const openSeconds = (Date.now() - t0) / 1000
    await s.page.waitForTimeout(1500)
    const opened = await sampleDesktop(s, 'chat open + GC', true)
    samples.push(opened, { openSeconds })
    await leaveChat(s)
    const settled = await settledSample(s, 'left, settled (lowest of 4, 20s)')
    samples.push(settled)

    const b = budget('largeChat')
    const checks: Check[] = [
      { name: 'total added by opening the chat', value: opened.totalMB - baseline.totalMB, limit: b.openTotalGrowthMB, unit: 'MB' },
      { name: 'window heap with the chat open', value: opened.rendererHeapMB, limit: b.openRendererHeapMB, unit: 'MB' },
      { name: 'time to show the end of the chat', value: openSeconds, limit: b.openSeconds, unit: 's' },
      { name: 'total kept after leaving the chat', value: settled.totalMB - baseline.totalMB, limit: b.retainedMB, unit: 'MB' },
      { name: 'window heap kept after leaving the chat', value: settled.rendererHeapMB - baseline.rendererHeapMB, limit: b.rendererRetainedMB, unit: 'MB' }
    ]
    if (checks.some((c) => c.name.startsWith('window heap kept') && c.value > c.limit)) await saveWindowHeap(s, 'large-chat-after-leaving')
    const over = report('large-chat', samples, checks)
    expect(over.map((c) => c.name), 'checks over budget').toEqual([])
  } finally {
    await s.launched.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})
