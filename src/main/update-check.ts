import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isNewerVersion } from '@shared/version'
import { stripControlChars } from './tui-wrap'
import { getUserDataDir } from './userData'
import { log } from './logger'

/**
 * "Is there a newer Houston?" for the terminal clients.
 *
 * The desktop app has electron-updater (updater.ts), but that imports Electron and
 * the standalone CLI has none — so a terminal user had no version indicator, no
 * update check, and no changelog at all. This is the Electron-free counterpart: a
 * plain fetch of the PUBLIC releases feed, which needs no token precisely because
 * distribution lives in a separate public repo.
 *
 * Deliberately timid. It never blocks startup, never throws, checks at most once a
 * day, and stays silent on anything it can't parse. An update nudge that delays
 * your prompt or nags about a version that isn't newer is worse than none.
 */

/** The public releases feed (source repo is private; distribution is not). */
const LATEST_RELEASE_API = 'https://api.github.com/repos/piyushvijay/houston-releases/releases/latest'
export const RELEASES_URL = 'https://github.com/piyushvijay/houston-releases/releases'

/** How long a check result is reused before asking again. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Give up quickly: this races the user's first prompt, and losing is fine. */
const FETCH_TIMEOUT_MS = 3000

export interface UpdateAvailable {
  /** The newest published version. */
  latest: string
  /** Where to get it. */
  url: string
  /** First line of the release notes, when the feed carries any. */
  headline?: string
}

/**
 * Cached between runs so a daily check doesn't become a per-launch network call.
 * Deliberately holds no URL: the link is a compile-time constant, so a tampered
 * cache file cannot point an "update available" banner at an attacker's download.
 */
interface CheckCache {
  checkedAt: number
  latest?: string
  headline?: string
}

function cachePath(): string {
  return join(getUserDataDir(), 'update-check.json')
}

function readCache(path: string): CheckCache | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object') return null
    const c = raw as Record<string, unknown>
    if (typeof c.checkedAt !== 'number') return null
    // Validate each field rather than casting: this file is on disk, and a cached
    // headline is printed to the terminal.
    return {
      checkedAt: c.checkedAt,
      ...(typeof c.latest === 'string' ? { latest: c.latest } : {}),
      ...(typeof c.headline === 'string' ? { headline: stripControlChars(c.headline).slice(0, 120) } : {})
    }
  } catch {
    return null // absent / unreadable / corrupt — just check again
  }
}

function writeCache(path: string, cache: CheckCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(cache), { mode: 0o600 })
  } catch (e) {
    log.warn(`failed to cache the update check: ${String(e)}`)
  }
}

/**
 * Whether the check may run at all. Off for unpackaged/dev builds (a `dev` version
 * can't be compared anyway), and always opt-out-able: some people run this on
 * machines that should make no outbound calls they didn't ask for.
 */
export function updateCheckEnabled(version: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.HOUSTON_DISABLE_UPDATER === '1' || env.HOUSTON_NO_UPDATE_CHECK === '1') return false
  if (env.NO_UPDATE_NOTIFIER) return false // the convention several CLIs share
  return version !== 'dev' && version !== '0.0.0'
}

/**
 * The release feed's shape, narrowed to what we use.
 *
 * The notes are REMOTE text that we print to a terminal with no user action, so
 * they are stripped of control characters: whoever can publish a release note
 * must not thereby be able to write the reader's clipboard (OSC 52) or repaint
 * their scrollback. `latest` needs no such guard — it must survive parseVersion's
 * strict regex to be shown at all.
 */
function parseRelease(body: unknown): { latest: string; headline?: string } | null {
  if (!body || typeof body !== 'object') return null
  const r = body as { tag_name?: unknown; name?: unknown; body?: unknown }
  const tag = typeof r.tag_name === 'string' ? r.tag_name : typeof r.name === 'string' ? r.name : null
  if (!tag) return null
  const notes = typeof r.body === 'string' ? r.body : ''
  const headline = notes
    .split('\n')
    .map((l) => stripControlChars(l).trim())
    .find(Boolean)
  return { latest: tag.replace(/^v/, ''), ...(headline ? { headline: headline.slice(0, 120) } : {}) }
}

export interface UpdateCheckDeps {
  fetch?: typeof globalThis.fetch
  now?: () => number
  path?: string
  env?: NodeJS.ProcessEnv
}

/**
 * Look for a newer release, or return null (no update, disabled, offline, rate
 * limited, unparseable — all the same to the caller: say nothing).
 *
 * Callers must NOT await this before showing the prompt; kick it off and surface
 * the result at a point where writing to the terminal is safe.
 */
export async function checkForUpdate(
  currentVersion: string,
  deps: UpdateCheckDeps = {}
): Promise<UpdateAvailable | null> {
  const env = deps.env ?? process.env
  if (!updateCheckEnabled(currentVersion, env)) return null
  const now = deps.now ?? Date.now
  const path = deps.path ?? cachePath()
  const doFetch = deps.fetch ?? globalThis.fetch

  const cached = readCache(path)
  if (cached && now() - cached.checkedAt < CHECK_INTERVAL_MS) {
    // Reuse the day's answer rather than asking again on every launch.
    return cached.latest && isNewerVersion(cached.latest, currentVersion)
      ? { latest: cached.latest, url: RELEASES_URL, ...(cached.headline ? { headline: cached.headline } : {}) }
      : null
  }

  let release: { latest: string; headline?: string } | null = null
  try {
    const res = await doFetch(LATEST_RELEASE_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `houston/${currentVersion}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (res.ok) release = parseRelease(await res.json())
  } catch {
    // Offline, DNS down, timed out, rate limited: a failed check is a non-event.
  }

  // Record the attempt either way, so a broken network doesn't retry every launch.
  writeCache(path, {
    checkedAt: now(),
    ...(release?.latest ? { latest: release.latest } : {}),
    ...(release?.headline ? { headline: release.headline } : {})
  })

  if (!release || !isNewerVersion(release.latest, currentVersion)) return null
  return {
    latest: release.latest,
    url: RELEASES_URL,
    ...(release.headline ? { headline: release.headline } : {})
  }
}
