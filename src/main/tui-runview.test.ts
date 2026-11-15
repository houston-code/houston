import { describe, expect, it } from 'vitest'
import type { ReviewFinding } from '@shared/agent'
import { foldedCall, makePainter, renderFoldedCalls, spinnerFrame } from './tui'
import {
  ReviewTally,
  isHiddenTool,
  renderTurnError,
  toolImagesLine,
  turnModelsLabel
} from './tui-runview'

const paint = makePainter(false)

describe('renderTurnError', () => {
  it('keeps the raw message and adds the shared explanation and next commands', () => {
    expect(renderTurnError('429 Too Many Requests', 'rate-limit', paint).split('\n')).toEqual([
      'Error: 429 Too Many Requests',
      '  The provider is limiting how fast requests can be sent. Wait a minute and retry, or switch to another model.',
      '  next: /retry, /model'
    ])
  })

  it('reads the cause from the message when none was recorded, and always offers retry', () => {
    const out = renderTurnError('fetch failed: ECONNREFUSED', undefined, paint)
    expect(out).toContain("Houston couldn't reach the provider.")
    expect(out).toContain('next: /retry, /doctor')
    expect(renderTurnError('prompt is too long', undefined, paint)).toContain('next: /model, /retry')
  })

  it('falls back to the generic help and strips control characters from the message', () => {
    const out = renderTurnError('weird\x1b]52;c;x\x07', undefined, paint)
    expect(out).not.toContain('\x1b')
    expect(out).toContain('The last turn failed.')
  })
})

describe('toolImagesLine', () => {
  it('counts images, and says nothing for none', () => {
    expect(toolImagesLine(0, paint)).toBeNull()
    expect(toolImagesLine(1, paint)).toBe('  ↳ 1 image returned (not shown in the terminal)')
    expect(toolImagesLine(3, paint)).toContain('3 images')
  })
})

describe('ReviewTally', () => {
  const f = (id: string, severity: ReviewFinding['severity'], status: ReviewFinding['status']): ReviewFinding =>
    ({ id, severity, status, title: id }) as ReviewFinding

  it('tallies the latest status of each finding, once per review call', () => {
    const t = new ReviewTally()
    t.add('r1', f('a', 'low', 'candidate'))
    t.add('r1', f('a', 'low', 'rejected'))
    t.add('r1', f('b', 'critical', 'confirmed'))
    t.add('r2', f('c', 'medium', 'confirmed'))
    expect(t.take('r1', paint)).toBe('  ↳ review: 1 critical (1 dropped as a false positive)')
    expect(t.take('r1', paint)).toBeNull()
    expect(t.take('r2', paint)).toBe('  ↳ review: 1 medium')
  })

  it('says when every finding was dropped, and nothing for a review with none', () => {
    const t = new ReviewTally()
    t.add('r1', f('a', 'high', 'merged'))
    expect(t.take('r1', paint)).toBe('  ↳ review: no confirmed issues (1 merged as a duplicate)')
    expect(t.take('nothing', paint)).toBeNull()
  })
})

describe('turnModelsLabel', () => {
  it('names each model once, in first-use order', () => {
    expect(turnModelsLabel(['a', 'b', 'a', ''])).toBe('a, b')
    expect(turnModelsLabel([])).toBe('')
    expect(turnModelsLabel(['m\x1b[2J'])).not.toContain('\x1b')
  })
})

describe('isHiddenTool', () => {
  it('hides list_dir unless verbose', () => {
    expect(isHiddenTool('list_dir', false)).toBe(true)
    expect(isHiddenTool('list_dir', true)).toBe(false)
    expect(isHiddenTool('read_file', false)).toBe(false)
  })
})

describe('folded reads', () => {
  const read = (path: string) => ({ ...foldedCall('read_file', { path }, true, 'x'), alone: `row ${path}` })

  it('lists the files after the count, cut to the width', () => {
    expect(renderFoldedCalls('Read', [read('a.ts'), read('b.ts')], paint, { width: 80, count: 'files' })).toBe(
      '· Read 2 files  a.ts, b.ts'
    )
    const many = Array.from({ length: 30 }, (_, i) => read(`src/file-${i}.ts`))
    const long = renderFoldedCalls('Read', many, paint, { width: 60, count: 'files' })
    expect(long.length).toBeLessThanOrEqual(60)
    expect(long).toContain('…')
  })

  it('is a sentence in screen-reader mode, with control characters shown inert', () => {
    expect(renderFoldedCalls('Read', [read('a\x1b[2J.ts'), read('b.ts')], paint, { width: 80, sentence: true, count: 'files' })).toBe(
      'Using tool Read: 2 files: a<U+001B>[2J.ts, b.ts'
    )
  })
})

describe('spinnerFrame tokens', () => {
  it('shows the output tokens after the clock, and nothing for zero', () => {
    expect(spinnerFrame(0, 'Responding', 4, paint, { tokens: 1234 })).toContain('Responding 4s · 1.2k tokens')
    expect(spinnerFrame(0, 'Responding', 4, paint, { tokens: 1 })).toContain('4s · 1 token')
    expect(spinnerFrame(0, 'Responding', 4, paint, { tokens: 0 })).not.toContain('token')
  })
})
