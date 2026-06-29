import { MAX_PREVIEW_PANES, type PreviewServer } from '@shared/preview'

/**
 * Layout + selection logic for the Preview dock, kept pure so it's unit-tested
 * without a DOM. Given the detected dev servers and any URLs the user added by
 * hand, it decides which panes to render (running servers with a URL first, then
 * manual URLs), dedupes, and caps the count — reporting how many were hidden by
 * the cap so the dock can say so.
 */

export interface PreviewPaneItem {
  /** Stable slot id — keys the React row AND the native WebContentsView. */
  id: string
  url: string
  /** What to show as the row's heading (the server command, or the URL for a manual entry). */
  label: string
  kind: 'server' | 'manual'
}

export interface PreviewSelection {
  /** The panes to render, capped at MAX_PREVIEW_PANES. */
  panes: PreviewPaneItem[]
  /** How many previewable sources were dropped because of the cap. */
  hiddenCount: number
  /** Running servers that have started but not yet revealed a URL (shown as "starting…"). */
  startingCount: number
}

/** Normalize a URL for dedupe/equality (trailing slash + case-insensitive host). */
function canonical(raw: string): string {
  try {
    const u = new URL(raw)
    return u.toString()
  } catch {
    return raw
  }
}

/**
 * True for a URL a loopback preview is allowed to load: http(s) on
 * localhost / 127.0.0.0/8 / 0.0.0.0 / ::1. A client-side mirror of the main
 * process's loopback guard — purely to validate manual input in the UI; main
 * re-validates every URL it actually loads or opens.
 */
export function isLoopbackUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  let h = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (h.endsWith('.')) h = h.slice(0, -1)
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    if (m.slice(1).some((p) => Number(p) > 255)) return false
    if (Number(m[1]) === 127) return true
    if (h === '0.0.0.0') return true
  }
  return false
}

/** Coerce a bare "localhost:3000" / "3000" the user might type into a full URL. */
export function normalizeManualUrl(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  let candidate = text
  if (/^\d+$/.test(text)) candidate = `http://localhost:${text}` // just a port
  else if (!/^https?:\/\//i.test(text)) candidate = `http://${text}` // missing scheme
  return isLoopbackUrl(candidate) ? new URL(candidate).toString() : null
}

/**
 * Choose the panes to render. Running servers with a detected URL come first (in
 * registry order), then manual URLs, deduped by canonical URL. The result is
 * capped at `cap`; anything beyond is counted in `hiddenCount`.
 */
export function selectPreviewPanes(
  servers: PreviewServer[],
  manualUrls: string[],
  cap: number = MAX_PREVIEW_PANES
): PreviewSelection {
  const seen = new Set<string>()
  const all: PreviewPaneItem[] = []

  for (const s of servers) {
    if (!s.running || !s.url) continue
    const key = canonical(s.url)
    if (seen.has(key)) continue
    seen.add(key)
    all.push({ id: `server:${s.id}`, url: s.url, label: s.command, kind: 'server' })
  }

  for (const raw of manualUrls) {
    const key = canonical(raw)
    if (seen.has(key)) continue
    seen.add(key)
    all.push({ id: `manual:${key}`, url: raw, label: raw, kind: 'manual' })
  }

  const startingCount = servers.filter((s) => s.running && !s.url).length
  return {
    panes: all.slice(0, cap),
    hiddenCount: Math.max(0, all.length - cap),
    startingCount
  }
}
