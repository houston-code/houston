import { createContext, useContext, useEffect, useState } from 'react'

/**
 * Inline visuals: fenced blocks in a reply that render as pictures instead of code.
 *
 *  - ```svg       drawn through an <img>, so its script can't run and it can't load anything
 *  - ```mermaid   rendered to SVG in the main process (never in this renderer), then an <img>
 *  - ```html visual  run in a sandboxed frame with no network, when the user has turned
 *                 interactive visuals on; plain ```html stays code, with a Preview button
 *
 * Every rendered block keeps a Code view one click away.
 */

export type VisualKind = 'svg' | 'mermaid' | 'html-visual' | 'html'

/** Largest SVG drawn as a picture; bigger ones stay code. */
export const MAX_SVG_CHARS = 512 * 1024
/** Largest Mermaid source sent off for rendering. */
export const MAX_MERMAID_CHARS = 50_000
/** Height bounds for an interactive visual's frame, in CSS pixels. */
export const MIN_FRAME_HEIGHT = 80
export const MAX_FRAME_HEIGHT = 800
/** Most interactive visuals running at once; others wait behind "Run". */
export const MAX_LIVE_FRAMES = 3

/** Which visual a fenced block is, by its info string, or null for ordinary code. */
export function visualKind(lang: string, info: string): VisualKind | null {
  const l = lang.toLowerCase()
  if (l === 'svg') return 'svg'
  if (l === 'mermaid') return 'mermaid'
  if (l === 'html') return info.toLowerCase().split(/\s+/).includes('visual') ? 'html-visual' : 'html'
  return null
}

/** An <img>-safe data URL for SVG source (no script runs in an image). */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** Tallest a diagram shows before it scrolls inside its box (Expand lifts the cap). */
export const MAX_DIAGRAM_HEIGHT = 560

export interface SizedSvg {
  svg: string
  /** Natural size in CSS pixels. */
  width: number
  height: number
}

const svgAttr = (tag: string, name: string): string | null =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)?.slice(1).find((v) => v !== undefined) ?? null

/**
 * Give an SVG a fixed natural size. Mermaid draws with `width="100%"` and only a
 * viewBox, which leaves an <img> no intrinsic width, so a two-box diagram stretched
 * across the whole chat. The size comes from the viewBox, or the root's own pixel
 * width and height; null when neither says (the caller shows the SVG as it was).
 */
