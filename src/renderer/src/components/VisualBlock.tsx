import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Block } from '@shared/markdown'
import { CodeBlock } from './CodeBlock'
import {
  MAX_DIAGRAM_HEIGHT,
  MAX_MERMAID_CHARS,
  MAX_SVG_CHARS,
  clampFrameHeight,
  diagramIsTall,
  liveFrameSlots,
  naturalSizeSvg,
  renderMermaidCached,
  svgDataUrl,
  useColorScheme,
  useVisualsSettings,
  type MermaidResult,
  type VisualKind
} from '../lib/visuals'

type CodeBlockData = Extract<Block, { type: 'code' }>

/** Rendered / Code switch shown in a visual's bar. */
function ViewToggle({ view, onChange }: { view: 'rendered' | 'code'; onChange: (v: 'rendered' | 'code') => void }): JSX.Element {
  return (
    <span className="md-visual__toggle" role="group" aria-label="View">
      <button type="button" aria-pressed={view === 'rendered'} onClick={() => onChange('rendered')}>
        Rendered
      </button>
      <button type="button" aria-pressed={view === 'code'} onClick={() => onChange('code')}>
        Code
      </button>
    </span>
  )
}

function Note({ children }: { children: string }): JSX.Element {
  return <span className="md-visual__note">{children}</span>
}

/** A Mermaid diagram: rendered off-renderer, shown as an image; on failure, the error and the source. */
function MermaidView({ source, value }: { source: string; value: string }): JSX.Element {
  const scheme = useColorScheme()
  const [result, setResult] = useState<MermaidResult | null>(null)
  useEffect(() => {
    let live = true
    setResult(null)
    void renderMermaidCached(source, scheme).then((r) => {
      if (live) setResult(r)
    })
    return () => {
      live = false
    }
  }, [source, scheme])
  if (!result) return <div className="md-visual md-visual--loading">Rendering diagram…</div>
  if ('error' in result) {
    return (
      <div className="md-visual md-visual--error">
        <div className="md-visual__error" role="note">
          <b>Couldn&apos;t render this diagram.</b> Showing the source instead.
          <pre>{result.error.split('\n').slice(0, 3).join('\n')}</pre>
        </div>
        <pre className="md-codeblock__pre">
          <code>{value}</code>
        </pre>
      </div>
    )
  }
  return <Diagram svg={result.svg} />
}

/**
 * A rendered diagram at its natural size: never wider than it was drawn, scaled down
 * to fit the column, and capped in height (scrolling inside its box) until expanded.
 */
function Diagram({ svg }: { svg: string }): JSX.Element {
  const sized = useMemo(() => naturalSizeSvg(svg), [svg])
  const box = useRef<HTMLDivElement>(null)
  const [columnWidth, setColumnWidth] = useState(0)
  const [expanded, setExpanded] = useState(false)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    // The content box: the image can't use the padding.
    const measure = (): void => {
      const cs = getComputedStyle(el)
      setColumnWidth(el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const obs = new ResizeObserver(measure)
    obs.observe(el)
    return () => obs.disconnect()
  }, [])
  const tall = sized !== null && diagramIsTall(sized, columnWidth)
  const capped = tall && !expanded
  return (
    <div className="md-visual md-visual--diagram-wrap">
      <div
        ref={box}
        className={`md-visual--diagram${capped ? ' md-visual--capped' : ''}`}
        style={capped ? { maxHeight: MAX_DIAGRAM_HEIGHT } : undefined}
        tabIndex={capped ? 0 : undefined}
        aria-label={capped ? 'Diagram, scroll to see all of it' : undefined}
      >
        <img
          src={svgDataUrl(sized?.svg ?? svg)}
          width={sized?.width}
          height={sized?.height}
          alt="Diagram from the reply"
        />
      </div>
      {tall && (
        <button type="button" className="btn btn--sm md-visual__expand" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      )}
    </div>
  )
}

/**
 * An interactive HTML visual in a sandboxed frame: scripts run, but with an opaque
 * origin (no app access), no network, no forms, popups, or navigation. It starts
 * when scrolled into view, and only a few run at once; the rest wait behind "Run".
 */
