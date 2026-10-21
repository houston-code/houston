import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('./userData', () => ({ getUserDataDir: () => state.userData }))

import {
  dismissLegacyRulesNotice,
  isLegacyRulesNoticeDismissed,
  takeLegacyRulesTerminalNotice
} from './legacyRulesNotice'

const file = (): string => join(state.userData, 'notices.json')
const onDisk = (): Record<string, unknown> => JSON.parse(readFileSync(file(), 'utf8'))

beforeEach(() => {
  state.userData = mkdtempSync(join(tmpdir(), 'houston-notices-'))
})
afterEach(() => rmSync(state.userData, { recursive: true, force: true }))

describe('legacy rules notice state', () => {
  it('the terminal line prints once and leaves the desktop banner available', () => {
    expect(takeLegacyRulesTerminalNotice(() => true)).toBe(true)
    expect(takeLegacyRulesTerminalNotice(() => true)).toBe(false) // once, ever
    expect(isLegacyRulesNoticeDismissed()).toBe(false) // the Import it offer still shows
  })

  it('skips the terminal line once the desktop banner was answered', () => {
    dismissLegacyRulesNotice()
    const applies = vi.fn(() => true)
    expect(takeLegacyRulesTerminalNotice(applies)).toBe(false)
    expect(applies).not.toHaveBeenCalled()
  })

  it('does not record the terminal line when the notice does not apply', () => {
    expect(takeLegacyRulesTerminalNotice(() => false)).toBe(false)
    expect(takeLegacyRulesTerminalNotice(() => true)).toBe(true) // can still print later
  })

  it('dismissing is idempotent and stored readable only by the user', () => {
    dismissLegacyRulesNotice()
    dismissLegacyRulesNotice()
    expect(isLegacyRulesNoticeDismissed()).toBe(true)
    expect(onDisk()).toEqual({ legacyRulesBannerAnswered: true })
    if (process.platform !== 'win32') expect(statSync(file()).mode & 0o777).toBe(0o600)
  })

  it("sees the other app's record right away and never erases it", () => {
    // The other process (terminal) records its line; this process (desktop) then
    // answers the banner. Each reads the file fresh and merges, so both survive.
    writeFileSync(file(), JSON.stringify({ legacyRulesTerminalShown: true }))
    expect(takeLegacyRulesTerminalNotice(() => true)).toBe(false)
    dismissLegacyRulesNotice()
    expect(onDisk()).toEqual({ legacyRulesTerminalShown: true, legacyRulesBannerAnswered: true })
  })

  it('treats a corrupt file as unanswered and repairs it on the next answer', () => {
    writeFileSync(file(), '{not json')
    expect(isLegacyRulesNoticeDismissed()).toBe(false)
    dismissLegacyRulesNotice()
    expect(onDisk()).toEqual({ legacyRulesBannerAnswered: true })
    writeFileSync(file(), '[1,2]')
    expect(isLegacyRulesNoticeDismissed()).toBe(false)
  })
})
