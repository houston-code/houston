import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DiffView } from './DiffView'
import { diffLines, hunkDiff, type DiffLine } from '@shared/diff'

/**
 * The approval card is where someone decides whether to let a change happen. The
 * terminal has shown a numbered gutter and marked the changed WORDS since the diff
 * rewrite; the desktop app showed neither, so the same edit read as a solid red
 * line and a solid green one and you had to spot the difference by eye.
 *
 * Both clients now render from the same helpers in `@shared/diff`, so these tests
 * are really about the two of them agreeing.
 */

/** The rendered gutter numbers, in order, skipping the blanks. */
function gutter(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.diff__no')].map((n) => n.textContent ?? '').filter(Boolean)
}

describe('DiffView', () => {
  it('numbers the lines it shows', () => {
    const { container } = render(<DiffView diff={diffLines('a\nb\nc', 'a\nB\nc')} />)
    // a=1, then the b→B replacement, then c.
    expect(gutter(container)).toEqual(['1', '2', '2', '3'])
  })

  it('marks only the words that changed inside a modified line', () => {
    const { container } = render(
      <DiffView diff={diffLines('const timeout = 30', 'const timeout = 60')} />
    )
    const marks = [...container.querySelectorAll('.diff__word')].map((m) => m.textContent)
    expect(marks).toEqual(['30', '60'])
    // The unchanged words are still there — marking is emphasis, not a filter.
    expect(container.textContent).toContain('const timeout')
  })

  it('does not invent word marks on a plain insert or delete', () => {
    const { container } = render(<DiffView diff={diffLines('a\nc', 'a\nb\nc')} />)
    // `b` is an addition with no partner: the whole line is the change.
    expect(container.querySelectorAll('.diff__word')).toHaveLength(0)
  })

  // Getting this wrong makes every number after the first fold a lie, which is
  // worse than showing no numbers at all.
  it('keeps numbering correct across a fold', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n')
    const after = before.replace('line25', 'CHANGED')
    const { container } = render(<DiffView diff={hunkDiff(diffLines(before, after), 2)} />)
    const nums = gutter(container)
    // The changed line is #25 in both files, and survives the fold with that number.
    expect(nums).toContain('25')
    expect(container.textContent).toContain('CHANGED')
  })

  it('shows a fold as an aside, not as code', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n')
    const after = before.replace('line25', 'CHANGED')
    const { container } = render(<DiffView diff={hunkDiff(diffLines(before, after), 2)} />)
    const skip = container.querySelector('.diff__line--skip')
    expect(skip).not.toBeNull()
    // A skip has no line number of its own — it stands for many.
    expect(skip?.querySelector('.diff__no')?.textContent).toBe('')
  })

  it('caps a huge diff rather than rendering all of it', () => {
    const big: DiffLine[] = Array.from({ length: 400 }, (_, i) => ({ type: 'add', text: `l${i}` }))
    render(<DiffView diff={big} />)
    expect(screen.getByText(/100 more lines/)).toBeInTheDocument()
  })

  it('renders an empty diff without falling over', () => {
    const { container } = render(<DiffView diff={[]} />)
    expect(container.querySelectorAll('.diff__line')).toHaveLength(0)
  })
})
