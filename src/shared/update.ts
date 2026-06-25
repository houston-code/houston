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

/** Outcome of an update check (manual button or the on-launch auto-check). */
export type UpdateCheckResult =
  | {
      status: 'available'
      currentVersion: string
      latestVersion: string
      /** Releases page to download from (we don't auto-install on unsigned builds). */
      releaseUrl: string
      /** Short notes from the update feed, when present. */
      notes?: string
    }
  | { status: 'up-to-date'; currentVersion: string }
  /** Checking is off: dev/unpackaged build, or HOUSTON_DISABLE_UPDATER=1. */
  | { status: 'disabled'; currentVersion: string }
  | { status: 'error'; currentVersion: string; message: string }

/** The one-shot payload for the post-restart "What's new" popup. */
export interface WhatsNew {
  version: string
  /** 1–2 short lines, authored to fit the small popup. */
  highlights: string
}

/**
 * Human-written highlights per shipped version, shown in the post-update
 * "What's new" popup. Bundled in the app (rather than fetched) so the popup is
 * available offline and works for manually-installed DMGs, and so each entry is
 * guaranteed to fit the small popup.
 *
 * Author a new entry — 1–2 short lines — whenever package.json's version bumps.
 */
export const RELEASE_HIGHLIGHTS: Record<string, string> = {
  '0.1.0': 'First public build — a bring-your-own-model coding agent for macOS.'
}

/** Highlights for a specific version, or null when none are recorded. */
export function highlightsFor(version: string): string | null {
  return RELEASE_HIGHLIGHTS[version] ?? null
}