export function naturalSizeSvg(svg: string): SizedSvg | null {
  const open = /<svg\b[^>]*>/i.exec(svg)
  if (!open) return null
  const tag = open[0]
  const px = (v: string | null): number | null => {
    const m = v && /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/.exec(v)
    return m ? Number(m[1]) : null
  }
  let width = px(svgAttr(tag, 'width'))
  let height = px(svgAttr(tag, 'height'))
  const box = svgAttr(tag, 'viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number)
  if (box?.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
    // One side given in pixels keeps the viewBox's aspect ratio.
    if (width !== null && height === null) height = (width * box[3]) / box[2]
    else if (height !== null && width === null) width = (height * box[2]) / box[3]
    else if (width === null && height === null) [width, height] = [box[2], box[3]]
  }
  if (!width || !height || width <= 0 || height <= 0) return null
  width = Math.ceil(width)
  height = Math.ceil(height)
  const sized = tag
    .replace(/\s(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
    .replace(/^<svg\b/i, `<svg width="${width}" height="${height}"`)
  return { svg: svg.slice(0, open.index) + sized + svg.slice(open.index + tag.length), width, height }
}

/**
 * Smallest a wide diagram shrinks to fit the column. Below this its labels can't be
 * read, so it stays at this scale and scrolls sideways instead.
 */
export const MIN_DIAGRAM_SCALE = 0.6

/**
 * How much a diagram is scaled to show in a column `columnWidth` wide: never up,
 * down to fit, but no further than MIN_DIAGRAM_SCALE. An unknown column (0) counts
 * as wide enough for the natural size.
 */
export function diagramScale(size: { width: number; height: number }, columnWidth: number): number {
  if (columnWidth <= 0) return 1
  return Math.max(MIN_DIAGRAM_SCALE, Math.min(1, columnWidth / size.width))
}

/** Whether a diagram, at the scale it shows in this column, is taller than the cap. */
export function diagramIsTall(size: { width: number; height: number }, columnWidth: number): boolean {
  return size.height * diagramScale(size, columnWidth) > MAX_DIAGRAM_HEIGHT
}

/** Clamp a frame height reported by a visual's document. */
export function clampFrameHeight(h: unknown): number | null {
  if (typeof h !== 'number' || !Number.isFinite(h)) return null
  return Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.ceil(h)))
}

export interface VisualsSettings {
  /** The user turned interactive HTML visuals on (Settings, Appearance). */
  html: boolean
}

export const VisualsContext = createContext<VisualsSettings>({ html: false })

export function useVisualsSettings(): VisualsSettings {
  return useContext(VisualsContext)
}

/** The app's resolved color scheme, tracked live from <html data-theme>. */
export function useColorScheme(): 'light' | 'dark' {
  const read = (): 'light' | 'dark' => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
  const [scheme, setScheme] = useState(read)
  useEffect(() => {
    const obs = new MutationObserver(() => setScheme(read()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return scheme
}

export type MermaidResult = { svg: string } | { error: string }

const MERMAID_CACHE_SIZE = 100
const mermaidCache = new Map<string, Promise<MermaidResult>>()

/**
 * Render a diagram, once per (source, scheme): the transcript re-renders on every
 * streamed delta and on reload, and the same diagram must not round-trip each time.
 */
export function renderMermaidCached(
  source: string,
  scheme: 'light' | 'dark',
  render: (source: string, scheme: 'light' | 'dark') => Promise<MermaidResult> = (s, t) => window.api.renderMermaid(s, t)
): Promise<MermaidResult> {
  const key = `${scheme}\u0000${source}`
  let hit = mermaidCache.get(key)
  if (hit) {
    // Refresh its place so the cache drops the least recently used.
    mermaidCache.delete(key)
    mermaidCache.set(key, hit)
    return hit
  }
  hit = render(source, scheme).catch((e: unknown): MermaidResult => ({ error: String((e as Error)?.message ?? e) }))
  mermaidCache.set(key, hit)
  // Keep only successes: a failure may be transient (a timeout, the renderer still
  // starting), and the next view of the diagram should try again.
  const pending = hit
  void pending.then((r) => {
    if ('error' in r && mermaidCache.get(key) === pending) mermaidCache.delete(key)
  })
  while (mermaidCache.size > MERMAID_CACHE_SIZE) mermaidCache.delete(mermaidCache.keys().next().value!)
  return hit
}

/** Test-only: empty the diagram cache. */
export function clearMermaidCache(): void {
  mermaidCache.clear()
}

/**
 * How many interactive visuals are running, so a long chat doesn't start dozens of
 * frames. A frame takes a slot when it starts and gives it back when it unmounts.
 */
let liveFrames = 0
const waiting = new Set<() => void>()
export const liveFrameSlots = {
  take(force: boolean): boolean {
    if (!force && liveFrames >= MAX_LIVE_FRAMES) return false
    liveFrames++
    return true
  },
  release(): void {
    liveFrames = Math.max(0, liveFrames - 1)
    // Let a frame that was waiting for a slot try again.
    for (const retry of [...waiting]) retry()
  },
  /** Be told when a slot frees up; returns the unsubscribe. */
  onFree(retry: () => void): () => void {
    waiting.add(retry)
    return () => waiting.delete(retry)
  },
  /** Test-only. */
  reset(): void {
    liveFrames = 0
    waiting.clear()
  }
}
