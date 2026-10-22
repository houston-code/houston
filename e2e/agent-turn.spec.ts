import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchApp } from './launch'
import { startMockProvider, useMockProvider } from './mock-provider'

const MODEL = 'e2e-model'

/**
 * One full agent turn through the packaged app, against a scripted loopback model.
 * Unit tests cover each piece; this is the only check that they still work together
 * inside the shipped artifact: the provider SDK loading from the asar (whose node_modules
 * electron-builder.yml strips), the bundled rg and ast-grep resolved from Resources/bin,
 * the approval prompt, the OS sandbox spawning a shell under the packaged runtime, and the
 * result streaming back into the transcript.
 */
test('an agent turn runs search, ast-grep and an approved shell command', async () => {
  test.setTimeout(120_000)
  // realpath: macOS tmpdir is a /var symlink to /private/var, and the app canonicalizes
  // workspace paths, so the fixture must be named the way the app will name it.
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'houston-e2e-ws-')))
  writeFileSync(join(workspace, 'needle.js'), "houstonE2eNeedle('found')\n")

  const mock = await startMockProvider(MODEL, [
    { tool: 'search_files', args: { pattern: 'houstonE2eNeedle' } },
    { tool: 'ast_grep', args: { pattern: 'houstonE2eNeedle($A)', lang: 'javascript' } },
    // Arithmetic expansion, so the expected output only appears if a real shell ran it.
    { tool: 'run_shell', args: { command: 'echo SHELL_OK_$((6*7))' } },
    { text: 'E2E turn complete.' }
  ])
  // Shadow rg and ast-grep on PATH with stubs that find nothing. The app prefers its
  // bundled copies, and falls back to PATH only when those are missing, so with the stubs
  // in front a broken bundle shows up as an empty result instead of passing on whatever
  // the machine happens to have installed. (Windows looks for .exe names, which a shell
  // stub can't stand in for; packaged-resources.spec.ts runs the binaries there.)
  const stubs = mkdtempSync(join(tmpdir(), 'houston-e2e-stubs-'))
  for (const name of ['rg', 'ast-grep']) {
    writeFileSync(join(stubs, name), '#!/bin/sh\nexit 1\n')
    chmodSync(join(stubs, name), 0o755)
  }
  const env: Record<string, string> = process.platform === 'win32' ? {} : { PATH: `${stubs}${delimiter}${process.env.PATH ?? ''}` }
  const { app, close } = await launchApp({ env })

  try {
    const page = await app.firstWindow()
    await expect(page.locator('.app')).toBeVisible()

    // 'ask' is the default policy: reads run, the shell command needs a click.
    await useMockProvider(page, { baseUrl: mock.baseUrl, model: MODEL, workspace })

    const composer = page.locator('textarea.composer__input')
    await expect(composer).toBeEnabled()
    await composer.fill('Find the needle and run the shell check.')
    await composer.press('Enter')

    // The two read-only tools run unprompted; the shell command stops for approval.
    const allow = page.getByRole('button', { name: 'Allow', exact: true })
    await expect(allow).toBeVisible({ timeout: 30_000 })
    expect(mock.toolResults, 'only the two reads ran before approval').toHaveLength(2)
    await allow.click()

    await expect(page.getByText('E2E turn complete.')).toBeVisible({ timeout: 30_000 })

    const [search, astGrep, shell] = mock.toolResults
    expect(search, 'search_files result').toContain('needle.js')
    expect(astGrep, 'ast_grep result').toContain('needle.js')
    expect(astGrep, 'ast_grep result').toContain("houstonE2eNeedle('found')")
    expect(shell, 'run_shell result').toContain('SHELL_OK_42')
  } finally {
    await close()
    await mock.close()
    rmSync(workspace, { recursive: true, force: true })
    rmSync(stubs, { recursive: true, force: true })
  }
})
