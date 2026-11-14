import { render } from '@testing-library/react'
import { act, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { diffLines } from '@shared/diff'
import { DiffView } from './DiffView'

// Count the per-line work (syntax colour and changed-word marks) while still doing it.
const calls = vi.hoisted(() => ({ highlight: 0, words: 0 }))
vi.mock('../lib/diffHighlight', async (orig) => {
  const m = await orig<typeof import('../lib/diffHighlight')>()
  return {
    ...m,
    highlightLine: (...args: Parameters<typeof m.highlightLine>) => {
      calls.highlight++
      return m.highlightLine(...args)
    }
  }
})
vi.mock('@shared/diff', async (orig) => {
  const m = await orig<typeof import('@shared/diff')>()
  return {
    ...m,
    wordDiff: (...args: Parameters<typeof m.wordDiff>) => {
      calls.words++
      return m.wordDiff(...args)
    }
  }
})

beforeEach(() => {
  calls.highlight = 0
  calls.words = 0
})

// Every other line changes, so the diff is 15 replacements (a removed line and its
// added one) between unchanged lines: 45 shown lines, 15 word diffs.
const OLD = Array.from({ length: 30 }, (_, i) => `const v${i} = compute(${i}, 'old')`).join('\n')
const NEW = OLD.split('\n')
  .map((l, i) => (i % 2 === 0 ? l.replace("'old'", "'new'") : l))
  .join('\n')

describe('DiffView rows', () => {
  it('are worked out once for a diff, however often its parent renders', () => {
    const diff = diffLines(OLD, NEW)
    let bump: () => void = () => {}
    function Parent(): JSX.Element {
      const [n, setN] = useState(0)
      bump = () => setN((x) => x + 1)
      // What FileSection passes: a fresh `start` object and fresh handlers every render.
      return (
        <div data-n={n}>
          <DiffView
            diff={diff}
            path="a.ts"
            start={{ old: 10, new: 10 }}
            reveal={new Set<string>()}
          />
        </div>
      )
    }
    const { container } = render(<Parent />)
    expect(calls.highlight).toBe(45)
    expect(calls.words).toBe(15)
    const html = container.innerHTML
    for (let i = 0; i < 5; i++) act(() => bump())
    expect(calls).toEqual({ highlight: 45, words: 15 })
    expect(container.innerHTML.replace(/data-n="\d+"/, '')).toBe(html.replace(/data-n="\d+"/, ''))
  })

  it('skip the line work even when the view itself must render again', () => {
    const diff = diffLines(OLD, NEW)
    const { rerender } = render(<DiffView diff={diff} path="a.ts" onLineClick={() => {}} />)
    const first = { ...calls }
    // A new click handler renders the rows again (their buttons call it), not the lines.
    rerender(<DiffView diff={diff} path="a.ts" onLineClick={() => {}} />)
    expect(calls).toEqual(first)
  })

  it('are worked out again for a new diff', () => {
    const { rerender } = render(<DiffView diff={diffLines(OLD, NEW)} path="a.ts" />)
    const first = { ...calls }
    rerender(<DiffView diff={diffLines(OLD, NEW.replace('v3 ', 'w3 '))} path="a.ts" />)
    expect(calls.words).toBeGreaterThan(first.words)
    expect(calls.highlight).toBeGreaterThan(first.highlight)
  })
})
