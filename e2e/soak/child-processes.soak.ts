import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { startSoakModel, TURN_PROMPT } from './model'
import { soakWorkspace } from './fixtures'
import { allowRunIfAsked, launchSoakApp, useSoakModel, type SoakApp } from './desktop'
import { processesTagged, waitUntil } from './processes'

/** A command that idles for ten minutes, findable in the process table by `tag`. */
const idleCommand = (tag: string): string => `node -e "setTimeout(() => {}, 600000)" ${tag}`

const running = (tag: string): number => processesTagged(tag).length

/** Start a long-lived command in a new integrated terminal and wait until it runs. */
async function startInTerminal(s: SoakApp, tag: string): Promise<void> {
  await s.page.evaluate(async (command) => {
    type Api = { createTerminal(o: object): Promise<string>; writeTerminal(id: string, data: string): Promise<void> }
    const api = (globalThis as unknown as { api: Api }).api
    const id = await api.createTerminal({})
    // Give the shell a moment to print its prompt before typing.
    await new Promise((r) => setTimeout(r, 1000))
    await api.writeTerminal(id, `${command}\r`)
  }, idleCommand(tag))
  expect(await waitUntil(() => running(tag) > 0, 30_000), `terminal command ${tag} started`).toBe(true)
}

/**
 * Processes Houston starts must end with whatever owned them: a terminal's shell with
 * its window (reloaded or closed), and a run's shell command when the run is stopped.
 */
test('terminals and stopped runs leave no processes behind', async () => {
  test.setTimeout(300_000)
  const workspace = soakWorkspace()
  const runTag = `soak-run-${randomBytes(4).toString('hex')}`
  const model = await startSoakModel({
    steps: 1,
    subagentEvery: 0,
    override: () => ({ name: 'run_shell', args: { command: idleCommand(runTag) } })
  })
  const s = await launchSoakApp()
  try {
    await useSoakModel(s, { baseUrl: model.baseUrl, model: model.model, workspace })

    // A run's shell command ends when the run is stopped.
    const composer = s.page.locator('textarea.composer__input')
    await composer.fill(`${TURN_PROMPT} 1: run the long command.`)
    await composer.press('Enter')
    const started = Date.now()
    while (running(runTag) === 0 && Date.now() - started < 60_000) {
      await allowRunIfAsked(s)
      await s.page.waitForTimeout(500)
    }
    expect(running(runTag), 'the run started its command').toBeGreaterThan(0)
    await s.page.getByRole('button', { name: 'Stop' }).click()
    expect(await waitUntil(() => running(runTag) === 0, 15_000), 'the stopped run\'s command ended').toBe(true)

    // A terminal's shell ends when its window reloads.
    const reloadTag = `soak-term-${randomBytes(4).toString('hex')}`
    await startInTerminal(s, reloadTag)
    await s.page.reload()
    await expect(s.page.locator('.app')).toBeVisible()
    expect(await waitUntil(() => running(reloadTag) === 0, 15_000), 'the terminal command ended on reload').toBe(true)

    // ...and when its window closes. On Linux and Windows closing the last window quits
    // the app, and an open terminal makes that ask first ("Quit anyway?"); answer Quit,
    // as the user would, and the quit must take the terminal's command with it.
    const closeTag = `soak-term-${randomBytes(4).toString('hex')}`
    await startInTerminal(s, closeTag)
    if (process.platform !== 'darwin') {
      await s.app.evaluate(({ dialog }) => {
        dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
      })
    }
    await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
    expect(await waitUntil(() => running(closeTag) === 0, 15_000), 'the terminal command ended on window close').toBe(true)
  } finally {
    await s.launched.close()
    await model.close()
    for (const p of processesTagged('soak-run-').concat(processesTagged('soak-term-'))) {
      try {
        process.kill(p.pid)
      } catch {
        /* already gone */
      }
    }
    rmSync(workspace, { recursive: true, force: true })
  }
})