function HtmlFrame({ html, startNow }: { html: string; startNow: boolean }): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const holdsSlot = useRef(false)
  const [state, setState] = useState<'waiting' | 'paused' | 'running' | 'failed'>('waiting')
  const [docId, setDocId] = useState<string | null>(null)
  const [height, setHeight] = useState(160)

  const start = (force: boolean): void => {
    if (holdsSlot.current) return
    if (!liveFrameSlots.take(force)) {
      setState('paused')
      return
    }
    holdsSlot.current = true
    void window.api.registerHtmlVisual(html).then(
      (id) => {
        if (id) {
          setDocId(id)
          setState('running')
        } else setState('failed')
      },
      () => setState('failed')
    )
  }

  useEffect(() => {
    // Preview was clicked: that's the user asking to run it now.
    if (startNow) {
      start(true)
      return
    }
    const el = box.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      start(false)
      return
    }
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        obs.disconnect()
        start(false)
      }
    })
    obs.observe(el)
    return () => obs.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- start once per mount
  }, [])

  // Waiting for a slot (scrolled into view while the most allowed were running):
  // start as soon as one frees up.
  useEffect(() => {
    if (state !== 'paused' || holdsSlot.current) return
    return liveFrameSlots.onFree(() => start(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- start reads refs and stable setters
  }, [state])

  useEffect(
    () => () => {
      if (holdsSlot.current) {
        holdsSlot.current = false
        liveFrameSlots.release()
      }
    },
    []
  )

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      // Only this frame's own document, and only a height.
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const data = e.data as { houstonVisual?: unknown; height?: unknown } | null
      if (data?.houstonVisual !== 'resize') return
      const h = clampFrameHeight(data.height)
      if (h !== null) setHeight(h)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  return (
    <div className="md-visual md-visual--frame" ref={box}>
      {state === 'running' && docId ? (
        <iframe
          ref={frame}
          className="md-visual__frame"
          title="Interactive visual from the reply"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={`houston-visual://doc/${docId}`}
          style={{ height }}
        />
      ) : state === 'paused' ? (
        <div className="md-visual__placeholder">
          Interactive visual, paused to save resources.
          <button type="button" className="btn btn--sm" onClick={() => start(true)}>
            Run
          </button>
        </div>
      ) : state === 'failed' ? (
        <div className="md-visual__placeholder">This visual couldn&apos;t start. Check that interactive visuals are on in Settings.</div>
      ) : (
        <div className="md-visual__placeholder">Starting…</div>
      )}
    </div>
  )
}

/**
 * A fenced block rendered as a visual (see lib/visuals.ts), with the source a click
 * away. A block still streaming shows as code until its closing fence arrives, so a
 * half-written diagram never flickers through errors.
 */
export function VisualBlock({ kind, block }: { kind: VisualKind; block: CodeBlockData }): JSX.Element {
  const settings = useVisualsSettings()
  const [view, setView] = useState<'rendered' | 'code'>(kind === 'html' ? 'code' : 'rendered')
  const label = kind === 'html-visual' ? 'html visual' : block.lang
  const toggle = <ViewToggle view={view} onChange={setView} />

  if (!block.closed) {
    return <CodeBlock lang={block.lang} value={block.value} label={label} actions={<Note>Rendering when complete</Note>} />
  }

  if (kind === 'html' || kind === 'html-visual') {
    if (!settings.html) {
      return kind === 'html-visual' ? (
        <CodeBlock
          lang="html"
          value={block.value}
          label={label}
          actions={<Note>Interactive visuals are off (Settings, Appearance)</Note>}
        />
      ) : (
        <CodeBlock lang="html" value={block.value} />
      )
    }
    const preview =
      kind === 'html' ? (
        <button
          type="button"
          className="btn btn--sm md-visual__preview"
          aria-pressed={view === 'rendered'}
          onClick={() => setView((v) => (v === 'rendered' ? 'code' : 'rendered'))}
        >
          {view === 'rendered' ? 'Hide preview' : 'Preview'}
        </button>
      ) : (
        <>
          <span className="md-visual__badge">Sandboxed, no network</span>
          {toggle}
        </>
      )
    return (
      <CodeBlock lang="html" value={block.value} label={label} actions={preview}>
        {view === 'rendered' ? <HtmlFrame html={block.value} startNow={kind === 'html'} /> : undefined}
      </CodeBlock>
    )
  }

  if (kind === 'svg' && block.value.length > MAX_SVG_CHARS) {
    return <CodeBlock lang="svg" value={block.value} actions={<Note>Too large to draw</Note>} />
  }
  if (kind === 'mermaid' && block.value.length > MAX_MERMAID_CHARS) {
    return <CodeBlock lang="mermaid" value={block.value} actions={<Note>Too large to draw</Note>} />
  }

  return (
    <CodeBlock lang={block.lang} value={block.value} actions={toggle}>
      {view === 'code' ? undefined : kind === 'svg' ? (
        <div className="md-visual md-visual--figure">
          <img src={svgDataUrl(block.value)} alt="Image from the reply" />
        </div>
      ) : (
        <MermaidView source={block.value} value={block.value} />
      )}
    </CodeBlock>
  )
}
