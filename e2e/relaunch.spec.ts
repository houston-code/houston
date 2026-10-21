import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchApp } from './launch'
import { contentText, startMockProvider, useMockProvider } from './mock-provider'

const MODEL = 'e2e-model'
// A test-only key for the loopback mock. It never leaves the machine.
const KEY = 'sk-e2e-relaunch-test-key'

/**
 * State written by one launch of the packaged app must be readable by the next: the
 * conversation on disk, and the provider key in the credential store, which is encrypted
 * with the OS keychain through safeStorage. The second turn proves both, since the mock
 * only sees the key and the earlier exchange if the relaunched app restored them.
 */
test('a conversation and its provider key survive a relaunch', async () => {
  test.setTimeout(120_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'houston-e2e-'))
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'houston-e2e-ws-')))
  writeFileSync(join(workspace, 'README.md'), '# relaunch fixture\n')

  const mock = await startMockProvider(MODEL, (messages, hasTools) => {
    // Side requests such as the chat title offer no tools.
    if (!hasTools) return { text: 'Relaunch chat' }
    const users = messages.filter((m) => m.role === 'user').map((m) => contentText(m.content))
    const last = users[users.length - 1] ?? ''
    if (last.includes('second message')) return { text: 'SECOND_REPLY' }
    return { text: 'FIRST_REPLY' }
  })

  try {
    // Launch 1: configure the provider and key, and have one exchange.
    const first = await launchApp({ userDataDir })
    try {
      const page = await first.app.firstWindow()
      await expect(page.locator('.app')).toBeVisible()
      await useMockProvider(page, { baseUrl: mock.baseUrl, model: MODEL, workspace, key: KEY })
      const composer = page.locator('textarea.composer__input')
      await expect(composer).toBeEnabled()
      await composer.fill('This is the first message.')
      await composer.press('Enter')
      await expect(page.locator('.msg', { hasText: 'FIRST_REPLY' })).toBeVisible({ timeout: 30_000 })
    } finally {
      await first.close()
    }
    expect(mock.authorizations[0], 'the key reached the provider on launch 1').toBe(`Bearer ${KEY}`)

    // Launch 2, over the same profile: the chat is listed and reopens with its history.
    const second = await launchApp({ userDataDir })
    try {
      const page = await second.app.firstWindow()
      await expect(page.locator('.app')).toBeVisible()
      const chat = page.locator('.conv')
      await expect(chat).toHaveCount(1)
      await chat.click()
      await expect(page.locator('.msg', { hasText: 'FIRST_REPLY' })).toBeVisible()

      const before = mock.authorizations.length
      const composer = page.locator('textarea.composer__input')
      await expect(composer).toBeEnabled()
      await composer.fill('And now the second message.')
      await composer.press('Enter')
      await expect(page.locator('.msg', { hasText: 'SECOND_REPLY' })).toBeVisible({ timeout: 30_000 })

      // The relaunched app decrypted the stored key and sent the earlier exchange along.
      expect(mock.authorizations.length).toBeGreaterThan(before)
      for (const auth of mock.authorizations.slice(before)) expect(auth).toBe(`Bearer ${KEY}`)
      const sent = mock.lastMessages.map((m) => contentText(m.content)).join('\n')
      expect(sent).toContain('This is the first message.')
      expect(sent).toContain('FIRST_REPLY')
    } finally {
      await second.close()
    }
  } finally {
    await mock.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})
