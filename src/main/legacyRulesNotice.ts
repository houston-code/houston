import { join } from 'node:path'
import { writeFileAtomicSync } from './atomic-write'
import { readTextOrNull } from './globalRules'
import { getUserDataDir } from './userData'

/**
 * Whether the one-time "global rules moved" notice has been answered (desktop
 * banner) or printed (terminal), kept in its own small file in the profile instead
 * of settings.json.
 *
 * The desktop app and the terminal app each hold settings.json in an in-memory
 * cache and save the whole object, so a flag one of them writes is erased the next
 * time the other saves any setting. Show-once state can't live there. This file is
 * read fresh on every check and only ever changed here, by merging one key into
 * what is on disk, so neither process can erase the other's record.
 */

const FILE = 'notices.json'

type NoticeKey = 'legacyRulesBannerAnswered' | 'legacyRulesTerminalShown'

function noticesFile(): string {
  return join(getUserDataDir(), FILE)
}

function readNotices(): Partial<Record<NoticeKey, boolean>> {
  const raw = readTextOrNull(noticesFile())
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Partial<Record<NoticeKey, boolean>>)
      : {}
  } catch {
    return {} // unreadable: treat as unanswered (at worst the notice shows again)
  }
}

function markNotice(key: NoticeKey): void {
  const current = readNotices()
  if (current[key] === true) return
  writeFileAtomicSync(noticesFile(), `${JSON.stringify({ ...current, [key]: true }, null, 2)}\n`, 0o600)
}

/** Whether the user already answered the desktop banner (Import it or Keep separate). */
export function isLegacyRulesNoticeDismissed(): boolean {
  return readNotices().legacyRulesBannerAnswered === true
}

/** Record that the desktop banner was answered, so it never shows again. */
export function dismissLegacyRulesNotice(): void {
  markNotice('legacyRulesBannerAnswered')
}

/**
 * Whether the terminal should print its one-time line now, and if so record that it
 * did. Skipped once printed, or once the desktop banner was answered. Recording it
 * leaves the banner's own state alone, so its Import it button stays available.
 * `applies` is only consulted when needed.
 */
export function takeLegacyRulesTerminalNotice(applies: () => boolean): boolean {
  const notices = readNotices()
  if (notices.legacyRulesBannerAnswered === true || notices.legacyRulesTerminalShown === true) return false
  if (!applies()) return false
  markNotice('legacyRulesTerminalShown')
  return true
}
