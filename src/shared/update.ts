import { RELEASE_SUMMARY } from './release-highlights'

/**
 * Update-related types + the bundled release highlights, shared by the main
 * process (which produces them) and the renderer (which renders them).
 *
 * There are two distinct surfaces:
 *  - `UpdateCheckResult` / the `update:available` push event drive the persistent
 *    "an update is available" banner (from the on-launch auto-check and the manual
 *    "Check for updates" button).
 *  - `WhatsNew` drives the small "What's new" popup shown once after the app has
 *    been updated and relaunched.
 */

/**
 * Where every "download the new version" link goes: the website's download section,
 * which picks the right installer for the visitor's OS. Used by the desktop banner,
 * the Settings check, the menu dialog, and the terminal clients' update notice, so
 * nobody is sent to a raw list of release assets to work out which file is theirs.
 * A compile-time constant on purpose: no update payload or cache can redirect it.
 */
export const DOWNLOAD_URL = 'https://houstoncode.ai/#download'

/** Outcome of an update check (manual button or the on-launch auto-check). */
export type UpdateCheckResult =
  | {
      status: 'available'
      currentVersion: string
      latestVersion: string
      /** Download page for the new version ({@link DOWNLOAD_URL}; unsigned builds don't auto-install). */
      releaseUrl: string
      /** Short notes from the update feed, when present. */
      notes?: string
      /**
       * True where this build auto-downloads + installs in place (signed macOS). The
       * banner then shows a progress bar + a "Restart to install" button instead of the
       * manual-download link used on unsigned Windows/Linux.
       */
      autoInstall?: boolean
    }
  | { status: 'up-to-date'; currentVersion: string }
  /** Checking is off: dev/unpackaged build, or HOUSTON_DISABLE_UPDATER=1. */
  | { status: 'disabled'; currentVersion: string }
  | { status: 'error'; currentVersion: string; message: string }

/** Progress of an in-place update download (signed macOS auto-update). */
export interface UpdateDownloadProgress {
  /** 0–100, rounded. */
  percent: number
  /** Current download speed in bytes/second. */
  bytesPerSecond: number
  /** Bytes downloaded so far. */
  transferred: number
  /** Total bytes to download. */
  total: number
}

/** An update finished downloading and is ready to install on restart. */
export interface UpdateDownloaded {
  version: string
}

/** The one-shot payload for the post-restart "What's new" popup. */
export interface WhatsNew {
  version: string
  /** One sentence of at most 120 characters: the release's changelog summary. */
  highlights: string
}

/**
 * The "What's new" text for `version`, or null when there's none. It is the one-sentence
 * summary that opens this build's CHANGELOG.md section, bundled at build time by
 * scripts/gen-release-highlights.mjs, so the popup matches the release notes and works
 * offline and for manually installed builds. Only the running build's summary is bundled,
 * which is all the popup needs: it shows once, right after updating to this version.
 */
export function highlightsFor(version: string): string | null {
  return RELEASE_SUMMARY && RELEASE_SUMMARY.version === version ? RELEASE_SUMMARY.summary : null
}

/**
 * What to tell the user when an update check fails. The raw error (for example Chromium's
 * `net::ERR_NAME_NOT_RESOLVED`) is logged, not shown: it means nothing to most people, and
 * "Couldn't check for updates" already says what happened. A network failure gets a
 * connection hint; anything else (such as a .deb install, which has no update feed) gets
 * no hint, because a connection hint would mislead there.
 */
export function updateErrorHint(message: string | undefined): string | null {
  const network =
    /net::ERR_|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|socket hang up|getaddrinfo/i
  return message && network.test(message) ? 'Check your internet connection and try again.' : null
}
