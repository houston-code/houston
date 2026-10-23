import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchApp } from './launch'
import { contentText, startMockProvider, useMockProvider } from './mock-provider'

const MODEL = 'e2e-model'

/**
 * A relaunch lands back in the chat that was open at quit, not in an empty new chat;
 * and when that chat is gone by the next launch, it falls back to the new chat.
 */
test('the chat open at quit reopens on the next launch', async () => {
  test.setTimeout(120_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'houston-e2e-'))
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'houston-e2e-ws-')))
  writeFileSync(join(workspace, 'README.md'), '# reopen fixture\n')

  const mock = await startMockProvider(MODEL, (messages, hasTools) => {
    const text = messages.map((m) => contentText(m.content)).join('\n')
    const alpha = text.includes('alpha')
    // Side requests such as the chat title offer no tools.
    if (!hasTools) return { text: alpha ? 'Alpha chat' : 'Beta chat' }
    return { text: alpha ? 'ALPHA_REPLY' : 'BETA_REPLY' }
  })

  const send = async (page: import('@playwright/test').Page, message: string, reply: string): Promise<void> => {
    const composer = page.locator('textarea.composer__input')
    await expect(composer).toBeEnabled()
    await composer.fill(message)
    await composer.press('Enter')
    await expect(page.locator('.msg', { hasText: reply })).toBeVisible({ timeout: 30_000 })
  }

  try {
    // Launch 1: two chats, then reopen the first one and quit on it.
    const first = await launchApp({ userDataDir })
    try {
      const page = await first.app.firstWindow()
      await expect(page.locator('.app')).toBeVisible()
      await useMockProvider(page, { baseUrl: mock.baseUrl, model: MODEL, workspace })
      await send(page, 'This is the alpha chat.', 'ALPHA_REPLY')
      await page.getByRole('button', { name: 'New chat' }).first().click()
      await send(page, 'This is the other chat.', 'BETA_REPLY')
      await expect(page.locator('.conv')).toHaveCount(2)
      await page.locator('.conv', { hasText: 'Alpha chat' }).click()
      await expect(page.locator('.msg', { hasText: 'ALPHA_REPLY' })).toBeVisible()
    } finally {
      await first.close()
    }

    // Launch 2: the alpha chat is open without a click.
    const second = await launchApp({ userDataDir })
    try {
      const page = await second.app.firstWindow()
      await expect(page.locator('.msg', { hasText: 'ALPHA_REPLY' })).toBeVisible()
      await expect(page.locator('.msg', { hasText: 'BETA_REPLY' })).toHaveCount(0)
      await expect(page.locator('.conv--active', { hasText: 'Alpha chat' })).toBeVisible()
    } finally {
      await second.close()
    }

    // The alpha chat is deleted while the app is closed.
    const convDir = join(userDataDir, 'conversations')
    const alphaFile = readdirSync(convDir)
      .filter((f) => f.endsWith('.json'))
      .find((f) => readFileSync(join(convDir, f), 'utf8').includes('alpha chat'))
    expect(alphaFile, 'the alpha chat is on disk').toBeTruthy()
    rmSync(join(convDir, alphaFile as string))

    // Launch 3: no chat to reopen, so an empty new chat in the same folder.
    const third = await launchApp({ userDataDir })
    try {
      const page = await third.app.firstWindow()
      await expect(page.locator('.welcome h1')).toBeVisible()
      await expect(page.locator('.conv')).toHaveCount(1)
      await expect(page.locator('.conv--active')).toHaveCount(0)
      await expect(page.locator('.msg')).toHaveCount(0)
    } finally {
      await third.close()
    }
  } finally {
    await mock.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})
