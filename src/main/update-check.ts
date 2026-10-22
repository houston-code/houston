import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isNewerVersion } from '@shared/version'
import { DOWNLOAD_URL } from '@shared/update'
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
const LATEST_RELEASE_API = 'https://api.github.com/repos/houston-code/houston/releases/latest'

/** How long a successful check is reused before asking again. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/**
 * How long a failed check (offline, timed out, rate limited) waits before trying again.
 * Much shorter than a day: one slow moment at launch used to silence the notice for 24h.
 */
export const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000
/**
 * Default wait for the feed. A one-shot run only prints the answer if it is in before the
 * run ends, so it gains nothing from waiting longer; an interactive session never blocks
 * on the check and passes a longer timeout.
 */
export const FETCH_TIMEOUT_MS = 3000

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
  /** When the feed last answered. 0 when it never has. */
  checkedAt: number
  latest?: string
  headline?: string
  /** When the last attempt failed, if it did; the answer above is kept through failures. */
  failedAt?: number
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
      ...(typeof c.failedAt === 'number' ? { failedAt: c.failedAt } : {}),
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
  const lines = notes.split('\n').map((l) => stripControlChars(l).trim())
  // Release bodies open with a per-platform Download table (scripts/release-downloads.mjs)
  // and the changelog follows under "## What's changed", so start there when it's present.
  // Headings and table rows are never a headline.
  const changed = lines.findIndex((l) => /^#{1,6}\s+what['\u2019]s changed$/i.test(l))
  const headline = lines.slice(changed + 1).find((l) => l && !l.startsWith('#') && !l.startsWith('|'))
  const short = headline ? shortenHeadline(headline) : ''
  return { latest: tag.replace(/^v/, ''), ...(short ? { headline: short } : {}) }
}

const HEADLINE_MAX = 120

/**
 * Turn a release-notes line into a one-line headline for the terminal: Markdown reduced to
 * plain text, then the first sentence if it fits in HEADLINE_MAX characters, otherwise cut
 * at the last whole word with an ellipsis. A bare slice cut the v0.3.0 intro mid-word.
 */
export function shortenHeadline(line: string): string {
  const text = line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) and images -> text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
  // A sentence ends at . ! or ? followed by whitespace and a capital, digit or quote, so
  // "github.com/x." ends one but "e.g. foo" and "v0.3.0 is" don't.
  const first = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)[0]
  if (first.length <= HEADLINE_MAX) return first
  const cut = text.slice(0, HEADLINE_MAX - 1)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > HEADLINE_MAX / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:]+$/, '')}\u2026`
}

export interface UpdateCheckDeps {
  fetch?: typeof globalThis.fetch
  now?: () => number
  path?: string
  env?: NodeJS.ProcessEnv
  /** How long to wait for the feed; defaults to FETCH_TIMEOUT_MS. */
  timeoutMs?: number
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
  const fromCache = (c: CheckCache): UpdateAvailable | null =>
    c.latest && isNewerVersion(c.latest, currentVersion)
      ? { latest: c.latest, url: DOWNLOAD_URL, ...(c.headline ? { headline: c.headline } : {}) }
      : null
  // Reuse the day's answer rather than asking again on every launch, and after a failure
  // wait an hour rather than retrying on every launch, still reporting what was last known.
  if (
    cached &&
    ((cached.checkedAt > 0 && now() - cached.checkedAt < CHECK_INTERVAL_MS) ||
      (cached.failedAt !== undefined && now() - cached.failedAt < RETRY_AFTER_FAILURE_MS))
  ) {
    return fromCache(cached)
  }

  let release: { latest: string; headline?: string } | null = null
  try {
    const res = await doFetch(LATEST_RELEASE_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `houston/${currentVersion}` },
      signal: AbortSignal.timeout(deps.timeoutMs ?? FETCH_TIMEOUT_MS)
    })
    if (res.ok) release = parseRelease(await res.json())
  } catch {
    // Offline, DNS down, timed out, rate limited: a failed check is a non-event.
  }

  if (!release) {
    // Record the failure so a broken network doesn't retry on every launch, but keep the
    // last answer: an update found yesterday must not vanish because today's check failed.
    writeCache(path, { ...(cached ?? { checkedAt: 0 }), failedAt: now() })
    return cached ? fromCache(cached) : null
  }

  writeCache(path, {
    checkedAt: now(),
    latest: release.latest,
    ...(release.headline ? { headline: release.headline } : {})
  })

  if (!isNewerVersion(release.latest, currentVersion)) return null
  return {
    latest: release.latest,
    url: DOWNLOAD_URL,
    ...(release.headline ? { headline: release.headline } : {})
  }
}

/**
 * Whether a one-shot (`-p`) run may print an update notice. Only to a person at a
 * terminal: never into `--json` output a harness parses, never when stderr is a pipe or
 * a log, and never in CI, where nobody upgrades anything by reading a run's stderr.
 */
export function headlessUpdateNoticeAllowed(json: boolean, stderrIsTTY: boolean, env: NodeJS.ProcessEnv): boolean {
  return !json && stderrIsTTY && !env.CI
}

/** The one stderr line a one-shot run prints after its answer when an update exists. */
export function formatHeadlessUpdateNotice(update: UpdateAvailable, currentVersion: string, hintLine: string): string {
  const hint = hintLine.charAt(0).toUpperCase() + hintLine.slice(1)
  return `houston: update available: ${update.latest} (you have ${currentVersion}). ${hint}\n`
}
