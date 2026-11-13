import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const shell = vi.hoisted(() => ({
  showItemInFolder: vi.fn(),
  openPath: vi.fn(async () => ''),
  openExternal: vi.fn(async (_url: string) => undefined)
}))
vi.mock('electron', () => ({ shell, app: { getVersion: () => '0.0.0-test', getPath: () => '/tmp' } }))

import { setUserDataDir } from './userData'
import { configureHasKey } from './store'
import { ISSUES_URL, issueReportText, openIssueReport, revealLogs } from './issueReport'

const DIR = mkdtempSync(join(tmpdir(), 'houston-issue-'))
setUserDataDir(DIR)
configureHasKey(() => false)

afterAll(() => rmSync(DIR, { recursive: true, force: true }))

describe('revealLogs', () => {
  beforeEach(() => vi.clearAllMocks())

  it('opens the log folder when nothing has been logged yet', async () => {
    rmSync(join(DIR, 'logs'), { recursive: true, force: true })
    await revealLogs()
    expect(shell.openPath).toHaveBeenCalledWith(join(DIR, 'logs'))
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  it('selects the log file in the file manager once it exists', async () => {
    mkdirSync(join(DIR, 'logs'), { recursive: true })
    writeFileSync(join(DIR, 'logs', 'houston.log'), 'x\n')
    await revealLogs()
    expect(shell.showItemInFolder).toHaveBeenCalledWith(join(DIR, 'logs', 'houston.log'))
  })
})

describe('openIssueReport', () => {
  it('opens the new-issue page with the report text, and no profile path in it', () => {
    vi.clearAllMocks()
    expect(openIssueReport()).toBe(true)
    const url = shell.openExternal.mock.calls[0][0] as string
    expect(url.startsWith(`${ISSUES_URL}?body=`)).toBe(true)
    const body = decodeURIComponent(url.slice(url.indexOf('=') + 1))
    expect(body).toBe(issueReportText())
    expect(body).toContain('### Environment')
    expect(body).not.toContain(DIR)
    expect(url).not.toContain(encodeURIComponent(DIR))
  })
})
