import { describe, expect, it } from 'vitest'
import { MAX_DIAGRAM_HEIGHT, diagramIsTall, naturalSizeSvg } from './visuals'

/** Diagram sizing: an SVG gets its natural pixel size, and tall ones are capped. */

// Mermaid's root element, as it draws a small flowchart.
const MERMAID_ROOT =
  '<svg id="houston-mermaid-0" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 97.5px;" viewBox="0 0 97.5 174" role="graphics-document document">'

describe('naturalSizeSvg', () => {
  it('replaces a percentage width with the viewBox size, rounded up', () => {
    const r = naturalSizeSvg(`${MERMAID_ROOT}<g/></svg>`)
    expect(r).toMatchObject({ width: 98, height: 174 })
    expect(r!.svg).toMatch(/^<svg width="98" height="174" id="houston-mermaid-0" xmlns=/)
    expect(r!.svg).not.toContain('100%')
    expect(r!.svg.endsWith('<g/></svg>')).toBe(true)
  })

  it('keeps pixel width and height the SVG already has', () => {
    expect(naturalSizeSvg('<svg width="300px" height="120" viewBox="0 0 10 10"/>')).toMatchObject({ width: 300, height: 120 })
  })

  it('derives the missing side from the viewBox aspect ratio', () => {
    expect(naturalSizeSvg('<svg width="200" viewBox="0 0 100 50"/>')).toMatchObject({ width: 200, height: 100 })
    expect(naturalSizeSvg("<svg height='40' viewBox='0,0,100,50'/>")).toMatchObject({ width: 80, height: 40 })
  })

  it('touches only the root element', () => {
    const r = naturalSizeSvg('<?xml version="1.0"?><svg viewBox="0 0 10 20"><rect width="5" height="5"/></svg>')
    expect(r!.svg).toBe('<?xml version="1.0"?><svg width="10" height="20" viewBox="0 0 10 20"><rect width="5" height="5"/></svg>')
  })

  it('gives up when nothing says how big it is', () => {
    expect(naturalSizeSvg('<svg width="100%"/>')).toBeNull()
    expect(naturalSizeSvg('<svg viewBox="0 0 0 10"/>')).toBeNull()
    expect(naturalSizeSvg('<svg viewBox="nope"/>')).toBeNull()
    expect(naturalSizeSvg('<div/>')).toBeNull()
  })
})

describe('diagramIsTall', () => {
  it('measures the height at the size it will show: natural, or scaled down to the column', () => {
    expect(diagramIsTall({ width: 100, height: 200 }, 900)).toBe(false)
    expect(diagramIsTall({ width: 100, height: MAX_DIAGRAM_HEIGHT + 1 }, 900)).toBe(true)
    // A wide diagram shrinks to fit, so its height shrinks too.
    expect(diagramIsTall({ width: 2000, height: 1000 }, 800)).toBe(false)
    expect(diagramIsTall({ width: 2000, height: 3000 }, 800)).toBe(true)
  })

  it('assumes the natural size before the column is measured', () => {
    expect(diagramIsTall({ width: 2000, height: 1000 }, 0)).toBe(true)
  })
})
