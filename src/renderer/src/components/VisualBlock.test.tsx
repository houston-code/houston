import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from './Markdown'
import { VisualsContext } from '../lib/visuals'
import { clearMermaidCache, liveFrameSlots, MAX_LIVE_FRAMES } from '../lib/visuals'

/**
 * Inline visuals in a reply: which fences render, the Rendered/Code toggle, the
 * streaming placeholder, Mermaid results and errors, and the opt-in, sandboxed,
 * capped interactive HTML frames.
 */

const renderMermaid = vi.fn()
const registerHtmlVisual = vi.fn()

beforeEach(() => {
  clearMermaidCache()
  liveFrameSlots.reset()
  renderMermaid.mockReset()
  registerHtmlVisual.mockReset()
  window.api = { renderMermaid, registerHtmlVisual } as unknown as typeof window.api
  document.documentElement.dataset.theme = 'dark'
})

afterEach(() => {
  delete document.documentElement.dataset.theme
})

function md(text: string, { visuals = true, html = false } = {}): ReturnType<typeof render> {
  return render(
    <VisualsContext.Provider value={{ html }}>
      <Markdown text={text} visuals={visuals} />
    </VisualsContext.Provider>
  )
}

describe('svg blocks', () => {
  it('draw as an image, with the source one click away', () => {
    md('```svg\n<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>\n```')
    const img = screen.getByAltText('Image from the reply')
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/)
    fireEvent.click(screen.getByRole('button', { name: 'Code' }))
    expect(screen.queryByAltText('Image from the reply')).not.toBeInTheDocument()
    expect(document.querySelector('.md-codeblock__pre')?.textContent).toContain('rect width')
  })

  it('stay code while the reply is still streaming the block', () => {
    md('```svg\n<svg xmlns="http://www.w3.org/2000/svg">')
    expect(screen.getByText('Rendering when complete')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('stay ordinary code where visuals are off', () => {
    md('```svg\n<svg/>\n```', { visuals: false })
    expect(screen.queryByRole('button', { name: 'Rendered' })).not.toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})

describe('mermaid blocks', () => {
  it('render through the main process in the current color scheme', async () => {
    renderMermaid.mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' })
    md('```mermaid\nflowchart LR\n  A --> B\n```')
    expect(screen.getByText('Rendering diagram…')).toBeInTheDocument()
    expect(await screen.findByAltText('Diagram from the reply')).toBeInTheDocument()
    expect(renderMermaid).toHaveBeenCalledWith('flowchart LR\n  A --> B', 'dark')
  })

  it('show the error and the source when the diagram does not parse', async () => {
    renderMermaid.mockResolvedValue({ error: 'Parse error on line 2' })
    md('```mermaid\nflowchart LR\n  A -->\n```')
    expect(await screen.findByText(/Couldn.t render this diagram/)).toBeInTheDocument()
    expect(screen.getByText('Parse error on line 2')).toBeInTheDocument()
    expect(screen.getByText(/A -->/)).toBeInTheDocument()
  })

  it('render each diagram once, however often the reply re-renders', async () => {
    renderMermaid.mockResolvedValue({ svg: '<svg/>' })
    const text = '```mermaid\nflowchart TD\n  X --> Y\n```'
    const { rerender } = md(text)
    await screen.findByAltText('Diagram from the reply')
    rerender(
      <VisualsContext.Provider value={{ html: false }}>
        <Markdown text={`${text}\n\nMore text.`} visuals />
      </VisualsContext.Provider>
    )
    expect(renderMermaid).toHaveBeenCalledTimes(1)
  })

  it('render again when the theme changes', async () => {
    renderMermaid.mockResolvedValue({ svg: '<svg/>' })
    md('```mermaid\nflowchart TD\n  T --> U\n```')
    await screen.findByAltText('Diagram from the reply')
    await act(async () => {
      document.documentElement.dataset.theme = 'light'
    })
    await waitFor(() => expect(renderMermaid).toHaveBeenLastCalledWith('flowchart TD\n  T --> U', 'light'))
  })
})

describe('mermaid failures', () => {
  it('are not cached, so the next view of the diagram tries again', async () => {
    renderMermaid.mockResolvedValueOnce({ error: 'The diagram took longer than 5 seconds to render.' })
    renderMermaid.mockResolvedValueOnce({ svg: '<svg/>' })
    const text = '```mermaid\nflowchart LR\n  Slow --> Start\n```'
    const first = md(text)
    expect(await screen.findByText(/took longer/)).toBeInTheDocument()
    first.unmount()
    md(text)
    expect(await screen.findByAltText('Diagram from the reply')).toBeInTheDocument()
    expect(renderMermaid).toHaveBeenCalledTimes(2)
  })
})

describe('html visual blocks', () => {
  it('stay code, with a note, while interactive visuals are off', () => {
    md('```html visual\n<p>hi</p>\n```')
    expect(screen.getByText('Interactive visuals are off (Settings, Appearance)')).toBeInTheDocument()
    expect(registerHtmlVisual).not.toHaveBeenCalled()
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('run in a sandboxed frame without same-origin when turned on', async () => {
    registerHtmlVisual.mockResolvedValue('0123456789abcdef0123456789abcdef')
    md('```html visual\n<p>hi</p>\n```', { html: true })
    const frame = await waitFor(() => {
      const f = document.querySelector('iframe')
      if (!f) throw new Error('no frame yet')
      return f
    })
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('src')).toBe('houston-visual://doc/0123456789abcdef0123456789abcdef')
    expect(registerHtmlVisual).toHaveBeenCalledWith('<p>hi</p>')
    expect(screen.getByText('Sandboxed, no network')).toBeInTheDocument()
  })

  it('size the frame from its own document only, within bounds', async () => {
    registerHtmlVisual.mockResolvedValue('0123456789abcdef0123456789abcdef')
    md('```html visual\n<p>hi</p>\n```', { html: true })
    const frame = await waitFor(() => {
      const f = document.querySelector('iframe')
      if (!f) throw new Error('no frame yet')
      return f
    })
    // A message from anywhere else is ignored.
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: { houstonVisual: 'resize', height: 600 }, source: window }))
    })
    expect(frame.style.height).toBe('160px')
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { houstonVisual: 'resize', height: 99999 }, source: frame.contentWindow })
      )
    })
    expect(frame.style.height).toBe('800px')
  })

  it('start on their own once a running visual frees its slot', async () => {
    registerHtmlVisual.mockResolvedValue('0123456789abcdef0123456789abcdef')
    for (let i = 0; i < MAX_LIVE_FRAMES; i++) liveFrameSlots.take(false)
    md('```html visual\n<p>hi</p>\n```', { html: true })
    expect(await screen.findByText('Interactive visual, paused to save resources.')).toBeInTheDocument()
    await act(async () => liveFrameSlots.release())
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull())
  })

  it('wait behind Run once the most allowed are already running', async () => {
    registerHtmlVisual.mockResolvedValue('0123456789abcdef0123456789abcdef')
    for (let i = 0; i < MAX_LIVE_FRAMES; i++) liveFrameSlots.take(false)
    md('```html visual\n<p>hi</p>\n```', { html: true })
    expect(await screen.findByText('Interactive visual, paused to save resources.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull())
  })
})

describe('plain html blocks', () => {
  it('stay code, with a Preview that runs them only when visuals are on', async () => {
    registerHtmlVisual.mockResolvedValue('0123456789abcdef0123456789abcdef')
    const { unmount } = md('```html\n<h1>Page</h1>\n```')
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument()
    unmount()
    md('```html\n<h1>Page</h1>\n```', { html: true })
    expect(document.querySelector('.md-codeblock__pre')?.textContent).toContain('<h1>Page</h1>')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull())
    expect(screen.getByRole('button', { name: 'Hide preview' })).toBeInTheDocument()
  })
})
